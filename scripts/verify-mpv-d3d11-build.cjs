const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

function verify(workflow) {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(inputs.variant.options, ["baseline", "d3d11"]);
  assert.equal(inputs.variant.default, "baseline");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const job = workflow.jobs.build;
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job["timeout-minutes"], 360);
  assert.equal(
    job.container.image,
    "ghcr.io/shinchiro/archlinux@sha256:2b81f07c567b051455b9539770a71b53dd3add5f9ef52eca95ac01a2272e9fdf",
  );
  assert.equal(job.env.LAMPAUA_MPV_VARIANT, "${{ inputs.variant }}");
  assert.equal(
    job.env.MPV_WORK,
    "${{ inputs.variant == 'd3d11' && '.cache/libmpv-own-d3d11' || '.cache/libmpv-own' }}",
  );
  assert.equal(
    job.env.MPV_OUTPUT,
    "${{ inputs.variant == 'd3d11' && 'dist/libmpv-own-d3d11' || 'dist/libmpv-own' }}",
  );
  const checkout = job.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkout.with["persist-credentials"], false);
  const commands = job.steps
    .filter((step) => step.run)
    .map((step) => step.run)
    .join("\n");
  assert.match(
    commands,
    /python3 -m unittest discover -s scripts\/mpv -p ['"]test_\*\.py['"]/,
  );
  assert.doesNotMatch(
    commands,
    /gh release|git push|release:|--publish|curl.*(?:upload|releases)/,
  );
  for (const phase of ["inputs", "compile"]) {
    const step = job.steps.find(
      (item) => item.env?.LAMPAUA_MPV_PHASE === phase,
    );
    assert.equal(step.env.LAMPAUA_MPV_TARGET, "${{ inputs.target }}");
    assert.equal(
      step.env.LAMPAUA_MPV_VARIANT,
      undefined,
      "Variant must not override the job selection",
    );
    assert.match(step.run, /bash scripts\/mpv\/build-libmpv\.sh/);
  }
  const uploads = job.steps.filter((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  assert.equal(uploads.length, 3);
  const sdk = uploads.find((step) => step.with["retention-days"] === 30);
  assert.equal(
    sdk.with.name,
    "${{ inputs.variant == 'd3d11' && 'lampaua-libmpv-own-x64-d3d11' || 'lampaua-libmpv-own-x64' }}",
  );
  assert.equal(sdk.with.path, "${{ env.MPV_OUTPUT }}/");
  assert.equal(sdk.if, "inputs.target == 'mpv'");
  for (const upload of uploads.filter((step) => step !== sdk)) {
    assert.match(upload.with.path, /\$\{\{ env\.MPV_WORK \}\}/);
    assert.doesNotMatch(upload.with.path, /\.cache\/libmpv-own\//);
  }
  const recovery = uploads.find((step) => step.if.startsWith("failure()"));
  assert.match(
    recovery.if,
    /hashFiles\(format\('\{0\}\/build\/mpv-dev-x86_64-\*\/libmpv-2.dll', env.MPV_WORK\)\)/,
  );
  for (const step of job.steps.filter((item) => item.uses))
    assert.match(step.uses, /^actions\/(?:checkout|upload-artifact)@v6$/);
}

const root = path.resolve(__dirname, "..");
const doc = YAML.parseDocument(
  fs.readFileSync(
    path.join(root, ".github/workflows/build-libmpv.yml"),
    "utf8",
  ),
  { uniqueKeys: true },
);
assert.deepEqual(doc.errors, []);
const workflow = doc.toJS();
verify(workflow);
const wrong = structuredClone(workflow);
wrong.on.workflow_dispatch.inputs.variant.default = "d3d11";
assert.throws(() => verify(wrong));
const publication = structuredClone(workflow);
publication.permissions.contents = "write";
assert.throws(() => verify(publication));
console.log(
  "D3D11 workflow contract passed: isolated variant, pinned tools, artifacts only",
);
