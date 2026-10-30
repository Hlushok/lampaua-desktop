const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const root = path.resolve(__dirname, "..");
const apiVersion = (2 << 16) | 6;
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
function digest(file) {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(file, "r");
  try {
    let count;
    while ((count = fs.readSync(fd, buffer)) > 0)
      hash.update(buffer.subarray(0, count));
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}
function verifyPackage(sdk, artifacts, commit, variant = "d3d11") {
  assert.ok(
    ["d3d11", "d3d11-next"].includes(variant),
    "Unsupported SDK variant",
  );
  assert.match(
    commit ?? "",
    /^[a-f0-9]{40}$/,
    "Use the exact Actions build commit",
  );
  const config = JSON.parse(
    fs.readFileSync(
      path.join(root, `build/libmpv-source-build.${variant}.json`),
      "utf8",
    ),
  );
  const candidate = JSON.parse(
    fs.readFileSync(path.join(artifacts, "candidate-sdk.json"), "utf8"),
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(artifacts, "manifest.json"), "utf8"),
  );
  assert.equal(
    candidate.clientApiVersion,
    apiVersion,
    "Candidate requires client API 2.6",
  );
  assert.equal(candidate.repositoryCommit, commit);
  assert.equal(candidate.baseRevision, config.mpvCommit);
  assert.deepEqual(candidate.patches, config.sourcePatches.mpv);
  if (config.nativeD3d11) {
    assert.equal(candidate.nativeD3d11, true);
    assert.equal(manifest.nativeD3d11, true);
    assert.deepEqual(candidate.patches, []);
  }
  assert.match(candidate.effectiveTreeSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.configuration, config);
  for (const name of [
    "dllSha256",
    "clientApiVersion",
    "repositoryCommit",
    "baseRevision",
    "patches",
    "effectiveTreeSha256",
  ])
    assert.deepEqual(candidate[name], manifest[name]);
  assert.equal(candidate.sdkFile, "lampaua-libmpv-x64-sdk.7z");
  assert.equal(candidate.sourceFile, "lampaua-libmpv-x64-sources.tar.gz");
  for (const [file, hash] of [
    [path.join(sdk, "libmpv-2.dll"), candidate.dllSha256],
    [path.join(artifacts, candidate.sdkFile), candidate.sdkSha256],
    [path.join(artifacts, candidate.sourceFile), candidate.sourceSha256],
  ]) {
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(
      digest(file),
      hash,
      `Changed candidate file: ${path.basename(file)}`,
    );
  }
  return candidate;
}
function unit() {
  const fixtures = path.join(root, ".cache/libmpv-d3d11-native-fixtures");
  fs.mkdirSync(fixtures, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(fixtures, "metadata-"));
  const sdk = path.join(fixture, "sdk");
  const artifacts = path.join(fixture, "artifacts");
  fs.mkdirSync(sdk);
  fs.mkdirSync(artifacts);
  const config = JSON.parse(
    fs.readFileSync(
      path.join(root, "build/libmpv-source-build.d3d11.json"),
      "utf8",
    ),
  );
  const dll = path.join(sdk, "libmpv-2.dll");
  const sdkFile = "lampaua-libmpv-x64-sdk.7z";
  const sourceFile = "lampaua-libmpv-x64-sources.tar.gz";
  for (const file of [
    dll,
    path.join(artifacts, sdkFile),
    path.join(artifacts, sourceFile),
  ])
    fs.writeFileSync(file, "metadata fixture, not a runtime");
  const commit = "b".repeat(40);
  const candidate = {
    clientApiVersion: apiVersion,
    repositoryCommit: commit,
    baseRevision: config.mpvCommit,
    patches: config.sourcePatches.mpv,
    effectiveTreeSha256: "e".repeat(64),
    dllSha256: digest(dll),
    sdkFile,
    sdkSha256: digest(path.join(artifacts, sdkFile)),
    sourceFile,
    sourceSha256: digest(path.join(artifacts, sourceFile)),
  };
  fs.writeFileSync(
    path.join(artifacts, "manifest.json"),
    JSON.stringify({ ...candidate, configuration: config }),
  );
  const write = (value) =>
    fs.writeFileSync(
      path.join(artifacts, "candidate-sdk.json"),
      JSON.stringify(value),
    );
  write(candidate);
  assert.deepEqual(verifyPackage(sdk, artifacts, commit), candidate);
  assert.throws(() => verifyPackage(sdk, artifacts, commit, "../baseline"));
  for (const change of [
    (value) => {
      value.clientApiVersion--;
    },
    (value) => {
      value.repositoryCommit = "c".repeat(40);
    },
    (value) => {
      value.baseRevision = "a".repeat(40);
    },
    (value) => {
      value.patches[0].sha256 = "f".repeat(64);
    },
    (value) => {
      delete value.effectiveTreeSha256;
    },
    (value) => {
      value.sdkFile = "../other.7z";
    },
    (value) => {
      value.sourceSha256 = "0".repeat(64);
    },
  ]) {
    const invalid = structuredClone(candidate);
    change(invalid);
    write(invalid);
    assert.throws(() => verifyPackage(sdk, artifacts, commit));
  }
  write(candidate);
  for (const file of [
    dll,
    path.join(artifacts, sdkFile),
    path.join(artifacts, sourceFile),
  ]) {
    const original = fs.readFileSync(file);
    fs.appendFileSync(file, "changed");
    assert.throws(() => verifyPackage(sdk, artifacts, commit));
    fs.writeFileSync(file, original);
  }
  assert.deepEqual(verifyPackage(sdk, artifacts, commit), candidate);
  const nextConfig = JSON.parse(
    fs.readFileSync(
      path.join(root, "build/libmpv-source-build.d3d11-next.json"),
      "utf8",
    ),
  );
  const next = {
    ...candidate,
    baseRevision: nextConfig.mpvCommit,
    patches: [],
    nativeD3d11: true,
  };
  fs.writeFileSync(
    path.join(artifacts, "manifest.json"),
    JSON.stringify({ ...next, configuration: nextConfig }),
  );
  write(next);
  assert.deepEqual(verifyPackage(sdk, artifacts, commit, "d3d11-next"), next);
  delete next.nativeD3d11;
  write(next);
  assert.throws(() => verifyPackage(sdk, artifacts, commit, "d3d11-next"));
  console.log(
    "Candidate metadata unit tests passed; this is not DLL/context acceptance",
  );
}
async function child() {
  const native = require(path.resolve(option("--addon")));
  assert.equal(
    typeof native.probeD3d11Context,
    "function",
    "Native D3D11 context probe is not implemented",
  );
  const before = native.getD3d11TestResources();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await wait(20);
  let last = performance.now();
  let maxGapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
  }, 5);
  const probes = [];
  const rejectedApis = [];
  try {
    for (let index = 0; index < 5; index++) {
      if (process.argv.includes("--expect-api-rejection")) {
        await assert.rejects(native.probeD3d11Context(), (error) => {
          rejectedApis.push(error.apiVersion);
          return (
            error.code === "MPV_D3D11_API" &&
            error.apiVersion === ((2 << 16) | 5)
          );
        });
      } else {
        const result = await native.probeD3d11Context();
        assert.equal(result.apiVersion, apiVersion);
        assert.equal(result.backend, "d3d11");
        assert.equal(result.hardware, true);
        assert.match(result.adapterLuid, /^[a-f0-9]+:[a-f0-9]+$/);
        assert.equal(result.renderThread, true);
        probes.push(result);
      }
      assert.deepEqual(native.getD3d11TestResources(), before);
      global.gc?.();
    }
    await wait(20);
  } finally {
    clearInterval(timer);
  }
  assert.ok(
    maxGapMs < 100,
    `Native context probe blocked the main thread: ${maxGapMs}ms`,
  );
  console.log(
    JSON.stringify(
      {
        probes,
        rejectedApis,
        rejectedOldApi: process.argv.includes("--expect-api-rejection"),
        maxGapMs,
        resourcesAfterClose: native.getD3d11TestResources(),
      },
      null,
      2,
    ),
  );
}
async function main() {
  if (process.argv.includes("--unit")) {
    unit();
    return;
  }
  if (process.argv.includes("--child")) {
    if (process.argv.includes("--player-tests"))
      await require("./mpv/d3d11-player-tests.cjs")(
        require(path.resolve(option("--addon"))),
      );
    else await child();
    return;
  }
  assert.ok(
    process.argv.includes("--context-only") ||
      process.argv.includes("--player-tests"),
    "Select --context-only or --player-tests",
  );
  const sdk = path.resolve(option("--sdk"));
  if (!process.argv.includes("--expect-api-rejection"))
    verifyPackage(
      sdk,
      path.resolve(option("--artifact", path.join(sdk, "../artifacts"))),
      option("--build-commit"),
      option("--variant", "d3d11"),
    );
  const electron = path.resolve(
    option("--electron", "node_modules/electron/dist/electron.exe"),
  );
  const args = [
    "--expose-gc",
    __filename,
    "--child",
    "--addon",
    path.resolve(option("--addon")),
    ...[
      "--player-tests",
      "--player-smoke",
      "--player-lifecycle-only",
      "--production-only",
    ].filter((name) => process.argv.includes(name)),
    ...(process.argv.includes("--expect-api-rejection")
      ? ["--expect-api-rejection"]
      : []),
  ];
  const result = spawnSync(electron, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: process.argv.includes("--player-tests") ? 180000 : 60000,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PATH: [sdk, "C:/Windows/System32", "C:/Windows"].join(path.delimiter),
    },
  });
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, "D3D11 native context verification failed");
}
module.exports = { verifyPackage, digest };
if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
