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
  class Native {
    constructor() {
      this.events = [];
      instances.push(this);
    }
    open(source) {
      controls.push(["open", source]);
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
      return { width: 2, height: 2, rgba: Buffer.alloc(16) };
    }
    pollEvents() {
      if (restoring) return loaded ? [{ type: "file-loaded" }] : [];
      return this.events.splice(0);
    }
    destroy() {
      controls.push(["destroy"]);
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
      send() {},
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
  await call("open", e, id, "http://127.0.0.1:8090/a");
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
