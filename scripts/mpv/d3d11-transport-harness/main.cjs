const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  sharedTexture,
} = require("electron");
const { performance } = require("node:perf_hooks");
const fs = require("node:fs");
const path = require("node:path");
const { gunzipSync } = require("node:zlib");
const { pathToFileURL } = require("node:url");
const { summarizeCompositorTrace } = require("../compositor-trace.cjs");
const option = (name) => process.argv[process.argv.indexOf(name) + 1];
const output = path.resolve(option("--output"));
const library = path.resolve(option("--lib"));
const addon = path.resolve(option("--addon"));
const seconds = Number(option("--seconds"));
const fps = Number(option("--fps"));
const trace = !process.argv.includes("--capture-poll");
const config = { width: 3840, height: 2160, fps, seconds };
const reports = [];
const frames = [];
const releases = [];
const acks = [];
const captures = [];
const captureSamples = [];
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let window;
let producer;
let transport;
let capturing = false;
let capturePromise;
let running = false;
let traceFinished;
const traceEvents = [];
const traceNames = new Set([
  "FrameSequenceTrackerV3",
  "PipelineReporter",
  "Display::FrameDisplayed",
  "SubmitCompositorFrameToPresentationCompositorFrame",
  "Graphics.Pipeline",
]);
let rawTraceEvents = 0;
let resolveTrace;
const traceListener = (_event, method, value) => {
  if (method === "Tracing.tracingComplete") resolveTrace(value);
};
async function readTrace(completed) {
  if (completed.dataLossOccurred || !completed.stream)
    throw new Error("Incomplete compositor trace stream");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await window.webContents.debugger.sendCommand("IO.read", {
        handle: completed.stream,
        size: 1048576,
      });
      const bytes = Buffer.from(
        part.data,
        part.base64Encoded ? "base64" : "utf8",
      );
      size += bytes.length;
      if (size > 128 * 1024 * 1024)
        throw new Error("Compressed trace limit exceeded");
      chunks.push(bytes);
      if (part.eof) break;
    }
  } finally {
    await window.webContents.debugger.sendCommand("IO.close", {
      handle: completed.stream,
    });
  }
  const archive = Buffer.concat(chunks);
  fs.writeFileSync(path.join(output, "compositor-trace.json.gz"), archive);
  const data = JSON.parse(
    gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 }),
  );
  if (!Array.isArray(data.traceEvents))
    throw new Error("Missing compositor trace events");
  rawTraceEvents = data.traceEvents.length;
  for (const event of data.traceEvents)
    if (traceNames.has(event.name)) traceEvents.push(event);
  fs.writeFileSync(
    path.join(output, "compositor-trace.json"),
    JSON.stringify({ traceEvents }),
  );
}
app.setPath("userData", path.join(output, "profile"));
app.commandLine.appendSwitch("no-first-run");

function authorized(event) {
  return (
    window &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame
  );
}
function summarize(samples, kind, duration) {
  const ordered = samples.toSorted((a, b) => a.at - b.at);
  const unique = [...new Set(ordered.map((sample) => sample.sequence))];
  const gaps = ordered
    .slice(1)
    .map((sample, index) => sample.at - ordered[index].at);
  return {
    kind,
    count: ordered.length,
    unique: unique.length,
    uniqueFps: unique.length / duration,
    maxGapMs: gaps.length ? Math.max(...gaps) : null,
    reordered: ordered.some(
      (sample, index) => index && sample.sequence < ordered[index - 1].sequence,
    ),
  };
}
async function capturePixels() {
  while (capturing && !window.isDestroyed()) {
    const began = performance.now();
    const image = await window.webContents.capturePage({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    const pixel = image.toBitmap();
    if (pixel.length >= 4) {
      const sequence = pixel[2] | (pixel[1] << 8) | (pixel[0] << 16);
      captureSamples.push({ sequence, began, ended: performance.now() });
      const previous = captures.at(-1);
      if (!previous || previous.sequence !== sequence)
        captures.push({ sequence, at: performance.now() });
    }
    await sleep(0);
  }
}
async function pump(duration, phase) {
  const start = performance.now();
  let index = 0;
  let missed = 0;
  while (performance.now() - start < duration * 1000 && !errors.length) {
    const target = start + (index * 1000) / fps;
    await sleep(Math.max(0, target - performance.now()));
    if (performance.now() - start >= duration * 1000) break;
    const before = performance.now();
    const frame = await producer.nextFrame();
    if (frame) {
      frames.push({
        phase,
        sequence: frame.key.sequence,
        generation: frame.key.generation,
        at: performance.now(),
        targetTimeNs: frame.targetTimeNs,
        nativeWaitMs: performance.now() - before,
        renderSubmissionMs: frame.renderSubmissionMs,
        gpuReadyMs: frame.gpuReadyMs,
      });
      await transport.send(frame);
      frames.at(-1).transferredAt = performance.now();
    } else missed++;
    index++;
    const behind =
      Math.floor(((performance.now() - start) * fps) / 1000) - index;
    if (behind > 1) {
      index += behind;
      missed += behind;
    }
  }
  return { start, end: performance.now(), missed };
}
async function drain() {
  const deadline = performance.now() + 8000;
  while (transport.stats().leases && performance.now() < deadline)
    await sleep(5);
  if (transport.stats().leases) throw new Error("GPU leases did not drain");
}
async function run(info) {
  const { D3d11Transport } = await import(
    pathToFileURL(path.join(library, "main/d3d11-transport.js"))
  );
  const native = require(addon);
  producer = await native.createD3d11TestProducer(config);
  const nativeDevice = producer.stats();
  const bind = (id) =>
    new Promise((resolve) => {
      const listener = (event, value) => {
        if (!authorized(event) || value !== id) return;
        ipcMain.removeListener("gate:bound", listener);
        resolve();
      };
      ipcMain.on("gate:bound", listener);
      window.webContents.send("gate:bind", id);
    });
  await bind("gate-benchmark");
  transport = new D3d11Transport({
    playerId: "gate-benchmark",
    owner: window.webContents,
    ipcMain,
    sharedTexture,
    authorize: authorized,
    releaseNative: async (key) => {
      const gpuSafeAt = performance.now();
      const accepted = await producer.releaseFrame(key);
      releases.push({ ...key, gpuSafeAt, at: performance.now(), accepted });
      return accepted;
    },
    onError: (error) =>
      errors.push({ code: error.code, message: error.message }),
  });
  if (trace) {
    window.webContents.debugger.attach("1.3");
    window.webContents.debugger.on("message", traceListener);
    traceFinished = new Promise((resolve) => {
      resolveTrace = resolve;
    });
    await window.webContents.debugger.sendCommand("Tracing.start", {
      transferMode: "ReturnAsStream",
      streamFormat: "json",
      streamCompression: "gzip",
      traceConfig: {
        recordMode: "recordUntilFull",
        traceBufferSizeInKb: 131072,
        excludedCategories: ["*"],
        includedCategories: [
          "benchmark",
          "disabled-by-default-display.framedisplayed",
          "disabled-by-default-devtools.timeline.frame",
        ],
      },
    });
  }
  // CanvasAnimation counters are emitted in completed ~5-second segments.
  // Record guards on both sides instead of accepting incomplete coverage.
  await pump(trace ? 6 : 3, "warmup");
  await drain();
  if (!reports.some((item) => item.type === "pixel"))
    throw new Error("Renderer did not produce a verified GPU pixel");
  fs.writeFileSync(
    path.join(output, "warmup.png"),
    (await window.webContents.capturePage()).toPNG(),
  );
  if (!trace) {
    capturing = true;
    capturePromise = capturePixels().catch((error) =>
      errors.push({ message: error.message }),
    );
  }
  const measured = await pump(seconds, "measure");
  await drain();
  if (trace) {
    await pump(6, "trace-tail");
    await drain();
  }
  await sleep(50);
  capturing = false;
  await capturePromise;
  if (trace) {
    await window.webContents.debugger.sendCommand("Tracing.end");
    await readTrace(await traceFinished);
    window.webContents.debugger.removeListener("message", traceListener);
    window.webContents.debugger.detach();
  }
  fs.writeFileSync(
    path.join(output, "final.png"),
    (await window.webContents.capturePage()).toPNG(),
  );
  const selected = new Set(
    frames
      .filter((frame) => frame.phase === "measure")
      .map((frame) => frame.sequence),
  );
  const pixels = reports.filter(
    (item) => item.type === "pixel" && selected.has(item.sequence),
  );
  const uniquePixels = new Set(pixels.map((item) => item.decodedSequence));
  const wrongPixels = pixels.filter(
    (item) => item.decodedSequence !== item.sequence % 0x1000000,
  );
  const windows = [];
  for (let offset = 0; offset < seconds; offset += 30) {
    const duration = Math.min(30, seconds - offset);
    const begin = measured.start + offset * 1000;
    const end = begin + duration * 1000;
    const windowFrames = frames.filter(
      (frame) =>
        frame.phase === "measure" && frame.at >= begin && frame.at < end,
    );
    const windowSequences = new Set(
      windowFrames.map((frame) => frame.sequence),
    );
    const displayed = captures.filter((item) =>
      windowSequences.has(item.sequence),
    );
    const pixelSamples = pixels
      .filter((item) => {
        const frame = frames.find((frame) => frame.sequence === item.sequence);
        return frame.at >= begin && frame.at < end;
      })
      .map((item) => ({ sequence: item.decodedSequence, at: item.readbackAt }));
    const compositor = trace
      ? summarizeCompositorTrace(traceEvents, {
          rendererPid: window.webContents.getOSProcessId(),
          sourceFps: fps,
          startUs: windowFrames[0]?.targetTimeNs / 1000,
          endUs: windowFrames[0]?.targetTimeNs / 1000 + duration * 1e6,
        })
      : summarize(displayed, "composited-pixels-not-physical-swap", duration);
    const gpu = summarize(pixelSamples, "webgpu-output-pixels", duration);
    const clockRatio = trace
      ? compositor.clockRatio
      : displayed.length > 1
        ? (windowFrames.at(-1).targetTimeNs - windowFrames[0].targetTimeNs) /
          1e6 /
          (displayed.at(-1).at - displayed[0].at)
        : 0;
    const gapLimit = 3000 / fps + 1000 / info.idleRafFps;
    const rendererSequences = new Set(
      reports
        .filter(
          (item) => item.type === "raf" && windowSequences.has(item.sequence),
        )
        .map((item) => item.sequence),
    );
    windows.push({
      duration,
      gpu,
      compositor,
      gapLimit,
      clockRatio,
      passed:
        gpu.uniqueFps >= fps * 0.98 &&
        Math.max(0, duration * fps - gpu.unique) <= 1 &&
        Math.max(0, duration * fps - rendererSequences.size) <= 1 &&
        !gpu.reordered &&
        (trace
          ? compositor.passed
          : compositor.uniqueFps >= fps * 0.98 &&
            !compositor.reordered &&
            compositor.maxGapMs <= gapLimit &&
            Math.max(0, duration * fps - compositor.unique) <= 1) &&
        clockRatio >= 0.98 &&
        clockRatio <= 1.02,
    });
  }
  const ui = reports.filter(
    (item) =>
      item.type === "ui" &&
      item.mainReceivedAt >= measured.start + 1500 &&
      item.mainReceivedAt < measured.end,
  );
  const uiFps = ui.length
    ? ui.reduce((sum, item) => sum + item.frames, 0) / ui.length
    : null;
  const heartbeatDeadline = performance.now() + 10000;
  const heartbeatBefore = reports.filter(
    (item) => item.type === "heartbeat",
  ).length;
  while (performance.now() < heartbeatDeadline && !errors.length)
    await sleep(100);
  const heartbeats = reports.filter((item) => item.type === "heartbeat");
  const finalStats = producer.stats();
  await transport.dispose();
  await producer.destroy();
  const resourcesAfterClose = native.getD3d11TestResources();
  const result = {
    config,
    info,
    nativeDevice,
    windows,
    measured,
    uiFps,
    trace,
    rawTraceEvents,
    uiRatio: uiFps / info.idleRafFps,
    totalGpuPixels: pixels.length,
    uniqueGpuPixels: uniquePixels.size,
    wrongPixels: wrongPixels.length,
    finalStats,
    ipcHeartbeatsAfterImports: heartbeats.length - heartbeatBefore,
    heartbeatMaxMs: Math.max(0, ...heartbeats.map((item) => item.latencyMs)),
    resourcesAfterClose,
    errors,
    passed:
      seconds >= 60 &&
      !errors.length &&
      !wrongPixels.length &&
      windows.every((item) => item.passed) &&
      uiFps / info.idleRafFps >= 0.9 &&
      heartbeats.length - heartbeatBefore >= 80 &&
      Object.values(resourcesAfterClose).every((value) => value === 0),
  };
  fs.writeFileSync(
    path.join(output, "evidence.json"),
    JSON.stringify(
      { result, frames, acks, releases, captures, captureSamples, reports },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(result, null, 2));
  process.exitCode =
    seconds < 60
      ? errors.length || wrongPixels.length
        ? 1
        : 0
      : result.passed
        ? 0
        : 1;
}

app
  .whenReady()
  .then(async () => {
    fs.mkdirSync(output, { recursive: true });
    window = new BrowserWindow({
      width: 640,
      height: 360,
      useContentSize: true,
      show: true,
      title: "LampaUa D3D11 Transport Test",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        sandbox: false,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        additionalArguments: [`--transport-lib=${library}`],
      },
    });
    const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor;
    const [width, height] = window.getContentSize();
    config.width = Math.min(3840, Math.round(width * scale));
    config.height = Math.min(2160, Math.round(height * scale));
    config.outputSizing = { cssWidth: width, cssHeight: height, dpr: scale };
    ipcMain.handle("gate:config", (event) => {
      if (!authorized(event)) throw new Error("Unauthorized gate");
      return config;
    });
    ipcMain.handle("gate:heartbeat", (event) => {
      if (!authorized(event)) throw new Error("Unauthorized heartbeat");
      return true;
    });
    ipcMain.on("gate:report", (event, value) => {
      if (!authorized(event)) return;
      reports.push({ ...value, mainReceivedAt: performance.now() });
      if (value.type === "error") errors.push({ message: value.message });
    });
    ipcMain.on("electron-mpv-video:v1:gpu:ack", (event, value) => {
      if (authorized(event))
        acks.push({
          sequence: value.sequence,
          generation: value.generation,
          phase: value.phase,
          at: performance.now(),
        });
    });
    ipcMain.handle("gate:ready", (event, info) => {
      if (!authorized(event) || running) return false;
      running = true;
      void run(info)
        .catch((error) => {
          console.error(error);
          fs.writeFileSync(
            path.join(output, "failure.json"),
            JSON.stringify(
              {
                message: error.message,
                reports,
                frames,
                acks,
                releases,
                captures,
                errors,
              },
              null,
              2,
            ),
          );
          process.exitCode = 1;
        })
        .finally(() => app.exit(process.exitCode ?? 0));
      return true;
    });
    await window.loadFile(path.join(__dirname, "index.html"));
    window.show();
    window.focus();
    setTimeout(() => {
      if (!running) {
        console.error(
          JSON.stringify({
            message: "Renderer did not become ready",
            errors,
            reports,
          }),
        );
        app.exit(1);
      }
    }, 15000).unref();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
