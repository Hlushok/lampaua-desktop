const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { Readable } = require("node:stream");
const { EventEmitter } = require("node:events");

function fixture(t, { pages = [], responses = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lampaua-torrserver-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  const settings = new Map();
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../src/modules/torrServerManager.js"),
      "utf8",
    ),
    {
      module,
      process: { platform: "win32", arch: "x64" },
      URL,
      console: { log() {}, warn() {}, error() {} },
      require(name) {
        if (name === "electron") return { app: { getPath: () => root } };
        if (name === "./storeManager")
          return {
            get: (key, fallback) => settings.get(key) ?? fallback,
            set: (key, value) => settings.set(key, value),
          };
        if (name === "./utils/electronNetFetch")
          return {
            async electronNetFetch(url) {
              requests.push(url);
              const page = pages.shift();
              assert.ok(page, "Unexpected release request");
              return {
                ok: !page.status || page.status === 200,
                status: page.status || 200,
                json: async () => page.body,
              };
            },
          };
        if (name === "node:https")
          return {
            get(url, callback) {
              requests.push(url);
              const next = responses.shift();
              assert.ok(next, "Unexpected download request");
              const response = Readable.from(next.chunks || ["binary"]);
              response.statusCode = next.status || 200;
              response.headers = next.headers || {};
              queueMicrotask(() => callback(response));
              return new EventEmitter();
            },
          };
        return require(name);
      },
    },
  );
  return { manager: module.exports, root, requests, settings };
}

const matrix = {
  tag_name: "MatriX.140",
  name: "MatriX",
  assets: [{ name: "TorrServer-windows-amd64.exe" }],
};

test("TorrServer skips Silo releases across pages using Chromium fetch", async (t) => {
  const { manager, requests } = fixture(t, {
    pages: [
      { body: Array.from({ length: 10 }, () => ({ tag_name: "Silo.1" })) },
      { body: [matrix] },
    ],
  });
  assert.equal((await manager.getLatestRelease()).version, matrix.tag_name);
  assert.equal(requests.length, 2);
  assert.match(requests[1], /page=2$/);
});

test("TorrServer release API errors and exhausted pagination fail explicitly", async (t) => {
  for (const pages of [
    [{ status: 403 }],
    [{ body: [] }],
    Array.from({ length: 5 }, () => ({
      body: Array.from({ length: 10 }, () => ({ tag_name: "Silo.1" })),
    })),
  ]) {
    const { manager, requests } = fixture(t, { pages });
    await assert.rejects(manager.getLatestRelease(), /HTTP 403|MatriX/);
    assert.ok(requests.length <= 5);
  }
});

test("TorrServer follows relative redirects and completes progress after writing", async (t) => {
  const { manager, root, requests } = fixture(t, {
    responses: [
      { status: 302, headers: { location: "/asset" } },
      { chunks: ["abc", "def"], headers: { "content-length": "6" } },
    ],
  });
  const destination = path.join(root, "download");
  const progress = [];
  await manager.downloadFileWithProgress(
    "https://example.invalid/redirect",
    destination,
    (item) => progress.push(item),
  );
  assert.equal(requests[1], "https://example.invalid/asset");
  assert.equal(fs.readFileSync(destination, "utf8"), "abcdef");
  assert.equal(progress.at(-1).percent, 100);
  assert.equal(progress.at(-1).received, 6);
});

test("TorrServer failed or empty downloads preserve the installed binary and clean temporary files", async (t) => {
  for (const response of [
    { chunks: ["partial"], headers: { "content-length": "100" } },
    { chunks: [] },
    { status: 404 },
  ]) {
    const { manager, settings } = fixture(t, {
      pages: [{ body: [matrix] }],
      responses: [response],
    });
    const info = manager.getPlatformInfo();
    fs.mkdirSync(info.saveDir, { recursive: true });
    fs.writeFileSync(info.savePath, "installed binary");
    const result = await manager.download();
    assert.equal(result.success, false);
    assert.equal(fs.readFileSync(info.savePath, "utf8"), "installed binary");
    assert.equal(fs.existsSync(info.downloadPath), false);
    assert.equal(settings.has("tsVersion"), false);
    assert.equal(manager.downloadProgress, null);
  }
});

test("TorrServer replaces the binary only after a successful download", async (t) => {
  const { manager, settings } = fixture(t, {
    pages: [{ body: [matrix] }],
    responses: [{ chunks: ["new binary"] }],
  });
  const info = manager.getPlatformInfo();
  fs.mkdirSync(info.saveDir, { recursive: true });
  fs.writeFileSync(info.savePath, "old binary");
  assert.equal((await manager.download()).success, true);
  assert.equal(fs.readFileSync(info.savePath, "utf8"), "new binary");
  assert.equal(fs.existsSync(info.downloadPath), false);
  assert.equal(settings.get("tsVersion"), matrix.tag_name);
});
