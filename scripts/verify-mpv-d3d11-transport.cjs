const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const library = path.join(root, ".cache/libmpv-d3d11-transport-lib");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function compile() {
  assert.ok(
    fs.existsSync(
      path.join(
        root,
        "third_party/electron-mpv-video/src/main/d3d11-transport.ts",
      ),
    ),
    "Public D3D11 transport has not been implemented",
  );
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "-p",
      "third_party/electron-mpv-video/tsconfig.lib.json",
      "--outDir",
      library,
    ],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  fs.writeFileSync(
    path.join(library, "package.json"),
    JSON.stringify({ private: true, type: "module" }) + "\n",
  );
}

async function unit() {
  compile();
  const traceAnalyzer = path.join(root, "scripts/mpv/compositor-trace.cjs");
  assert.ok(
    fs.existsSync(traceAnalyzer),
    "Passive compositor evidence analyzer is not implemented",
  );
  const { summarizeCompositorTrace } = require(traceAnalyzer);
  const traceOptions = {
    rendererPid: 1,
    startUs: 1000000,
    endUs: 2000000,
    sourceFps: 60,
  };
  const canvas = {
    name: "FrameSequenceTrackerV3",
    ph: "b",
    pid: 1,
    tid: 3,
    ts: 1000000,
    id2: { local: "0x1" },
    args: {
      name: "CanvasAnimation",
      args: {
        data: {
          expected: 60,
          dropped_v3: 0,
          dropped_v4: 0,
          missing_content: 0,
        },
      },
    },
  };
  const traceFixture = [
    canvas,
    {
      name: canvas.name,
      ph: "e",
      pid: 1,
      tid: 3,
      ts: 2000000,
      id2: { local: "0x1" },
      args: {},
    },
    ...Array.from({ length: 60 }, (_, i) => ({
      name: "Display::FrameDisplayed",
      ph: "I",
      pid: 2,
      ts: 1000000 + (i * 1000000) / 60,
      args: {},
    })),
    {
      name: "PipelineReporter",
      ph: "b",
      pid: 1,
      ts: 1000000,
      args: { frame_reporter: { state: "STATE_PRESENTED_ALL" } },
    },
  ];
  assert.equal(
    summarizeCompositorTrace(traceFixture, traceOptions).passed,
    true,
  );
  const unfinished = {
    ...canvas,
    ts: 2000001,
    id2: { local: "0x2" },
    args: { name: "CanvasAnimation" },
  };
  assert.equal(
    summarizeCompositorTrace([...traceFixture, unfinished], traceOptions)
      .passed,
    true,
    "An unfinished trace tail cannot invalidate complete measured evidence",
  );
  assert.equal(
    summarizeCompositorTrace([unfinished], traceOptions).passed,
    false,
    "An unfinished tracker cannot provide evidence",
  );
  assert.equal(summarizeCompositorTrace([], traceOptions).passed, false);
  const droppedTrace = structuredClone(traceFixture);
  droppedTrace[0].args.args.data.dropped_v4 = 2;
  assert.equal(
    summarizeCompositorTrace(droppedTrace, traceOptions).passed,
    false,
  );
  const unsupportedTrace = structuredClone(traceFixture);
  delete unsupportedTrace[0].args.args.data.dropped_v4;
  assert.equal(
    summarizeCompositorTrace(unsupportedTrace, traceOptions).passed,
    false,
  );
  assert.equal(
    summarizeCompositorTrace(
      traceFixture.filter((item) => item.name !== "Display::FrameDisplayed"),
      traceOptions,
    ).passed,
    false,
  );
  assert.equal(
    summarizeCompositorTrace(traceFixture, { ...traceOptions, rendererPid: 99 })
      .passed,
    false,
  );
  const { D3d11Transport } = await import(
    pathToFileURL(path.join(library, "main/d3d11-transport.js"))
  );
  const { GPU_ACK_CHANNEL, GPU_TRANSFER_CHANNEL } = await import(
    pathToFileURL(path.join(library, "shared/gpu-frame.js"))
  );
  const { registerD3d11Receiver } = require(
    path.join(library, "preload/d3d11-receiver.cjs"),
  );
  class Owner extends EventEmitter {
    constructor() {
      super();
      this.mainFrame = {};
      this.sent = [];
    }
    isDestroyed() {
      return false;
    }
    send(channel, packet) {
      this.sent.push({ channel, packet });
    }
  }
  function fixture(watchdogMs = 5000) {
    const owner = new Owner();
    const ipcMain = new EventEmitter();
    const imported = [];
    const released = [];
    const errors = [];
    let ready = true;
    const sharedTexture = {
      subtle: {
        importSharedTexture() {
          const value = {
            tokens: [],
            callbacks: [],
            releaseCalls: 0,
            startTransferSharedTexture() {
              return { opaque: "transfer" };
            },
            setReleaseSyncToken(token) {
              this.tokens.push(token);
            },
            release(callback) {
              this.releaseCalls++;
              this.callbacks.push(callback);
            },
          };
          imported.push(value);
          return value;
        },
      },
    };
    const options = {
      playerId: "test-player",
      owner,
      ipcMain,
      sharedTexture,
      watchdogMs,
      authorize: () => ready,
      releaseNative: async (key) => {
        released.push(key);
        return true;
      },
      onError: (error) => errors.push(error),
    };
    const transport = new D3d11Transport(options);
    const frame = (sequence = 1, generation = 1, slot = 0) => ({
      key: { sequence, generation, slot },
      textureInfo: {
        codedSize: { width: 128, height: 72 },
        pixelFormat: "bgra",
        handle: { ntHandle: Buffer.alloc(8) },
      },
      targetTimeNs: 123456,
      frameFlags: 1,
      renderSubmissionMs: 0.1,
      gpuReadyMs: 0.2,
    });
    const ack = (
      key,
      phase,
      extra = {},
      event = { sender: owner, senderFrame: owner.mainFrame },
    ) =>
      ipcMain.emit(GPU_ACK_CHANNEL, event, {
        playerId: "test-player",
        ...key,
        phase,
        ...extra,
      });
    const finish = async (key, index) => {
      ack(key, "imported", { syncToken: { syncToken: "creation-token" } });
      ack(key, "released");
      imported[index].callbacks.splice(0).forEach((callback) => callback());
      await tick();
    };
    return {
      owner,
      ipcMain,
      imported,
      released,
      errors,
      options,
      transport,
      frame,
      ack,
      finish,
      setReady(value) {
        ready = value;
      },
    };
  }

  const f = fixture();
  const first = f.frame();
  await f.transport.send(first);
  assert.equal(f.owner.sent[0].channel, GPU_TRANSFER_CHANNEL);
  assert.equal(f.owner.sent[0].packet.metadata.sequence, 1);
  assert.equal(f.owner.sent[0].packet.textureInfo, undefined);
  f.ack(first.key, "released");
  assert.equal(
    f.imported[0].releaseCalls,
    0,
    "Release before import is invalid",
  );
  const foreign = { sender: new Owner(), senderFrame: f.owner.mainFrame };
  const iframe = { sender: f.owner, senderFrame: {} };
  for (const event of [foreign, iframe])
    f.ack(first.key, "imported", { syncToken: { syncToken: "token" } }, event);
  assert.doesNotThrow(() =>
    f.ack(
      first.key,
      "imported",
      { syncToken: { syncToken: "token" } },
      {
        sender: f.owner,
        get senderFrame() {
          throw new Error("Render frame disposed");
        },
      },
    ),
  );
  f.setReady(false);
  f.ack(first.key, "imported", { syncToken: { syncToken: "token" } });
  f.setReady(true);
  for (const syncToken of [
    null,
    {},
    { syncToken: "" },
    { syncToken: "x".repeat(10000) },
    { syncToken: "a", extra: 1 },
  ])
    f.ack(first.key, "imported", { syncToken });
  assert.equal(f.imported[0].tokens.length, 0);
  f.ack(first.key, "imported", { syncToken: { syncToken: "valid-token" } });
  f.ack(first.key, "imported", { syncToken: { syncToken: "duplicate" } });
  assert.equal(f.imported[0].tokens.length, 1);
  f.ack(first.key, "released");
  f.ack(first.key, "released");
  assert.equal(f.imported[0].releaseCalls, 1);
  assert.equal(f.released.length, 0, "IPC ack is not GPU completion");
  f.imported[0].callbacks[0]();
  await tick();
  assert.deepEqual(f.released, [first.key]);
  f.imported[0].callbacks[0]();
  await tick();
  assert.deepEqual(
    f.released,
    [first.key],
    "A repeated GPU callback must not release twice",
  );
  await assert.rejects(f.transport.send(first), /stale|sequence/i);
  await f.transport.dispose();
  assert.equal(f.ipcMain.listenerCount(GPU_ACK_CHANNEL), 0);

  const generations = fixture();
  const old = generations.frame(10);
  await generations.transport.send(old);
  generations.transport.invalidate(2);
  const current = generations.frame(11, 2);
  await generations.transport.send(current);
  generations.ack({ ...old.key, sequence: 11 }, "released");
  assert.equal(generations.released.length, 0);
  await generations.finish(old.key, 0);
  assert.deepEqual(generations.released, [old.key]);
  assert.equal(generations.transport.stats().leases, 1);
  await generations.finish(current.key, 1);
  await generations.transport.dispose();

  const six = fixture();
  for (let slot = 0; slot < 3; slot++)
    await six.transport.send(six.frame(100 + slot, 1, slot));
  six.transport.invalidate(2);
  for (let slot = 0; slot < 3; slot++)
    await six.transport.send(six.frame(110 + slot, 2, slot));
  assert.equal(six.transport.stats().leases, 6);
  const anotherOwner = fixture();
  await assert.rejects(
    anotherOwner.transport.send(anotherOwner.frame()),
    /busy|limit/i,
  );
  assert.equal(
    anotherOwner.imported.length,
    0,
    "A new renderer cannot bypass the global quarantine bound",
  );
  await anotherOwner.transport.dispose();
  six.transport.invalidate(3);
  assert.equal(
    six.errors.length,
    0,
    "A newer requested generation must coalesce without allocating textures",
  );
  assert.equal(six.transport.stats().generation, 3);
  await assert.rejects(
    six.transport.send(six.frame(120, 3)),
    (error) => error.code === "GPU_BUSY",
  );
  for (let slot = 0; slot < 3; slot++)
    await six.finish({ sequence: 100 + slot, generation: 1, slot }, slot);
  for (let slot = 0; slot < 3; slot++)
    await six.finish({ sequence: 110 + slot, generation: 2, slot }, slot + 3);
  await six.transport.dispose();

  const bounded = fixture();
  for (let slot = 0; slot < 3; slot++)
    await bounded.transport.send(bounded.frame(20 + slot, 1, slot));
  await assert.rejects(
    bounded.transport.send(bounded.frame(30)),
    /busy|limit/i,
  );
  assert.equal(bounded.imported.length, 3);
  await bounded.transport.dispose();
  assert.equal(
    bounded.released.length,
    0,
    "Dispose must not free unconfirmed GPU leases",
  );
  assert.throws(() => new D3d11Transport(bounded.options), /retired|active/i);
  for (let slot = 0; slot < 3; slot++)
    await bounded.finish({ sequence: 20 + slot, generation: 1, slot }, slot);

  const timeout = fixture(20);
  await timeout.transport.send(timeout.frame());
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(timeout.transport.stats().failed, true);
  assert.equal(timeout.errors[0].code, "GPU_RELEASE_TIMEOUT");
  assert.equal(timeout.released.length, 0);
  await timeout.transport.dispose();
  await timeout.finish(timeout.frame().key, 0);

  const crash = fixture();
  await crash.transport.send(crash.frame());
  crash.owner.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(crash.errors[0].code, "GPU_OWNER_GONE");
  assert.equal(crash.released.length, 0);
  await crash.transport.dispose();
  assert.throws(() => new D3d11Transport(crash.options), /retired|active/i);
  await crash.finish(crash.frame().key, 0);

  const ipcRenderer = new EventEmitter();
  const acks = [];
  ipcRenderer.send = (channel, payload) => acks.push({ channel, payload });
  const importedReceiver = [];
  const sharedTexture = {
    subtle: {
      finishTransferSharedTexture() {
        const value = {
          closed: 0,
          releases: 0,
          callback: null,
          getFrameCreationSyncToken: () => ({ syncToken: "receiver-token" }),
          getVideoFrame() {
            return { close: () => this.closed++ };
          },
          release(callback) {
            this.releases++;
            this.callback = callback;
          },
        };
        importedReceiver.push(value);
        return value;
      },
    },
  };
  const disposeReceiver = registerD3d11Receiver({
    ipcRenderer,
    sharedTexture,
    onFrame: async () => {
      throw new Error("WebGPU callback failed");
    },
  });
  ipcRenderer.emit(
    GPU_TRANSFER_CHANNEL,
    {},
    {
      metadata: {
        playerId: "test-player",
        ...first.key,
        targetTimeNs: 123456,
        frameFlags: 1,
      },
      transfer: { opaque: "transfer" },
    },
  );
  await tick();
  assert.equal(importedReceiver[0].closed, 1);
  assert.equal(importedReceiver[0].releases, 1);
  assert.equal(acks.length, 1, "Released ack waits for the GPU callback");
  importedReceiver[0].callback();
  await tick();
  assert.equal(acks.length, 2);
  assert.equal(acks[1].payload.errorCode, "GPU_FRAME_CALLBACK");
  await disposeReceiver();
  assert.equal(ipcRenderer.listenerCount(GPU_TRANSFER_CHANNEL), 0);
  ipcRenderer.emit(
    GPU_TRANSFER_CHANNEL,
    {},
    {
      metadata: {
        playerId: "test-player",
        ...first.key,
        targetTimeNs: 123456,
        frameFlags: 1,
      },
      transfer: { opaque: "transfer" },
    },
  );
  assert.equal(importedReceiver.length, 1);
  const disposeAgain = registerD3d11Receiver({
    ipcRenderer,
    sharedTexture,
    onFrame: () => {},
  });
  const packet = {
    metadata: {
      playerId: "test-player",
      ...first.key,
      sequence: 100,
      targetTimeNs: 123456,
      frameFlags: 1,
    },
    transfer: { opaque: "once" },
  };
  ipcRenderer.emit(GPU_TRANSFER_CHANNEL, {}, packet);
  await tick();
  importedReceiver[1].callback();
  await tick();
  ipcRenderer.emit(GPU_TRANSFER_CHANNEL, {}, packet);
  await tick();
  assert.equal(
    importedReceiver.length,
    2,
    "A transfer cannot be finished twice after release",
  );
  await disposeAgain();

  const nativeFailure = fixture();
  nativeFailure.options.releaseNative = async () => {
    throw new Error("Native release failed");
  };
  await nativeFailure.transport.send(nativeFailure.frame());
  await nativeFailure.finish(nativeFailure.frame().key, 0);
  assert.equal(nativeFailure.errors[0].code, "GPU_NATIVE_RELEASE");
  assert.equal(
    nativeFailure.transport.stats().leases,
    1,
    "Native release failure must retain quarantine",
  );
  await nativeFailure.transport.dispose();
  const reporterFailure = fixture(20);
  reporterFailure.options.onError = () => {
    throw new Error("Error reporter failed");
  };
  await reporterFailure.transport.send(reporterFailure.frame());
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(reporterFailure.transport.stats().failed, true);
  assert.equal(reporterFailure.transport.stats().leases, 1);
  await reporterFailure.transport.dispose();
  await reporterFailure.finish(reporterFailure.frame().key, 0);
  console.log(
    "D3D11 public transport unit tests passed: ownership, leases, GPU release, quarantine and receiver cleanup",
  );
}

async function main() {
  if (process.argv.includes("--unit")) {
    await unit();
    return;
  }
  compile();
  const option = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1];
  };
  const electron = path.resolve(
    option("--electron", "node_modules/electron/dist/electron.exe"),
  );
  const addon = path.resolve(
    option("--addon", ".cache/libmpv-d3d11-transport-addon/mpv_addon.node"),
  );
  const seconds = Number(option("--seconds", 60));
  const fps = Number(option("--fps", 24));
  const cycles = Number(option("--cycles", 0));
  assert.ok(Number.isInteger(seconds) && seconds > 0 && seconds <= 180);
  assert.ok(fps === 24 || fps === 60);
  assert.ok(Number.isInteger(cycles) && cycles >= 0 && cycles <= 100);
  const mode = cycles ? `${cycles}cycles` : `${fps}fps`;
  const output = path.join(
    root,
    `.cache/libmpv-d3d11-transport-evidence/${Date.now()}-${mode}`,
  );
  const env = {
    ...process.env,
    PATH:
      path.join(root, ".cache/mpv-prototype/sdk") +
      path.delimiter +
      process.env.PATH,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const harness = cycles ? "lifecycle.cjs" : "main.cjs";
  assert.ok(
    fs.existsSync(
      path.join(root, "scripts/mpv/d3d11-transport-harness", harness),
    ),
    "GPU lifecycle harness is not implemented",
  );
  const result = spawnSync(
    electron,
    [
      path.join(root, "scripts/mpv/d3d11-transport-harness", harness),
      "--lib",
      library,
      "--addon",
      addon,
      "--output",
      output,
      "--seconds",
      String(seconds),
      "--fps",
      String(fps),
      "--cycles",
      String(cycles),
      ...(process.argv.includes("--capture-poll") ? ["--capture-poll"] : []),
    ],
    {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: false,
      timeout: cycles ? cycles * 8000 + 60000 : seconds * 1000 + 90000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  console.log(`Evidence: ${output}`);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, "GPU transport integration did not pass");
  const evidence = JSON.parse(
    fs.readFileSync(path.join(output, "evidence.json"), "utf8"),
  );
  assert.equal(evidence.result.errors.length, 0);
  if (cycles) {
    if (cycles >= 50) assert.equal(evidence.result.passed, true);
    assert.equal(evidence.result.completedCycles, cycles);
    assert.equal(evidence.result.callbackFailureReleased, true);
    assert.deepEqual(evidence.result.resourcesAfterClose, {
      textureCount: 0,
      handleCount: 0,
      threadCount: 0,
    });
    return;
  }
  assert.ok(evidence.result.totalGpuPixels > 0);
  if (seconds >= 60) assert.equal(evidence.result.passed, true);
  assert.equal(evidence.result.wrongPixels, 0);
  if (!process.argv.includes("--capture-poll"))
    assert.ok(fs.existsSync(path.join(output, "compositor-trace.json")));
  else
    assert.ok(
      evidence.captures.length > 0,
      "No compositor pixels were inspected",
    );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
