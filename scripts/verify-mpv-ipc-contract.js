const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
if (!process.argv.includes("--child")) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-vm-modules", __filename, "--child"],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}
async function main() {
  const root = path.resolve(__dirname, "..");
  const native = fs.readFileSync(
    path.join(
      root,
      "third_party/electron-mpv-video/native/mpv-addon/src/mpv_addon.cc",
    ),
    "utf8",
  );
  assert.doesNotMatch(
    native,
    /\bmpv_(?:command|set_property|set_property_string)\s*\(/,
    "Runtime controls must not block the render/UI thread",
  );
  assert.match(native, /class FrameWorker : public Napi::AsyncWorker/);
  assert.match(native, /class CleanupWorker : public Napi::AsyncWorker/);
  assert.match(native, /cleanup_promise_ = Napi::Persistent/);
  assert.match(native, /if \(event->error < 0\) \{\s*fail_commands\(/);
  assert.match(native, /commands_\.size\(\) >= 128/);
  assert.match(native, /event->reply_userdata == commands_\.front\(\)\.id/);
  const policyPath = path.join(root, "src/modules/mpv/policy.js");
  assert.ok(fs.existsSync(policyPath), "MPV authorization policy is missing");
  const policy = require(policyPath);
  for (const source of [
    "file:///C:/secret",
    "lavfi:testsrc",
    "C:\\secret",
    "relative.mp4",
    "http://a/\u0000",
  ])
    assert.throws(() => policy.normalizeSource(source));
  assert.equal(
    policy.normalizeSource("http://127.0.0.1:8090/a"),
    "http://127.0.0.1:8090/a",
  );
  assert.equal(
    policy.normalizeSource("https://example.org/a"),
    "https://example.org/a",
  );
  const handlers = new Map();
  const ipcMain = {
    handle: (name, cb) => handlers.set(name, cb),
    removeHandler: (name) => handlers.delete(name),
  };
  const controls = [];
  const instances = [];
  let restoring = false;
  let loaded = false;
  let frameGate;
  let destroyGate;
  let sentFrames = 0;
  class Native {
    constructor() {
      this.events = [];
      instances.push(this);
    }
    open(source, headers, format) {
      controls.push(["open", source]);
      controls.push(["format", format]);
      controls.push(["headers", headers]);
      this.events = source.endsWith("empty")
        ? []
        : [
            {
              type: "property-change",
              name: "track-list",
              data: [
                { id: 1, type: "audio", selected: true },
                { id: 2, type: "sub" },
              ],
            },
          ];
    }
    play() {}
    pause() {}
    stop() {}
    seek(value) {
      controls.push(["seek", value]);
    }
    setVolume(value) {
      controls.push(["volume", value]);
    }
    setSpeed(value) {
      controls.push(["speed", value]);
    }
    setAudioTrack(value) {
      controls.push(["audio", value]);
    }
    setSubtitleTrack(value) {
      controls.push(["sub", value]);
    }
    setUpdateCallback() {}
    setEventCallback() {}
    renderFrame() {
      return (
        frameGate ??
        Promise.resolve({ width: 2, height: 2, rgba: Buffer.alloc(16) })
      );
    }
    pollEvents() {
      if (restoring) return loaded ? [{ type: "file-loaded" }] : [];
      return this.events.splice(0);
    }
    destroy() {
      controls.push(["destroy"]);
      return destroyGate ?? Promise.resolve();
    }
  }
  const context = vm.createContext({
    console,
    Buffer,
    URL,
    process,
    queueMicrotask,
    setTimeout,
    clearTimeout,
  });
  const modulePath = path.join(
    root,
    ".cache/mpv-desktop-test/lib/main/mpv-service.js",
  );
  assert.ok(fs.existsSync(modulePath), "compiled MPV service is missing");
  const mod = new vm.SourceTextModule(fs.readFileSync(modulePath, "utf8"), {
    context,
    initializeImportMeta(meta) {
      meta.url = new URL(`file:///${modulePath.replaceAll("\\", "/")}`).href;
    },
  });
  await mod.link(async (name) => {
    let values;
    if (name === "electron") values = { ipcMain, sharedTexture: {} };
    else if (name === "node:module")
      values = { createRequire: () => () => ({ MpvPlayer: Native }) };
    else values = await import(name);
    const names = Object.keys(values);
    return new vm.SyntheticModule(
      names,
      function () {
        for (const key of names) this.setExport(key, values[key]);
      },
      { context },
    );
  });
  await mod.evaluate();
  const service = mod.namespace.createMpvMain({
    addonPath: "fake",
    authorize: policy.authorize,
    normalizeSource: policy.normalizeSource,
  });
  const windows = [1, 2].map((id) => {
    const win = new EventEmitter();
    win.webContents = new EventEmitter();
    Object.assign(win.webContents, {
      id,
      mainFrame: { url: "https://kinohub.uk/" },
      send(channel) {
        if (channel.endsWith(":player:frame")) sentFrames++;
      },
      isDestroyed: () => false,
    });
    win.isDestroyed = () => false;
    service.attachWindow(win);
    win.webContents.emit("did-finish-load");
    return win;
  });
  const event = (win) => ({
    sender: win.webContents,
    senderFrame: win.webContents.mainFrame,
  });
  const call = (name, e, ...args) =>
    handlers.get(`electron-mpv-video:v1:player:${name}`)(e, ...args);
  const e = event(windows[0]);
  await assert.rejects(
    call("create", { ...e, senderFrame: { url: "https://kinohub.uk/" } }),
    /authoriz|frame/i,
  );
  const id = await call("create", e);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(call("create", e), /active|session/i);
  await assert.rejects(call("play", event(windows[1]), id), /belong/i);
  await assert.rejects(call("open", e, id, "file:///C:/secret"));
  for (const [source, expected] of [
    ["https://example.org/ytdl/manifest?token=keep", "dash"],
    ["https://example.org/live/channel.m3u8", "hls"],
    ["https://example.org/channel.mpd", "dash"],
    [
      `https://kinohub.uk/lite/iptvportal/api/stream?playlist=test&target=${Buffer.from("http://provider.test/live/video.m3u8").toString("base64url")}&sig=preserve`,
      "hls",
    ],
    [
      `http://lampaua.mooo.com/lite/iptvportal/api/stream?target=${Buffer.from("https://provider.test/live/video.m3u8?auth=keep").toString("base64url")}`,
      "hls",
    ],
    [
      `https://kinohub.uk/lite/iptvportal/api/stream?target=${Buffer.from("http://provider.test/live/channel.ts").toString("base64url")}`,
      "auto",
    ],
    [
      `https://kinohub.uk/lite/iptvportal/api/stream?target=${Buffer.from("file:///C:/secret.m3u8").toString("base64url")}`,
      "auto",
    ],
    ["https://kinohub.uk/lite/iptvportal/api/stream?target=invalid!", "auto"],
    [
      `https://kinohub.uk/not-the-portal?target=${Buffer.from("https://provider.test/video.m3u8").toString("base64url")}`,
      "auto",
    ],
    ["https://example.org/file.mp4", "auto"],
  ]) {
    await call("open", e, id, source);
    assert.equal(controls.at(-2)[1], expected);
    assert.equal(
      controls.at(-3)[1],
      source,
      "Signed playback URL must not be rewritten",
    );
  }
  await call("open", e, id, "https://example.org/protected", {
    Referer: "https://example.org/",
    "User-Agent": "LampaUa-Test",
  });
  assert.equal(
    JSON.stringify(controls.at(-1)),
    JSON.stringify([
      "headers",
      ["Referer: https://example.org/", "User-Agent: LampaUa-Test"],
    ]),
    "Explicit media headers must reach native playback",
  );
  for (const headers of [
    { Referer: "safe\r\nInjected: bad" },
    { Host: "localhost" },
    { Range: "bytes=1-2" },
    { "Bad Name": "bad" },
    { Cookie: "x".repeat(8193) },
    ["not-a-map"],
    { origin: "a", Origin: "b" },
  ])
    await assert.rejects(call("open", e, id, "https://example.org/a", headers));
  await call("open", e, id, "http://127.0.0.1:8090/a");
  assert.equal(
    JSON.stringify(controls.at(-1)),
    JSON.stringify(["headers", []]),
    "A new unprotected source must clear previous headers",
  );
  await assert.rejects(call("set-speed", e, id, NaN));
  await assert.rejects(call("set-volume", e, id, 101));
  await assert.rejects(call("seek", e, id, -1));
  await assert.rejects(call("set-audio-track", e, id, 2));
  await call("set-speed", e, id, 1.5);
  await call("set-audio-track", e, id, 1);
  await call("set-subtitle-track", e, id, 2);
  await call("open", e, id, "http://127.0.0.1:8090/empty");
  await assert.rejects(call("set-audio-track", e, id, 1), /Unknown track/);
  await call("open", e, id, "http://127.0.0.1:8090/a");
  restoring = true;
  const beforeSwitch = instances.length;
  const switching = call("set-render-pipeline", e, id, "shared-texture");
  const queuedSeek = call("seek", e, id, 9);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(instances.length, beforeSwitch + 1);
  assert.ok(
    !controls.some(([name, value]) => name === "seek" && value === 9),
    "Commands must wait for a pipeline switch",
  );
  const destroying = call("destroy", e, id);
  await assert.rejects(call("create", e), /active|session/i);
  loaded = true;
  await assert.rejects(switching, /destroy/i);
  await assert.rejects(queuedSeek, /destroy/i);
  await destroying;
  restoring = false;
  const nextId = await call("create", e);
  windows[0].webContents.emit(
    "did-start-navigation",
    {},
    "https://kinohub.uk/#player",
    true,
    true,
  );
  await call("play", e, nextId);
  windows[0].webContents.emit(
    "did-start-navigation",
    {},
    "https://kinohub.uk/",
    false,
    true,
  );
  await assert.rejects(call("play", e, nextId), /Unknown|destroy|navigat/i);
  await assert.rejects(call("create", e), /navigat|document/i);
  windows[0].webContents.emit("did-finish-load");
  const newDocument = await call("create", e);
  await call("destroy", e, newDocument);

  let finishFrame;
  frameGate = new Promise((resolve) => {
    finishFrame = resolve;
  });
  const slowFrameId = await call("create", e);
  await new Promise((resolve) => setImmediate(resolve));
  const beforeControls = Date.now();
  await call("pause", e, slowFrameId);
  await call("seek", e, slowFrameId, 11);
  await call("play", e, slowFrameId);
  assert.ok(Date.now() - beforeControls < 1000, "Slow frame blocked controls");
  let destroyedSlowFrame = false;
  const slowClosing = call("destroy", e, slowFrameId).then(() => {
    destroyedSlowFrame = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    destroyedSlowFrame,
    false,
    "Native state freed before its frame finished",
  );
  const framesBeforeClose = sentFrames;
  finishFrame({ width: 2, height: 2, rgba: Buffer.alloc(16) });
  await slowClosing;
  assert.equal(
    sentFrames,
    framesBeforeClose,
    "Late frame sent after player shutdown",
  );
  frameGate = undefined;
  let finishDestroy;
  destroyGate = new Promise((resolve) => {
    finishDestroy = resolve;
  });
  const slowDestroyId = await call("create", e);
  let nativeCleanupFinished = false;
  const slowDestroy = call("destroy", e, slowDestroyId).then(() => {
    nativeCleanupFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(nativeCleanupFinished, false, "Native cleanup was not awaited");
  await assert.rejects(call("create", e), /active|session/i);
  finishDestroy();
  await slowDestroy;
  destroyGate = undefined;
  await service.dispose();
  assert.ok(
    controls.some(([name, value]) => name === "speed" && value === 1.5),
  );
  console.log("MPV ownership/source/control contract verified");
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
