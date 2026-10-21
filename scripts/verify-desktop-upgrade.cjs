const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const yaml = require("yaml");
const {
  finalizeMacUpdates,
  minimumSystemVersion,
} = require("./finalize-macos-updates.cjs");
const pkg = require("../package.json");
const runtime = require("../build/electron-runtime-windows-x64.json");
const { publicStoreSnapshot } = require("../src/modules/storeAccessPolicy");

assert.equal(runtime.repository, "electron/electron");
assert.equal(runtime.version, pkg.devDependencies.electron);
assert.equal(runtime.inputs["ffmpeg.dll"], runtime.ffmpegSha256);
for (const hash of [runtime.sha256, ...Object.values(runtime.inputs)])
  assert.match(hash, /^[0-9a-f]{64}$/);
assert.deepEqual(pkg.build.win.target, [
  { target: "nsis", arch: ["x64", "arm64"] },
]);
assert.equal(pkg.build.mac.minimumSystemVersion, "13.0.0");
assert.equal(minimumSystemVersion, "22.0.0");
assert.ok(pkg.build.mac.target.some((target) => target.target === "zip"));

const { AppUpdater } = require("electron-updater/out/AppUpdater");
const originalRelease = os.release;
try {
  for (const [kernel, expected] of [
    ["21.6.0", false],
    ["22.0.0", true],
    ["25.0.0", true],
  ]) {
    os.release = () => kernel;
    assert.equal(
      AppUpdater.prototype.checkIfUpdateSupported.call(
        { _logger: { info() {}, warn() {} } },
        { minimumSystemVersion },
      ),
      expected,
      `Darwin ${kernel} update eligibility`,
    );
  }
} finally {
  os.release = originalRelease;
}

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lampaua-store-upgrade-"));
try {
  const files = ["x64", "arm64"].map((arch) => {
    const url = `lampaua-${arch}-${pkg.version}.zip`;
    const data = Buffer.from(`macOS-${arch}`);
    fs.writeFileSync(path.join(folder, url), data);
    return {
      url,
      size: data.length,
      sha512: crypto.createHash("sha512").update(data).digest("base64"),
    };
  });
  fs.writeFileSync(
    path.join(folder, "latest-mac.yml"),
    yaml.stringify({
      version: pkg.version,
      files,
      path: files[0].url,
      sha512: files[0].sha512,
    }),
  );
  const mac = finalizeMacUpdates(folder);
  assert.equal(mac.minimumSystemVersion, "22.0.0");
  const validMac = fs.readFileSync(path.join(folder, "latest-mac.yml"), "utf8");
  fs.writeFileSync(path.join(folder, files[0].url), "corrupted");
  assert.throws(() => finalizeMacUpdates(folder), /AssertionError/);
  assert.equal(
    fs.readFileSync(path.join(folder, "latest-mac.yml"), "utf8"),
    validMac,
  );
  const previous = {
    lampaUrl: "http://lampaua.mooo.com/",
    autoUpdate: false,
    defaultPlayer: "ua-player",
    trustedPlayerPath: "C:/Players/player.exe",
    windowState: { x: 12, y: 24, width: 1200, height: 800 },
    tsPort: 8090,
  };
  const file = path.join(folder, "config.json");
  const bytes = JSON.stringify(previous, null, "\t");
  fs.writeFileSync(file, bytes);
  const Store = require("electron-store").default;
  const store = new Store({ cwd: folder, projectVersion: "2.0.2" });
  assert.deepEqual({ ...store.store }, previous);
  assert.equal(store.get("autoUpdate"), false);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  const exported = publicStoreSnapshot(store.store);
  assert.equal(exported.trustedPlayerPath, undefined);
  assert.deepEqual(exported.windowState, previous.windowState);
  store.set("tsPort", 8091);
  const reopened = new Store({ cwd: folder, projectVersion: "2.0.2" });
  assert.deepEqual({ ...reopened.store }, { ...previous, tsPort: 8091 });
  for (const name of ["settingsHandlers.js", "cloudHandlers.js"]) {
    const source = fs.readFileSync(
      path.join(__dirname, "../src/modules/ipcHandlers", name),
      "utf8",
    );
    assert.ok(source.includes("publicStoreSnapshot(store.store)"));
    assert.doesNotMatch(source, /store\.get\(\)/);
  }
} finally {
  assert.ok(
    path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep),
  );
  assert.ok(path.basename(folder).startsWith("lampaua-store-upgrade-"));
  fs.rmSync(folder, { recursive: true, force: true });
}
console.log(
  "Electron 45, 64-bit targets, macOS cutoff and settings upgrade verified",
);
