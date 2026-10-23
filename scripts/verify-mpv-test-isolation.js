const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
function load(file, requires, extra = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), {
    module,
    exports: module.exports,
    require: (name) =>
      name in requires
        ? requires[name]
        : createRequire(path.join(root, file))(name),
    console,
    process: { argv: [], platform: "win32", env: {} },
    ...extra,
  });
  return module.exports;
}
async function main() {
  for (const args of [[], ["--d3d11", "--release"]]) {
    const rejected = spawnSync(
      process.execPath,
      [
        path.join(root, "scripts/verify-mpv-desktop.cjs"),
        "--reuse-test-profile",
        ...args,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 5000 },
    );
    assert.notEqual(rejected.status, 0);
    assert.match(
      rejected.stderr,
      /Persistent profile requires the isolated D3D11 test package/,
    );
  }
  const missingExe = spawnSync(
    process.execPath,
    [path.join(root, "scripts/verify-mpv-desktop.cjs"), "--d3d11"],
    { encoding: "utf8", windowsHide: true, timeout: 5000 },
  );
  assert.notEqual(missingExe.status, 0);
  assert.match(
    missingExe.stderr,
    /Pass --exe pointing to the full desktop build/,
  );
  const foreignPackage = spawnSync(
    process.execPath,
    [
      path.join(root, "scripts/verify-mpv-desktop.cjs"),
      "--d3d11",
      "--reuse-test-profile",
      "--exe",
      process.execPath,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 5000 },
  );
  assert.notEqual(foreignPackage.status, 0);
  assert.match(
    foreignPackage.stderr,
    /Persistent profile requires the isolated D3D11 test package/,
  );
  assert.ok(
    fs.existsSync(path.join(root, "src/modules/mpv/testMode.js")),
    "test-mode bootstrap is missing",
  );
  const mode = load("src/modules/mpv/testMode.js", {
    "../../../package.json": { lampauaMpvTest: true },
  });
  const calls = [];
  const app = {
    getPath: () => "D:/AppData",
    setName: (name) => calls.push(["name", name]),
    setPath: (key, value) => calls.push([key, value]),
    setAppUserModelId: (id) => calls.push(["id", id]),
  };
  mode.bootstrapMpvTest(app);
  assert.ok(
    calls.some(
      ([key, value]) =>
        key === "userData" && value.endsWith("LampaUaDesktopMpvTest"),
    ),
  );
  assert.equal(mode.isMpvTest(), true);
  assert.equal(mode.isMpvEnabled(), true);
  for (const [pkg, platform, arch, expected] of [
    [{ lampauaMpv: true, lampauaMpvD3d11: true }, "win32", "x64", true],
    [{ lampauaMpv: true, lampauaMpvD3d11: true }, "win32", "arm64", false],
    [{ lampauaMpv: true, lampauaMpvD3d11: true }, "darwin", "x64", false],
    [{ lampauaMpv: true, lampauaMpvD3d11: true }, "linux", "x64", false],
    [{ lampauaMpvD3d11: true }, "win32", "x64", false],
    [{ lampauaMpvTest: true, lampauaMpvD3d11: true }, "win32", "x64", false],
    [{ lampauaMpvTest: true, lampauaMpvD3d11Test: true }, "win32", "x64", true],
  ]) {
    const enabled = load(
      "src/modules/mpv/testMode.js",
      {
        "../../../package.json": pkg,
      },
      { process: { platform, arch, argv: [] } },
    );
    assert.equal(enabled.isMpvD3d11Enabled(), expected);
    assert.equal(enabled.isMpvTest(), pkg.lampauaMpvTest === true);
    if (!enabled.isMpvTest())
      assert.throws(() => enabled.bootstrapMpvTest(app), /test package/);
  }
  for (const args of [[], ["--mpv-test-visible"], ["--mpv-test-window-log"]]) {
    const testApp = new EventEmitter();
    let bootstrapped = false;
    const pins = [];
    const hooks = [];
    load(
      "src/mpv-test-main.js",
      {
        electron: { app: testApp },
        "./modules/mpv/testMode": {
          bootstrapMpvTest() {
            bootstrapped = true;
          },
        },
        "./main": {},
      },
      { process: { argv: args } },
    );
    assert.equal(bootstrapped, true);
    testApp.emit(
      "browser-window-created",
      {},
      {
        setAlwaysOnTop: (value) => pins.push(value),
        on: (name) => hooks.push(name),
      },
    );
    assert.deepEqual(
      pins,
      [],
      "Test diagnostics must never pin the window above the user's applications",
    );
    assert.deepEqual(
      hooks,
      args.includes("--mpv-test-window-log")
        ? ["show", "hide", "minimize", "restore", "focus", "blur"]
        : [],
    );
  }
  const productionMode = load("src/modules/mpv/testMode.js", {
    "../../../package.json": {},
  });
  const productionApp = new EventEmitter();
  assert.throws(
    () =>
      load(
        "src/mpv-test-main.js",
        {
          electron: { app: productionApp },
          "./modules/mpv/testMode": productionMode,
          "./main": {},
        },
        { process: { argv: ["--mpv-test-visible"] } },
      ),
    /test package/i,
  );
  assert.equal(productionApp.listenerCount("browser-window-created"), 0);
  for (const [pkg, platform, arch, expected] of [
    [{ lampauaMpvTest: true, lampauaMpvD3d11Test: true }, "win32", "x64", true],
    [
      { lampauaMpvTest: true, lampauaMpvD3d11Test: true },
      "win32",
      "arm64",
      false,
    ],
    [{ lampauaMpv: true, lampauaMpvD3d11Test: true }, "win32", "x64", false],
    [{ lampauaMpvTest: true }, "win32", "x64", false],
  ]) {
    const candidateMode = load(
      "src/modules/mpv/testMode.js",
      { "../../../package.json": pkg },
      { process: { platform, arch, argv: [] } },
    );
    assert.equal(candidateMode.isMpvD3d11Test(), expected);
    if (expected) {
      candidateMode.bootstrapMpvTest(app);
      assert.ok(
        calls.some(
          ([key, value]) =>
            key === "userData" && value.endsWith("LampaUaDesktopMpvD3d11Test"),
        ),
      );
    }
  }
  assert.equal(load("src/modules/mpv/testMode.js", {}).isMpvTest(), false);
  for (const [platform, arch, expected] of [
    ["win32", "x64", true],
    ["win32", "arm64", false],
    ["win32", "ia32", false],
    ["linux", "x64", false],
    ["darwin", "arm64", false],
  ]) {
    const production = load(
      "src/modules/mpv/testMode.js",
      {
        "../../../package.json": { lampauaMpv: true },
      },
      { process: { platform, arch, argv: [] } },
    );
    assert.equal(production.isMpvTest(), false);
    assert.equal(production.isMpvEnabled(), expected);
  }
  const bad = load(
    "src/modules/mpv/testMode.js",
    { "../../../package.json": { lampauaMpvTest: true } },
    { process: { argv: ["--mpv-test-run=../production"], platform: "win32" } },
  );
  assert.throws(() => bad.bootstrapMpvTest(app), /run id/);
  const order = [];
  load(
    "src/mpv-test-main.js",
    {
      electron: { app },
      "./modules/mpv/testMode": {
        bootstrapMpvTest: () => order.push("bootstrap"),
      },
      "./main": () => order.push("main"),
    },
    {
      require(name) {
        if (name === "electron") return { app };
        if (name === "./modules/mpv/testMode")
          return { bootstrapMpvTest: () => order.push("bootstrap") };
        if (name === "./main") {
          order.push("main");
          return {};
        }
        throw new Error(name);
      },
    },
  );
  assert.deepEqual(order, ["bootstrap", "main"]);
  load("src/modules/autoUpdater.js", {
    "electron-updater": {
      autoUpdater: new Proxy(
        {},
        {
          get() {
            throw new Error("updater accessed");
          },
        },
      ),
    },
    electron: {},
    "./storeManager": {},
    "./mpv/testMode": { isMpvTest: () => true },
  }).setupAutoUpdater();
  const data = new Map();
  const localStorage = {
    getItem: (key) => data.get(key) || null,
    setItem: (key, value) => data.set(key, value),
  };
  const initializer = load("src/modules/lampaInitializer.js", {
    "./mpv/testMode": { isMpvEnabled: () => true },
    "./playerFinder": {
      findAllPlayers: () => {
        throw new Error("inner selection must not discover players");
      },
    },
  });
  const win = {
    webContents: {
      executeJavaScript: async (code) =>
        vm.runInNewContext(code, { localStorage, console }),
    },
  };
  await initializer.initializeBasicSettings(win);
  assert.equal(data.get("player_torrent"), "inner");
  assert.equal(data.get("player"), "inner");
  await initializer.initializePlayerPath(win);
  data.set("player_torrent", "other");
  await initializer.initializeBasicSettings(win);
  assert.equal(data.get("player_torrent"), "other");

  const closeTimers = [];
  const timeout = (fn, ms) => {
    const timer = { fn, ms, unref() {} };
    closeTimers.push(timer);
    return timer;
  };
  class Window extends EventEmitter {
    constructor() {
      super();
      this.dead = false;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
    }
    setMenu() {}
    isDestroyed() {
      return this.dead;
    }
    isFullScreen() {
      return false;
    }
    isMaximized() {
      return false;
    }
    getBounds() {
      return { x: 0, y: 0, width: 1200, height: 800 };
    }
    destroy() {
      this.dead = true;
      this.emit("closed");
    }
    loadURL() {
      return Promise.resolve();
    }
  }
  const manager = load(
    "src/modules/windowManager.js",
    {
      electron: {
        BrowserWindow: Window,
        screen: {
          getAllDisplays: () => [
            { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
          ],
          getDisplayMatching: () => ({ id: 1 }),
        },
      },
      "./storeManager": { get: (_, fallback) => fallback, set() {} },
      "./pluginHandler": { setupPluginHandler() {} },
      "./mpv/testMode": { isMpvEnabled: () => true },
      "./mpv/manager": {
        attachMpvWindow: async () => {},
        detachMpvWindow: () => new Promise(() => {}),
      },
    },
    {
      __dirname: path.join(root, "src/modules"),
      setTimeout: timeout,
      clearTimeout() {},
    },
  );
  const closingWindow = manager.createWindow();
  let prevented = false;
  closingWindow.emit("close", {
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(closeTimers[0].ms, 3000);
  closeTimers[0].fn();
  assert.equal(
    closingWindow.isDestroyed(),
    true,
    "Slow frame kept the window open",
  );

  const lifecycle = new Map();
  const exited = [];
  closeTimers.length = 0;
  load(
    "src/main.js",
    {
      electron: {
        app: {
          on: (name, fn) => lifecycle.set(name, fn),
          whenReady: () => ({ then() {} }),
          exit: (code) => exited.push(code),
        },
      },
      "./modules/appLifecycle": { setupAppLifecycle() {}, gotTheLock: true },
      "./modules/windowManager": { createWindow() {} },
      "./modules/autoUpdater": { setupAutoUpdater() {} },
      "./modules/ipcHandlers": { registerIpcHandlers() {} },
      "./modules/torrServerManager": {},
      "./modules/autoStartManager": {},
      "./modules/playerOptionsInterceptor": {},
      "./modules/mpv/testMode": { isMpvEnabled: () => true },
      "./modules/mpv/manager": { disposeMpv: () => new Promise(() => {}) },
    },
    { setTimeout: timeout, clearTimeout() {} },
  );
  void lifecycle.get("will-quit")({ preventDefault() {} });
  assert.equal(closeTimers[0].ms, 6000);
  closeTimers[0].fn();
  assert.deepEqual(exited, [0], "Slow native teardown prevented app exit");
  console.log("MPV test isolation contract verified");
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
