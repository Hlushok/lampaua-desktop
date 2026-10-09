const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const YAML = require("yaml");

const root = path.resolve(__dirname, "..");
const workflow = YAML.parse(
  fs.readFileSync(path.join(root, ".github/workflows/build.yml"), "utf8"),
);
const steps = workflow.jobs["build-windows"].steps;
const preservation = steps.find(
  (step) => step.name === "Preserve pinned libmpv input",
).run;
const upload = steps.find(
  (step) => step.name === "Upload pinned runtime input",
);
assert.ok(upload.with.path.includes("dist/runtime-inputs/*.tar.gz.*"));
assert.ok(
  workflow.jobs.release.steps
    .find((step) => step.name === "Publish to GitHub Release")
    .with.files.includes("runtime-inputs/*.tar.gz.*"),
);
const digest = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const cacheRoot = path.join(root, ".cache");
fs.mkdirSync(cacheRoot, { recursive: true });

function verify({ legacy = false, failure = null } = {}) {
  const fixture = fs.mkdtempSync(
    path.join(cacheRoot, "libmpv-source-delivery-"),
  );
  assert.ok(fixture.startsWith(cacheRoot + path.sep));
  try {
    const cache = path.join(fixture, ".cache/mpv-prototype");
    fs.mkdirSync(cache, { recursive: true });
    fs.mkdirSync(path.join(fixture, "build"));
    const bytes = Buffer.from("complete corresponding source archive");
    const runtime = {
      asset: "own-sdk.7z",
      sourceAsset: "own-sources.tar.gz",
      sourceSha256: digest(bytes),
    };
    fs.writeFileSync(path.join(cache, "libmpv-sdk.7z"), "SDK fixture");
    fs.writeFileSync(path.join(cache, runtime.sourceAsset), bytes);
    if (!legacy) {
      runtime.sourceParts = [bytes.subarray(0, 12), bytes.subarray(12)].map(
        (part, index) => {
          const asset = `${runtime.sourceAsset}.${String(index + 1).padStart(3, "0")}`;
          fs.writeFileSync(path.join(cache, asset), part);
          return { asset, sha256: digest(part), size: part.length };
        },
      );
    }
    if (failure === "archive") runtime.sourceSha256 = "0".repeat(64);
    if (failure === "part") runtime.sourceParts[1].sha256 = "0".repeat(64);
    if (failure === "size") runtime.sourceParts[1].size++;
    fs.writeFileSync(
      path.join(fixture, "build/libmpv-runtime.json"),
      JSON.stringify(runtime),
    );
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        // A pwsh parent can expose its incompatible Utility module to Windows
        // PowerShell. Load the child's own module for this workflow test.
        `$ErrorActionPreference = 'Stop'\nImport-Module "$PSHOME/Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1"\n${preservation}`,
      ],
      { cwd: fixture, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    if (failure) {
      assert.notEqual(
        result.status,
        0,
        `${failure} mismatch must reject delivery`,
      );
      assert.match(
        result.stderr,
        /sources checksum mismatch|source part mismatch/,
      );
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    const delivered = path.join(fixture, "dist/runtime-inputs");
    assert.equal(
      fs.readFileSync(path.join(delivered, runtime.asset), "utf8"),
      "SDK fixture",
    );
    if (legacy) {
      assert.deepEqual(
        fs.readFileSync(path.join(delivered, runtime.sourceAsset)),
        bytes,
      );
    } else {
      assert.equal(
        fs.existsSync(path.join(delivered, runtime.sourceAsset)),
        false,
      );
      assert.deepEqual(
        Buffer.concat(
          runtime.sourceParts.map((part) =>
            fs.readFileSync(path.join(delivered, part.asset)),
          ),
        ),
        bytes,
      );
      assert.equal(fs.readdirSync(delivered).length, 3);
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

verify();
verify({ legacy: true });
for (const failure of ["archive", "part", "size"]) verify({ failure });
console.log(
  "Actual release workflow delivers verified source parts, rejects corruption and retains legacy delivery",
);
