const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const output = path.join(root, ".cache/libmpv-d3d11-integration-lib");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const defer = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const gpuFrame = (generation = 1, sequence = 1) => ({
  key: { slot: 0, generation, sequence },
  textureInfo: {
    handle: { ntHandle: Buffer.alloc(8) },
    pixelFormat: "bgra",
    codedSize: { width: 2, height: 2 },
  },
  targetTimeNs: 0,
  frameFlags: 1,
  renderSubmissionMs: 0,
  gpuReadyMs: 0,
});

async function main() {
  assert.doesNotMatch(
    fs.readFileSync(
      path.join(
        root,
        "third_party/electron-mpv-video/native/mpv-addon/src/mpv_addon.cc",
      ),
      "utf8",
    ),
    /\bmpv_(?:wait_async_requests|get_property)\s*\(/,
    "Retirement must have a deadline and consume its own command replies",
  );
  if (!process.argv.includes("--child")) {
    for (const [args, message] of [
      [["--release", "--d3d11"], /forbidden/],
      [["--d3d11"], /requires --candidate-sdk/],
      [["--candidate-sdk", "unused"], /requires --d3d11/],
      [["--release", "--d3d11-next", "--candidate-sdk", "unused"], /forbidden/],
      [
        ["--d3d11-next", "--candidate-sdk", "--stage-only"],
        /requires --candidate-sdk/,
      ],
      [
        ["--d3d11", "--d3d11-next", "--candidate-sdk", "unused"],
        /Select one D3D11 candidate/,
      ],
    ]) {
      const invalid = spawnSync(
        process.execPath,
        [path.join(root, "scripts/build-win-mpv-test.cjs"), ...args],
        { encoding: "utf8", windowsHide: true },
      );
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, message);
    }
    const result = spawnSync(
      process.execPath,
      ["--experimental-vm-modules", __filename, "--child"],
      { stdio: "inherit", windowsHide: true },
    );
    assert.equal(result.status, 0);
    return;
  }
  const compiled = spawnSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "-p",
      "third_party/electron-mpv-video/tsconfig.lib.json",
      "--outDir",
      output,
    ],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const handlers = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (name, callback) => handlers.set(name, callback);
  ipcMain.removeHandler = (name) => handlers.delete(name);
  const instances = [];
  const sent = [];
  let initGate;
  let initError;
  class Native {
    constructor(options = {}) {
      this.mode = options.mode;
      this.calls = [];
      this.events = [];
      this.frames = [];
      instances.push(this);
    }
    open(...args) {
      this.calls.push(["open", ...args]);
      this.events.push(
        { type: "file-loaded" },
        {
          type: "property-change",
          name: "track-list",
          data: [
            { id: 2, type: "audio" },
            { id: 3, type: "sub" },
          ],
        },
      );
    }
    play() {
      this.calls.push(["play"]);
    }
    pause() {
      this.calls.push(["pause"]);
    }
    stop() {
      this.calls.push(["stop"]);
    }
    seek(value) {
      this.calls.push(["seek", value]);
    }
    setVolume(value) {
      this.calls.push(["volume", value]);
    }
    setSpeed(value) {
      this.calls.push(["speed", value]);
    }
    setAudioTrack(value) {
      this.calls.push(["audio", value]);
    }
    setSubtitleTrack(value) {
      this.calls.push(["sub", value]);
    }
    setEventCallback(callback) {
      this.eventCallback = callback;
    }
    setUpdateCallback(callback) {
      this.updateCallback = callback;
    }
    pollEvents() {
      return this.events.splice(0);
    }
    async renderFrame() {
      return { width: 2, height: 2, rgba: Buffer.alloc(16) };
    }
    async renderD3d11Frame(...args) {
      this.calls.push(["render", ...args]);
      const frame = this.frames.shift();
      if (frame instanceof Error) throw frame;
      return frame ?? null;
    }
    async releaseD3d11Frame(key) {
      this.calls.push(["release", key]);
      return true;
    }
    async retireD3d11Playback() {
      this.calls.push(["retire-playback"]);
    }
    async destroy() {
      this.calls.push(["destroy"]);
    }
  }
  const native = {
    MpvPlayer: Native,
    createD3d11Player: async () => {
      if (initError) throw initError;
      if (initGate) await initGate.promise;
      return new Native({ mode: "d3d11" });
    },
  };
  const context = vm.createContext({
    console,
    Buffer,
    URL,
    process,
    queueMicrotask,
    setTimeout,
    clearTimeout,
  });
  let gpuRelease;
  let importedToken;
  const sharedTexture = {
    subtle: {
      importSharedTexture: () => ({
        startTransferSharedTexture: () => ({}),
        setReleaseSyncToken: (token) => {
          importedToken = token;
        },
        release: (callback) => {
          gpuRelease = callback;
        },
      }),
    },
  };
  const modules = new Map();
  const synthetic = (name, values) =>
    new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [key, value] of Object.entries(values))
          this.setExport(key, value);
      },
      { context, identifier: name },
    );
  async function load(filename) {
    if (modules.has(filename)) return modules.get(filename);
    const mod = new vm.SourceTextModule(fs.readFileSync(filename, "utf8"), {
      context,
      identifier: filename,
      initializeImportMeta(meta) {
        meta.url = pathToFileURL(filename).href;
      },
    });
    modules.set(filename, mod);
    await mod.link(async (name) => {
      if (name === "electron")
        return synthetic(name, { ipcMain, sharedTexture });
      if (name === "node:module")
        return synthetic(name, { createRequire: () => () => native });
      if (name.startsWith("."))
        return load(path.resolve(path.dirname(filename), name));
      return synthetic(name, await import(name));
    });
    return mod;
  }
  const mod = await load(path.join(output, "main/mpv-service.js"));
  await mod.evaluate();
  let nextOwner = 100;
  function windowFor(service) {
    const window = new EventEmitter();
    window.webContents = new EventEmitter();
    Object.assign(window.webContents, {
      id: nextOwner++,
      mainFrame: {},
      isDestroyed: () => false,
      send: (name, value) => sent.push([name, value]),
    });
    window.isDestroyed = () => false;
    service.attachWindow(window);
    window.webContents.emit("did-finish-load");
    return window;
  }
  const authorize = (event) => event.senderFrame === event.sender.mainFrame;
  const eventFor = (window) => ({
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  });
  const call = (name, event, ...args) => {
    const handler = handlers.get(`electron-mpv-video:v1:player:${name}`);
    assert.equal(
      typeof handler,
      "function",
      `Missing player:${name} IPC handler`,
    );
    return handler(event, ...args);
  };
  let service = mod.namespace.createMpvMain({
    addonPath: "fixture",
    authorize,
  });
  let window = windowFor(service);
  let event = eventFor(window);
  try {
    const capabilities = await call("capabilities", event);
    assert.equal(capabilities.defaultRenderMode, "webgl");
    assert.equal(capabilities.supportsD3d11, false);
    await assert.rejects(
      call("capabilities", { ...event, senderFrame: {} }),
      /authoriz|frame/i,
    );
    await assert.rejects(
      call("create", event, { pipeline: "d3d11" }),
      /D3D11|unavailable/i,
    );
  } finally {
    await service.dispose();
  }

  service = mod.namespace.createMpvMain({
    addonPath: "fixture",
    authorize,
    preferredPipeline: "d3d11",
  });
  window = windowFor(service);
  event = eventFor(window);
  try {
    const capabilities = await call("capabilities", event);
    assert.equal(capabilities.supportsD3d11, true);
    assert.equal(capabilities.defaultRenderMode, "d3d11");
    initGate = defer();
    const creating = call("create", event, { pipeline: "d3d11" });
    await tick();
    await assert.rejects(
      call("create", event, { pipeline: "d3d11" }),
      /active|session|pending/i,
    );
    window.webContents.emit(
      "did-start-navigation",
      {},
      "https://kinohub.uk/",
      false,
      true,
    );
    window.webContents.emit("did-finish-load");
    await assert.rejects(
      call("create", event, { pipeline: "d3d11" }),
      /active|session|pending/i,
    );
    initGate.resolve();
    await assert.rejects(creating, /cancel|navigat|destroy/i);
    assert.equal(
      instances.at(-1).calls.filter(([name]) => name === "destroy").length,
      1,
    );
    initGate = null;
    const result = await call("create", event, { pipeline: "d3d11" });
    assert.equal(typeof result.id, "string");
    assert.equal(result.actualPipeline, "d3d11");
    const close = call("destroy", event, result.id);
    await call("destroy", event, result.id);
    await close;
  } finally {
    initGate?.resolve();
    initGate = null;
    await service.dispose();
  }

  service = mod.namespace.createMpvMain({
    addonPath: "fixture",
    authorize,
    preferredPipeline: "d3d11",
  });
  window = windowFor(service);
  event = eventFor(window);
  try {
    initError = new Error("fixture GPU init failed");
    const result = await call("create", event, { pipeline: "d3d11" });
    assert.equal(result.actualPipeline, "software");
    assert.equal(instances.at(-1).mode, "software");
    await call("destroy", event, result.id);
  } finally {
    initError = null;
    await service.dispose();
  }

  service = mod.namespace.createMpvMain({
    addonPath: "fixture",
    authorize,
    preferredPipeline: "d3d11",
  });
  window = windowFor(service);
  event = eventFor(window);
  try {
    const result = await call("create", event, { pipeline: "d3d11" });
    const player = instances.at(-1);
    player.frames.push(gpuFrame());
    player.updateCallback();
    await tick();
    const packet = sent.find(([name]) => name.endsWith(":gpu:transfer"))?.[1];
    assert.ok(
      packet,
      "Native D3D11 frame did not reach the public GPU transport",
    );
    const ack = {
      ...packet.metadata,
      phase: "imported",
      syncToken: { syncToken: "fixture" },
    };
    delete ack.targetTimeNs;
    delete ack.frameFlags;
    ipcMain.emit(
      "electron-mpv-video:v1:gpu:ack",
      { ...event, senderFrame: {} },
      ack,
    );
    assert.equal(importedToken, undefined, "Iframe ack was accepted");
    ipcMain.emit("electron-mpv-video:v1:gpu:ack", event, ack);
    assert.equal(importedToken.syncToken, "fixture");
    await call("destroy", event, result.id);
    assert.equal(
      player.calls.filter(([name]) => name === "retire-playback").length,
      1,
      "Retirement did not stop playback independently of the event pump",
    );
    assert.equal(
      player.calls.some(([name]) => name === "destroy"),
      false,
      "UI close destroyed an unconfirmed GPU lease",
    );
    const replacement = await call("create", event, { pipeline: "d3d11" });
    assert.equal(
      replacement.actualPipeline,
      "software",
      "Retired GPU owner was reused",
    );
    const released = { ...ack, phase: "released" };
    delete released.syncToken;
    ipcMain.emit("electron-mpv-video:v1:gpu:ack", event, released);
    assert.equal(typeof gpuRelease, "function");
    assert.equal(
      player.calls.some(([name]) => name === "release"),
      false,
      "Native release preceded GPU completion",
    );
    gpuRelease();
    await tick();
    assert.equal(player.calls.filter(([name]) => name === "release").length, 1);
    assert.equal(player.calls.filter(([name]) => name === "destroy").length, 1);
    await call("destroy", event, replacement.id);
  } finally {
    await service.dispose();
  }
  for (const cancellation of ["seek", "destroy"]) {
    service = mod.namespace.createMpvMain({
      addonPath: "fixture",
      authorize,
      preferredPipeline: "d3d11",
    });
    window = windowFor(service);
    event = eventFor(window);
    const gate = defer();
    try {
      const result = await call("create", event, { pipeline: "d3d11" });
      const player = instances.at(-1);
      player.frames.push(gate.promise);
      const sentBefore = sent.filter(([name]) =>
        name.endsWith(":gpu:transfer"),
      ).length;
      player.updateCallback();
      await tick();
      let closing;
      if (cancellation === "seek") await call("seek", event, result.id, 12);
      else closing = call("destroy", event, result.id);
      gate.resolve(gpuFrame());
      await tick();
      await closing;
      assert.equal(
        sent.filter(([name]) => name.endsWith(":gpu:transfer")).length,
        sentBefore,
        `A frame completed after ${cancellation} reached the renderer`,
      );
      assert.equal(
        player.calls.filter(([name]) => name === "release").length,
        1,
      );
      if (cancellation === "seek") await call("destroy", event, result.id);
      else await assert.rejects(call("destroy", event, result.id), /unknown/i);
      assert.equal(
        player.calls.filter(([name]) => name === "destroy").length,
        1,
      );
    } finally {
      gate.resolve(null);
      await service.dispose();
    }
  }
  for (const cancellation of ["render-process-gone", "detach", "dispose"]) {
    service = mod.namespace.createMpvMain({
      addonPath: "fixture",
      authorize,
      preferredPipeline: "d3d11",
    });
    window = windowFor(service);
    event = eventFor(window);
    initGate = defer();
    try {
      const creating = call("create", event, { pipeline: "d3d11" });
      await tick();
      if (cancellation === "detach") await service.detachWindow(window);
      else if (cancellation === "dispose") await service.dispose();
      else window.webContents.emit(cancellation);
      initGate.resolve();
      await assert.rejects(creating, /cancel|navigat|destroy/i);
      assert.equal(
        instances.at(-1).calls.filter(([name]) => name === "destroy").length,
        1,
      );
    } finally {
      initGate.resolve();
      initGate = null;
      await service.dispose();
    }
  }
  service = mod.namespace.createMpvMain({
    addonPath: "fixture",
    authorize,
    preferredPipeline: "d3d11",
  });
  window = windowFor(service);
  event = eventFor(window);
  try {
    for (let cycle = 0; cycle < 50; cycle++) {
      const result = await call("create", event, { pipeline: "d3d11" });
      const player = instances.at(-1);
      await call("set-render-size", event, result.id, {
        width: 640 + cycle,
        height: 360,
      });
      await call("seek", event, result.id, cycle);
      const closing = call("destroy", event, result.id);
      await call("destroy", event, result.id);
      await closing;
      assert.equal(
        player.calls.filter(([name]) => name === "destroy").length,
        1,
      );
    }
    const result = await call("create", event, { pipeline: "d3d11" });
    const player = instances.at(-1);
    window.webContents.emit("render-process-gone");
    await tick();
    assert.equal(player.calls.filter(([name]) => name === "destroy").length, 1);
    await assert.rejects(call("create", event), /ready|load|attach/i);
    window.webContents.emit("did-finish-load");
    await assert.rejects(call("destroy", event, result.id), /unknown/i);
  } finally {
    await service.dispose();
  }
  service = mod.namespace.createMpvMain({
    addonPath: "fixture",
    authorize,
    preferredPipeline: "d3d11",
  });
  window = windowFor(service);
  event = eventFor(window);
  try {
    const result = await call("create", event, { pipeline: "d3d11" });
    const original = instances.at(-1);
    await call("set-render-size", event, result.id, {
      width: 700,
      height: 400,
    });
    await tick();
    const oldGeneration = original.calls
      .filter(([name]) => name === "render")
      .at(-1)[3];
    await call("set-render-pipeline", event, result.id, "software");
    await call("set-render-pipeline", event, result.id, "d3d11");
    await tick();
    const replacement = instances.at(-1);
    const nextGeneration = replacement.calls
      .filter(([name]) => name === "render")
      .at(-1)[3];
    assert.ok(
      nextGeneration > oldGeneration,
      "D3D11 round trip reset the receiver generation floor",
    );
    await call("destroy", event, result.id);
  } finally {
    await service.dispose();
  }
  for (const [live, paused, format] of [
    [false, false, "mov,mp4,m4a,3gp,3g2,mj2"],
    [true, false, "hls"],
    [false, true, "matroska,webm"],
    [true, false, "hls-masked"],
    [true, false, null],
  ]) {
    service = mod.namespace.createMpvMain({
      addonPath: "fixture",
      authorize,
      preferredPipeline: "d3d11",
    });
    window = windowFor(service);
    event = eventFor(window);
    try {
      const result = await call("create", event, { pipeline: "d3d11" });
      const original = instances.at(-1);
      const source = `https://fixture.test/${format === "hls" ? "live.m3u8" : "video.mp4"}?sig=preserve`;
      await call("open", event, result.id, source, {
        Authorization: "Bearer fixture",
        Referer: "https://fixture.test/",
      });
      original.events.push(
        ...[
          ["time-pos", 45],
          ["duration", 120],
          ["seekable", true],
          ["file-format", format === "hls-masked" ? "hls" : format],
        ].map(([name, data]) => ({ type: "property-change", name, data })),
      );
      original.eventCallback();
      await tick();
      await call("set-volume", event, result.id, 73);
      await call("set-speed", event, result.id, 1.25);
      await call("set-audio-track", event, result.id, 2);
      await call("set-subtitle-track", event, result.id, 3);
      await call(paused ? "pause" : "play", event, result.id);
      if (!live) await call("seek", event, result.id, 80);
      original.frames.push(new Error("fixture GPU device removed"));
      original.updateCallback();
      for (let i = 0; i < 20 && instances.at(-1) === original; i++)
        await tick();
      await tick();
      const replacement = instances.at(-1);
      assert.notStrictEqual(
        replacement,
        original,
        "GPU error did not trigger software fallback",
      );
      assert.equal(replacement.mode, "software");
      const opened = replacement.calls.find(([name]) => name === "open");
      assert.equal(opened[1], source);
      assert.deepEqual(Array.from(opened[2]), [
        "Authorization: Bearer fixture",
        "Referer: https://fixture.test/",
      ]);
      for (const expected of [
        ["volume", 73],
        ["speed", 1.25],
        ["audio", 2],
        ["sub", 3],
        [paused ? "pause" : "play"],
      ])
        assert.ok(
          replacement.calls.some(
            (call) => JSON.stringify(call) === JSON.stringify(expected),
          ),
          `Fallback lost ${expected[0]}`,
        );
      const seeks = replacement.calls.filter(([name]) => name === "seek");
      assert.equal(
        seeks.length,
        live ? 0 : 1,
        "Fallback seek policy does not distinguish live from VOD",
      );
      if (!live) assert.equal(seeks[0][1], 45);
      assert.equal(
        original.calls.filter(([name]) => name === "destroy").length,
        1,
      );
      const count = instances.length;
      original.updateCallback?.();
      await tick();
      assert.equal(
        instances.length,
        count,
        "GPU failure started a fallback retry loop",
      );
      await call("destroy", event, result.id);
    } finally {
      await service.dispose();
    }
  }
  assert.equal(handlers.size, 0);
  console.log(
    "D3D11 integration contract passed: capabilities, init reservation/cancellation, fallback and cleanup",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
