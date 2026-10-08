const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const descriptor = path.join(root, ".cache/mpv-desktop-test/stage-latest.json");
assert.ok(
  fs.existsSync(descriptor),
  "Full desktop MPV staging has not been created",
);
const { stage } = JSON.parse(fs.readFileSync(descriptor));
const pkg = JSON.parse(fs.readFileSync(path.join(stage, "package.json")));
const release = process.argv.includes("--release");
assert.equal(pkg.main, release ? "src/main.js" : "src/mpv-test-main.js");
assert.equal(
  pkg.version,
  release ? require("../package.json").version : "1.5.24-mpv.6",
);
assert.equal(pkg.lampauaMpvTest, !release);
assert.equal(pkg.lampauaMpv, true);
if (release) {
  assert.equal(pkg.name, "lampaua-desktop");
  assert.equal(pkg.productName, "LampaUa");
  assert.equal(pkg.license, "GPL-3.0-or-later");
}
assert.equal(pkg.build, undefined);
for (const file of [
  "src/main.js",
  "src/plugin.js",
  "src/modules/torrServerManager.js",
  "assets/win.ico",
  "src/mpv-runtime/renderer.js",
  "src/mpv-runtime/native/mpv_addon.node",
  "src/mpv-runtime/native/libmpv-2.dll",
])
  assert.ok(fs.statSync(path.join(stage, file)).size > 0, file);
const { createRequire } = require("node:module");
const resolve = createRequire(path.join(stage, "package.json"));
for (const name of Object.keys(pkg.dependencies))
  assert.ok(resolve.resolve(name).startsWith(stage), name);
const manifest = JSON.parse(
  fs.readFileSync(path.join(stage, "build-manifest.json")),
);
const productionRuntime = require("../build/electron-runtime-ac3-eac3.json");
assert.equal(manifest.electron, productionRuntime.version);
assert.equal(manifest.electronArchiveSha256, productionRuntime.sha256);
assert.equal(
  manifest.electronInputs["ffmpeg.dll"],
  productionRuntime.ffmpegSha256,
);
for (const [file, expected] of Object.entries(manifest.hashes))
  assert.equal(
    crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(stage, file)))
      .digest("hex"),
    expected,
    file,
  );
console.log("Full desktop MPV staging verified", stage);
