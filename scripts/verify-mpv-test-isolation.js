const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
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
  console.log("MPV test isolation contract verified");
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
