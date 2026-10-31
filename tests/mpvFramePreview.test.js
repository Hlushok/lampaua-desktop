const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { FramePreview } = require("../src/modules/mpv/framePreview");

function setup(options = {}) {
  const workers = [];
  let now = 1000;
  const provider = new FramePreview({
    launch() {
      const child = new EventEmitter();
      child.messages = [];
      child.pid = 12345;
      child.postMessage = (data) => child.messages.push(data);
      child.kill = () => {
        child.killed = true;
        child.emit("exit", 0);
        return true;
      };
      workers.push(child);
      return child;
    },
    now: () => now,
    ...options,
  });
  provider.open(
    "https://example.org/movie",
    ["Referer: https://example.org"],
    "auto",
  );
  return { provider, workers, advance: () => (now += 300) };
}
function frame(seconds = 5) {
  return { width: 4, height: 2, rgba: new Uint8Array(32).fill(64), seconds };
}
test("preview uses the owned source/headers and caches a one-second bucket", async () => {
  const { provider, workers } = setup();
  const result = provider.request(5.4);
  assert.equal(workers.length, 1);
  assert.deepEqual(workers[0].messages[0], {
    source: "https://example.org/movie",
    headers: ["Referer: https://example.org"],
    format: "auto",
    seconds: 5,
  });
  workers[0].emit("message", frame());
  assert.equal((await result).seconds, 5);
  assert.equal(workers[0].killed, undefined);
  assert.equal((await provider.request(5.9)).rgba.byteLength, 32);
  assert.equal(workers.length, 1);
  provider.destroy();
});
test("completed previews reuse one decoder, canceling idle work keeps it warm", async () => {
  const { provider, workers, advance } = setup();
  const first = provider.request(5);
  workers[0].emit("message", frame());
  await first;
  provider.cancel();
  advance();
  const second = provider.request(9);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].messages.length, 2);
  workers[0].emit("message", frame(9));
  assert.equal((await second).seconds, 9);
  assert.equal(workers[0].listenerCount("message"), 0);
  provider.destroy();
  assert.equal(workers[0].killed, true);
});
test("idle decoders expire and source replacement retires even idle workers", async () => {
  const { provider, workers, advance } = setup({ idleMs: 15 });
  const first = provider.request(5);
  workers[0].emit("message", frame());
  await first;
  assert.equal(workers[0].killed, undefined);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(workers[0].killed, true);
  advance();
  const second = provider.request(6);
  workers[1].emit("message", frame(6));
  await second;
  provider.open("https://other.example/new", [], "auto");
  assert.equal(workers[1].killed, true);
  provider.destroy();
});
test("superseded work is killed, stale output is ignored, and nothing is queued", async () => {
  const { provider, workers, advance } = setup();
  const first = provider.request(5);
  advance();
  const second = provider.request(6);
  assert.equal(await first, null);
  assert.equal(workers[0].killed, true);
  workers[0].emit("message", frame());
  workers[1].emit("message", frame(6));
  assert.equal((await second).seconds, 6);
  provider.destroy();
});
test("source changes clear cache, cancel work and never reuse old credentials", async () => {
  const { provider, workers, advance } = setup();
  const first = provider.request(5);
  provider.open("https://other.example/video", [], "hls");
  assert.equal(await first, null);
  advance();
  const second = provider.request(5);
  assert.equal(workers[1].messages[0].source, "https://other.example/video");
  assert.deepEqual(workers[1].messages[0].headers, []);
  provider.cancel();
  assert.equal(await second, null);
  provider.destroy();
  assert.equal(await provider.request(5), null);
});
test("deadline kills a hanging native worker without blocking close", async () => {
  const { provider, workers } = setup({ timeoutMs: 15 });
  assert.equal(await provider.request(5), null);
  assert.equal(workers[0].killed, true);
  provider.destroy();
});
test("cancel before spawn does not send media and retries kill when the process starts", async () => {
  let child,
    kills = 0;
  const { provider } = setup({
    launch() {
      child = new EventEmitter();
      child.messages = [];
      child.postMessage = (data) => child.messages.push(data);
      child.kill = () => {
        kills++;
        if (!child.pid) return false;
        child.emit("exit", 0);
        return true;
      };
      return child;
    },
  });
  const pending = provider.request(5);
  provider.cancel();
  assert.equal(await pending, null);
  assert.deepEqual(
    child.messages,
    [],
    "Canceled media was posted before spawn",
  );
  child.pid = 12346;
  child.emit("spawn");
  assert.ok(kills >= 2);
  assert.equal(provider.workers.size, 0);
  provider.destroy();
});
test("cancel keeps a native watchdog until exit even when kill initially fails", async () => {
  let child,
    kills = 0;
  const { provider } = setup({
    timeoutMs: 10,
    launch() {
      child = new EventEmitter();
      child.postMessage = () => {};
      child.kill = () => {
        kills++;
        return false;
      };
      return child;
    },
  });
  const pending = provider.request(5);
  provider.cancel();
  assert.equal(await pending, null);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(kills >= 2, "Cancel removed the independent native watchdog");
  child.emit("exit", 0);
  provider.destroy();
});
test("a retiring native worker prevents replacement process accumulation", async () => {
  const { provider, workers, advance } = setup();
  const first = provider.request(5);
  workers[0].kill = () => true;
  advance();
  assert.equal(await provider.request(6), null);
  assert.equal(await first, null);
  assert.equal(workers.length, 1);
  workers[0].emit("exit", 0);
  const next = provider.request(6);
  workers[1].emit("message", frame(6));
  assert.equal((await next).seconds, 6);
  provider.destroy();
});
test("preview failure and malformed/oversized output remain time-only", async () => {
  for (const output of [
    null,
    { ...frame(), width: 4096 },
    { ...frame(), rgba: new Uint8Array(1) },
    { ...frame(), seconds: 400 },
  ]) {
    const { provider, workers } = setup();
    const pending = provider.request(5);
    workers[0].emit("message", output);
    assert.equal(await pending, null);
    provider.destroy();
  }
});
test("rapid requests are rate limited and cache is bounded", async () => {
  const { provider, workers, advance } = setup();
  for (let seconds = 0; seconds < 55; seconds++) {
    advance();
    const pending = provider.request(seconds);
    workers.at(-1).emit("message", frame(seconds));
    await pending;
  }
  assert.equal(provider.cache.size, 48);
  assert.equal(await provider.request(100), null);
  assert.equal(workers.length, 1);
  for (const invalid of [-1, NaN, Infinity, "5"]) {
    assert.equal(await provider.request(invalid), null);
  }
  provider.destroy();
});
