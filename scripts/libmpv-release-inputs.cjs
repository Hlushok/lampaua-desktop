const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function verifyProvenance(runtime, inventory, receipt, config, lock) {
  assert.ok(["d3d11", "d3d11-next"].includes(runtime.sourceVariant));
  for (const [field, accepted] of Object.entries({
    sha256: "sdkSha256",
    dllSha256: "dllSha256",
    sourceBuildCommit: "repositoryCommit",
    sourceSha256: "sourceSha256",
    effectiveTreeSha256: "effectiveTreeSha256",
    clientApiVersion: "clientApiVersion",
  }))
    assert.equal(runtime[field], receipt[accepted], field);
  assert.equal(runtime.clientApiVersion, 131078);
  for (const field of ["mpvCommit", "ffmpegCommit", "cpu"])
    assert.equal(runtime[field], config[field], field);
  assert.equal(runtime.cpu, "x86-64");
  assert.deepEqual(runtime.patches, config.sourcePatches.mpv);
  assert.equal(runtime.nativeD3d11 === true, config.nativeD3d11 === true);
  assert.equal(inventory.nativeD3d11 === true, config.nativeD3d11 === true);
  assert.equal(inventory.sourceVariant, runtime.sourceVariant);
  assert.equal(inventory.baseRevision, runtime.mpvCommit);
  assert.equal(inventory.effectiveTreeSha256, runtime.effectiveTreeSha256);
  assert.deepEqual(inventory.patches, runtime.patches);
  assert.equal(inventory.dllSha256, runtime.dllSha256);
  assert.equal(inventory.repositoryCommit, runtime.sourceBuildCommit);
  assert.equal(inventory.pinnedInputs, Object.keys(lock.components).length);
  if (config.nativeD3d11) assert.deepEqual(runtime.patches, []);
}

function verifyReleaseInputs(root = path.resolve(__dirname, "..")) {
  const read = (name) =>
    JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
  const runtime = read("build/libmpv-runtime.json");
  assert.ok(["d3d11", "d3d11-next"].includes(runtime.sourceVariant));
  const variant = runtime.sourceVariant;
  const config = read(`build/libmpv-source-build.${variant}.json`);
  assert.match(
    config.sourceLock,
    /^libmpv-source-lock(?:\.d3d11-next)?\.json$/,
  );
  const receipt = read(`build/libmpv-${variant}-test.json`);
  const inventoryFile = path.join(root, "licenses/libmpv/inventory.json");
  const bytes = fs.readFileSync(inventoryFile);
  const inventory = JSON.parse(bytes);
  assert.equal(
    crypto.createHash("sha256").update(bytes).digest("hex"),
    receipt.noticesInventorySha256,
    "Release notices must match the source-audited receipt",
  );
  verifyProvenance(
    runtime,
    inventory,
    receipt,
    config,
    read(`build/${config.sourceLock}`),
  );
  return runtime;
}

module.exports = { verifyProvenance, verifyReleaseInputs };
