const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const d3d11Next = process.argv.includes("--d3d11-next");
assert.equal(
  d3d11Next && process.argv.includes("--d3d11"),
  false,
  "Select one D3D11 candidate variant",
);
const d3d11 = process.argv.includes("--d3d11") || d3d11Next;
const release = process.argv.includes("--release");
assert.equal(d3d11 && release, false, "D3D11 candidate cannot be a release");
const descriptor = path.join(
  root,
  d3d11Next
    ? ".cache/mpv-desktop-d3d11-next-test/stage-latest.json"
    : d3d11
      ? ".cache/mpv-desktop-d3d11-test/stage-latest.json"
      : ".cache/mpv-desktop-test/stage-latest.json",
);
assert.ok(
  fs.existsSync(descriptor),
  "Full desktop MPV staging has not been created",
);
const { stage } = JSON.parse(fs.readFileSync(descriptor));
const pkg = JSON.parse(fs.readFileSync(path.join(stage, "package.json")));
assert.equal(pkg.lampauaMpvD3d11Test === true, d3d11);
assert.equal(pkg.lampauaMpvD3d11NextTest === true, d3d11Next);
const productionMpv = require("../build/libmpv-runtime.json");
assert.equal(
  pkg.lampauaMpvD3d11 === true,
  release && ["d3d11", "d3d11-next"].includes(productionMpv.sourceVariant),
);
assert.equal(pkg.main, release ? "src/main.js" : "src/mpv-test-main.js");
assert.equal(
  pkg.version,
  release
    ? require("../package.json").version
    : `${require("../package.json").version}-mpv-test.1`,
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
const productionRuntime = require("../build/electron-runtime-windows-x64.json");
if (release) {
  assert.deepEqual(manifest.mpvSource, productionMpv);
  assert.equal(manifest.sdkSha256, productionMpv.sha256);
  assert.equal(manifest.candidateD3d11, undefined);
  assert.equal(
    crypto
      .createHash("sha256")
      .update(
        fs.readFileSync(
          path.join(stage, "src/mpv-runtime/native/libmpv-2.dll"),
        ),
      )
      .digest("hex"),
    productionMpv.dllSha256,
  );
}
if (d3d11) {
  const accepted = require(
    d3d11Next
      ? "../build/libmpv-d3d11-next-test.json"
      : "../build/libmpv-d3d11-test.json",
  );
  if (d3d11Next) {
    assert.equal(manifest.candidateVariant, "d3d11-next");
    assert.equal(manifest.mpvSource.nativeD3d11, true);
    assert.deepEqual(manifest.mpvSource.patches, []);
    assert.equal(
      fs.existsSync(
        path.join(
          stage,
          "src/mpv-runtime/candidate/4255130-d3d11-render.patch",
        ),
      ),
      false,
    );
  }
  assert.equal(manifest.candidateD3d11, true);
  for (const key of [
    "repositoryCommit",
    "clientApiVersion",
    "dllSha256",
    "sdkSha256",
    "sourceSha256",
    "effectiveTreeSha256",
  ])
    assert.equal(manifest.mpvSource[key], accepted[key], key);
  assert.equal(
    crypto
      .createHash("sha256")
      .update(
        fs.readFileSync(
          path.join(stage, "src/mpv-runtime/native/libmpv-2.dll"),
        ),
      )
      .digest("hex"),
    accepted.dllSha256,
  );
  assert.equal(
    crypto
      .createHash("sha256")
      .update(
        fs.readFileSync(
          path.join(stage, "src/mpv-runtime/libmpv-notices/inventory.json"),
        ),
      )
      .digest("hex"),
    accepted.noticesInventorySha256,
  );
}
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
