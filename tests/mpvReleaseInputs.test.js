const assert = require("node:assert/strict");
const test = require("node:test");
const {
  verifyProvenance,
  verifyReleaseInputs,
} = require("../scripts/libmpv-release-inputs.cjs");

function fixture(variant) {
  const config = require(`../build/libmpv-source-build.${variant}.json`);
  const receipt = require(`../build/libmpv-${variant}-test.json`);
  const lock = require(`../build/${config.sourceLock}`);
  const runtime = {
    sourceVariant: variant,
    sha256: receipt.sdkSha256,
    dllSha256: receipt.dllSha256,
    sourceBuildCommit: receipt.repositoryCommit,
    sourceSha256: receipt.sourceSha256,
    effectiveTreeSha256: receipt.effectiveTreeSha256,
    clientApiVersion: receipt.clientApiVersion,
    mpvCommit: config.mpvCommit,
    ffmpegCommit: config.ffmpegCommit,
    cpu: config.cpu,
    patches: config.sourcePatches.mpv,
    ...(config.nativeD3d11 ? { nativeD3d11: true } : {}),
  };
  const inventory = {
    sourceVariant: variant,
    repositoryCommit: runtime.sourceBuildCommit,
    dllSha256: runtime.dllSha256,
    baseRevision: runtime.mpvCommit,
    effectiveTreeSha256: runtime.effectiveTreeSha256,
    patches: runtime.patches,
    pinnedInputs: Object.keys(lock.components).length,
    ...(config.nativeD3d11 ? { nativeD3d11: true } : {}),
  };
  return { runtime, inventory, receipt, config, lock };
}

test("production MPV inputs match their exact audited receipt", () => {
  assert.equal(verifyReleaseInputs().repository, "Hlushok/lampaua-desktop");
});
for (const variant of ["d3d11", "d3d11-next"]) {
  test(`accepts exact ${variant} provenance without rewriting historical pins`, () => {
    const f = fixture(variant);
    verifyProvenance(f.runtime, f.inventory, f.receipt, f.config, f.lock);
  });
  for (const [name, mutate] of [
    [
      "wrong DLL",
      (f) => {
        f.runtime.dllSha256 = "0".repeat(64);
      },
    ],
    [
      "wrong build",
      (f) => {
        f.runtime.sourceBuildCommit = "0".repeat(40);
      },
    ],
    [
      "missing native provenance",
      (f) => {
        f.runtime.nativeD3d11 = !f.config.nativeD3d11;
      },
    ],
    [
      "wrong notices",
      (f) => {
        f.inventory.sourceVariant = "baseline";
      },
    ],
    [
      "wrong patches",
      (f) => {
        f.runtime.patches = [{ file: "unreviewed.patch" }];
      },
    ],
    [
      "unsupported variant",
      (f) => {
        f.runtime.sourceVariant = "../unknown";
      },
    ],
    [
      "wrong FFmpeg",
      (f) => {
        f.runtime.ffmpegCommit = "0".repeat(40);
      },
    ],
  ]) {
    test(`${variant} rejects ${name}`, () => {
      const f = structuredClone(fixture(variant));
      mutate(f);
      assert.throws(() =>
        verifyProvenance(f.runtime, f.inventory, f.receipt, f.config, f.lock),
      );
    });
  }
}
