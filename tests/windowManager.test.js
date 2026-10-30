const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const hash = "0123456789abcdef0123456789abcdef01234567";
const original = `iina://weblink?url=${encodeURIComponent(`http://127.0.0.1:8090/stream/S01E03.mkv?link=${hash}&index=3&play`)}`;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function create({
  platform = "darwin",
  next = true,
  failRead = false,
  failOpen = false,
  fullscreen = false,
} = {}) {
  const opened = [];
  let settingsReads = 0;
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.fullscreen = Boolean(options.fullscreen);
      this.webContents = new EventEmitter();
      this.webContents.getURL = () => "https://kinohub.uk/";
      this.webContents.setWindowOpenHandler = (handler) => {
        this.openHandler = handler;
      };
      this.webContents.executeJavaScript = async () => {
        settingsReads++;
        if (failRead) throw new Error("renderer unavailable");
        return next;
      };
    }
    setMenu() {}
    loadURL(url) {
      this.loaded = url;
      return Promise.resolve();
    }
    setFullScreen(value) {
      this.fullscreen = value;
    }
    isFullScreen() {
      return this.fullscreen;
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../src/modules/windowManager.js"),
      "utf8",
    ),
    {
      module,
      __dirname: path.join(__dirname, "../src/modules"),
      process: { platform, argv: [] },
      URL,
      console: { log() {}, warn() {}, error() {} },
      setTimeout,
      clearTimeout,
      require(name) {
        if (name === "electron")
          return {
            BrowserWindow: Window,
            screen: {
              getAllDisplays: () => [
                { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
              ],
            },
            shell: {
              openExternal: async (url) => {
                opened.push(url);
                if (failOpen && url !== original)
                  throw new Error("playlist handler failure");
              },
            },
          };
        if (name === "./storeManager")
          return {
            get: (key, fallback) => {
              if (key === "lampaUrl") return "https://kinohub.uk/";
              if (key === "fullscreenMode")
                return fullscreen ? "always" : "never";
              return fallback;
            },
          };
        if (name === "./pluginHandler") return { setupPluginHandler() {} };
        if (name === "./mpv/testMode") return { isMpvEnabled: () => false };
        return require(
          name.startsWith("./")
            ? path.join(__dirname, "../src/modules", name)
            : name,
        );
      },
    },
  );
  return {
    window: module.exports.createWindow(),
    opened,
    reads: () => settingsReads,
  };
}

test("macOS window remains fullscreenable without explicit fullscreen:false", () => {
  const { window } = create();
  assert.equal(window.options.fullscreenable, true);
  assert.equal("fullscreen" in window.options, false);
  assert.equal(create({ fullscreen: true }).window.options.fullscreen, true);
  assert.equal(create({ platform: "win32" }).window.options.fullscreen, false);
});

test("native fullscreen shortcut is macOS-only", () => {
  const { window } = create();
  let prevented = false;
  window.webContents.emit(
    "before-input-event",
    {
      preventDefault() {
        prevented = true;
      },
    },
    {
      type: "keyDown",
      key: "f",
      control: true,
      meta: true,
      alt: false,
      shift: false,
    },
  );
  assert.equal(prevented, true);
  assert.equal(window.fullscreen, true);
  assert.equal(
    create({ platform: "win32" }).window.webContents.listenerCount(
      "before-input-event",
    ),
    0,
  );
});

test("IINA episode is converted only on macOS and respects disabled next-episode", async () => {
  for (const [options, converted] of [
    [{}, true],
    [{ next: false }, false],
    [{ platform: "win32" }, false],
  ]) {
    const { window, opened, reads } = create(options);
    assert.equal(window.openHandler({ url: original }).action, "deny");
    await tick();
    assert.equal(opened.length, 1);
    assert.equal(opened[0] !== original, converted);
    if (converted)
      assert.match(decodeURIComponent(opened[0]), /\/playlist\/episodes\.m3u/);
    if (options.platform === "win32") assert.equal(reads(), 0);
  }
});

test("IINA settings and playlist launch failures retain original episode", async () => {
  for (const options of [{ failRead: true }, { failOpen: true }]) {
    const { window, opened, reads } = create(options);
    window.openHandler({ url: original });
    await tick();
    assert.equal(opened.at(-1), original);
    assert.equal(reads(), 1);
    assert.equal(opened.length, options.failOpen ? 2 : 1);
  }
});

test("same-origin navigation and popups remain internal", async () => {
  const { window, opened } = create();
  let prevented = false;
  window.webContents.emit(
    "will-navigate",
    {
      preventDefault() {
        prevented = true;
      },
    },
    "https://kinohub.uk/auth/callback",
  );
  assert.equal(prevented, false);
  window.openHandler({ url: "https://kinohub.uk/lite/iptvportal/app" });
  await tick();
  assert.equal(window.loaded, "https://kinohub.uk/lite/iptvportal/app");
  assert.deepEqual(opened, []);
});

test("external HTTP popup does not read episode setting", async () => {
  const { window, opened, reads } = create();
  window.openHandler({ url: "https://example.org/" });
  await tick();
  assert.deepEqual(opened, ["https://example.org/"]);
  assert.equal(reads(), 0);
});
