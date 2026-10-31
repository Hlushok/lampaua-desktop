class FramePreview {
  constructor({ launch, now = Date.now, timeoutMs = 8000, idleMs = 3000 }) {
    this.launch = launch;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.idleMs = idleMs;
    this.cache = new Map();
    this.lastLaunch = -Infinity;
    this.source = null;
    this.active = null;
    this.workers = new Set();
    this.worker = null;
  }
  open(source, headers, format) {
    this.destroy();
    this.source = source;
    this.headers = [...headers];
    this.format = format;
  }
  cancel() {
    this.active?.finish(null);
  }
  retire(worker) {
    if (this.worker === worker) this.worker = null;
    clearTimeout(worker.idle);
    if (worker.exited) return;
    // Keep the worker quarantined until exit, including failed pre-spawn kills.
    if (!worker.watchdog) {
      worker.watchdog = setTimeout(() => this.kill(worker), this.timeoutMs);
      worker.watchdog.unref?.();
    }
    this.kill(worker);
  }
  kill(worker) {
    try {
      worker.child.kill();
    } catch {
      /* The independent watchdog and spawn listener still own retirement. */
    }
  }
  destroy() {
    this.cancel();
    for (const worker of this.workers) this.retire(worker);
    this.source = null;
    this.cache.clear();
  }
  async request(seconds) {
    if (
      !this.source ||
      typeof seconds !== "number" ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      seconds > Number.MAX_SAFE_INTEGER
    )
      return null;
    const bucket = Math.floor(seconds);
    const copy = (frame) => ({ ...frame, rgba: frame.rgba.slice(0) });
    this.cancel();
    if (this.cache.has(bucket)) return copy(this.cache.get(bucket));
    if (!this.worker && this.workers.size > 0) return null;
    if (this.now() - this.lastLaunch < 250) return null;
    this.lastLaunch = this.now();
    return new Promise((resolve) => {
      let worker, timer, onMessage;
      const job = {
        finish: (value) => {
          if (this.active !== job) return;
          this.active = null;
          clearTimeout(timer);
          if (worker) {
            worker.child.removeListener("message", onMessage);
            worker.job = null;
            if (value) {
              clearTimeout(worker.watchdog);
              worker.watchdog = null;
              worker.idle = setTimeout(() => this.retire(worker), this.idleMs);
              worker.idle.unref?.();
            } else this.retire(worker);
          }
          if (value) {
            while (this.cache.size >= 48)
              this.cache.delete(this.cache.keys().next().value);
            this.cache.set(bucket, value);
          }
          resolve(value ? copy(value) : null);
        },
      };
      this.active = job;
      timer = setTimeout(() => job.finish(null), this.timeoutMs);
      try {
        worker = this.worker;
        if (!worker) {
          worker = { child: this.launch(), job, watchdog: null, idle: null };
          this.worker = worker;
          this.workers.add(worker);
          worker.child.once("exit", () => {
            worker.exited = true;
            clearTimeout(worker.watchdog);
            clearTimeout(worker.idle);
            if (this.worker === worker) this.worker = null;
            worker.job?.finish(null);
            clearTimeout(worker.watchdog);
            this.workers.delete(worker);
          });
          worker.child.once("error", () => {
            if (worker.job) worker.job.finish(null);
            else this.retire(worker);
          });
        }
        worker.job = job;
        clearTimeout(worker.idle);
        worker.watchdog = setTimeout(() => this.kill(worker), this.timeoutMs);
        worker.watchdog.unref?.();
        onMessage = (value) => {
          if (
            !value ||
            !Number.isInteger(value.width) ||
            !Number.isInteger(value.height) ||
            value.width < 1 ||
            value.width > 320 ||
            value.height < 1 ||
            value.height > 180 ||
            !Number.isFinite(value.seconds) ||
            Math.abs(value.seconds - bucket) > 2 ||
            !ArrayBuffer.isView(value.rgba) ||
            value.rgba.byteLength !== value.width * value.height * 4
          ) {
            job.finish(null);
            return;
          }
          const bytes = Buffer.from(
            value.rgba.buffer,
            value.rgba.byteOffset,
            value.rgba.byteLength,
          );
          job.finish({
            width: value.width,
            height: value.height,
            seconds: value.seconds,
            rgba: Uint8Array.from(bytes).buffer,
          });
        };
        worker.child.once("message", onMessage);
        const start = () => {
          if (this.active !== job) {
            this.kill(worker);
            return;
          }
          try {
            worker.child.postMessage({
              source: this.source,
              headers: this.headers,
              format: this.format,
              seconds: bucket,
            });
          } catch {
            job.finish(null);
          }
        };
        if (worker.child.pid) start();
        else worker.child.once("spawn", start);
      } catch {
        job.finish(null);
      }
    });
  }
}
module.exports = { FramePreview };
