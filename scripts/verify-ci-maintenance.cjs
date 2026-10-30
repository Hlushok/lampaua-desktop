const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

function verifyPreservation(workflow) {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.variant.options, [
    "baseline",
    "d3d11",
    "d3d11-next",
  ]);
  assert.equal(workflow.on.workflow_dispatch.inputs.variant.default, "d3d11");
  assert.deepEqual(workflow.permissions, {
    actions: "read",
    contents: "write",
  });
  const job = workflow.jobs.preserve;
  assert.equal(job.env.VARIANT, "${{ inputs.variant }}");
  const download = job.steps.find((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  assert.equal(
    download.with.name,
    "${{ inputs.variant == 'd3d11-next' && 'lampaua-libmpv-own-x64-d3d11-next' || inputs.variant == 'd3d11' && 'lampaua-libmpv-own-x64-d3d11' || 'lampaua-libmpv-own-x64' }}",
  );
  assert.equal(download.with["run-id"], "${{ inputs.source_run }}");
  assert.equal(download.with.repository, "Hlushok/lampaua-desktop");
  assert.equal(download.with["digest-mismatch"], "error");
  const verifyRun = job.steps.find((step) =>
    step.run?.includes("source-run.json"),
  );
  assert.ok(job.steps.indexOf(verifyRun) < job.steps.indexOf(download));
  assert.match(verifyRun.run, /run\['status'\] == 'completed'/);
  assert.match(verifyRun.run, /run\['conclusion'\] == 'success'/);
  assert.match(
    verifyRun.run,
    /run\['head_sha'\] == os\.environ\['SOURCE_COMMIT'\]/,
  );
  assert.match(
    verifyRun.run,
    /run\['path'\] == '\.github\/workflows\/build-libmpv\.yml'/,
  );
  assert.match(verifyRun.run, /--json isDraft --jq \.isDraft\)" == true/);
  const commands = job.steps.map((step) => step.run || "").join("\n");
  assert.match(commands, /file_digest\(stream, 'sha256'\)/);
  assert.match(commands, /bundle\.extractall\(destination, filter='data'\)/);
  assert.match(
    commands,
    /audit_runtime_sources\.py\s+\\\s+--variant "\$VARIANT"/,
  );
  assert.match(
    commands,
    /--previous-inventory licenses\/libmpv\/inventory\.json/,
  );
  assert.match(commands, /len\(parts\['sourceParts'\]\) == 2/);
  assert.doesNotMatch(
    commands,
    /gh release (?:create|edit|delete)|git push|--clobber|--publish|build-libmpv\.sh/,
  );
  const upload = job.steps.find((step) =>
    step.run?.includes("gh release upload"),
  );
  assert.match(upload.run, /for file in/);
  assert.match(upload.run, /--json isDraft --jq \.isDraft\)" == true/);
  assert.ok(
    upload.run.indexOf("--json isDraft") <
      upload.run.indexOf("gh release upload"),
  );
}

const root = path.resolve(__dirname, "..");
const versions = {
  "actions/checkout": "v7.0.1",
  "actions/setup-node": "v7.1.0",
  "actions/setup-python": "v7.1.0",
  "actions/upload-artifact": "v7.0.2",
  "actions/download-artifact": "v8.0.2",
  "softprops/action-gh-release": "v3.0.3",
};
const workflows = new Map();
for (const name of fs.readdirSync(path.join(root, ".github/workflows"))) {
  if (!name.endsWith(".yml")) continue;
  const document = YAML.parseDocument(
    fs.readFileSync(path.join(root, ".github/workflows", name), "utf8"),
    { uniqueKeys: true },
  );
  assert.deepEqual(document.errors, [], name);
  const workflow = document.toJS();
  workflows.set(name, workflow);
  for (const job of Object.values(workflow.jobs))
    for (const step of job.steps || []) {
      if (!step.uses) continue;
      const [action, version] = step.uses.split("@");
      assert.equal(
        version,
        versions[action],
        `${name}: unreviewed action ${step.uses}`,
      );
      if (action === "actions/setup-node")
        assert.equal(step.with["node-version"], "24");
      if (action === "actions/download-artifact")
        assert.equal(step.with?.["digest-mismatch"], "error");
      if (action === "actions/upload-artifact")
        assert.notEqual(
          step.with?.archive,
          false,
          "Preserve multi-file archive artifacts",
        );
    }
}
for (const name of ["build.yml", "validate.yml", "sync-upstream.yml"]) {
  const commands = Object.values(workflows.get(name).jobs)
    .flatMap((job) => (job.steps || []).map((step) => step.run || ""))
    .join("\n");
  assert.match(
    commands,
    /yarn test/,
    `${name}: missing donor/navigation tests`,
  );
  assert.match(
    commands,
    /yarn audit:production/,
    `${name}: missing production security gate`,
  );
  assert.match(
    commands,
    /verify-ci-maintenance\.cjs/,
    `${name}: missing workflow regression gate`,
  );
}
const pkg = require("../package.json");
const dependabot = YAML.parse(
  fs.readFileSync(path.join(root, ".github/dependabot.yml"), "utf8"),
);
assert.equal(
  dependabot.updates.find(
    (item) => item["package-ecosystem"] === "github-actions",
  ).ignore,
  undefined,
  "Major CI updates must be proposed for review, not silently hidden",
);
assert.equal(
  pkg.scripts["audit:production"],
  "yarn npm audit --all --recursive --environment production --no-deprecations",
);
assert.equal(pkg.devDependencies.electron, "45.0.0");
assert.equal(workflows.get("build-libmpv.yml").permissions.contents, "read");
const preservation = workflows.get("preserve-libmpv.yml");
verifyPreservation(preservation);
for (const mutate of [
  (workflow) => {
    workflow.on.workflow_dispatch.inputs.variant.options.pop();
  },
  (workflow) => {
    workflow.jobs.preserve.steps.find((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    ).with.name = "lampaua-libmpv-own-x64-d3d11";
  },
  (workflow) => {
    workflow.jobs.preserve.steps.find((step) =>
      step.run?.includes("gh release upload"),
    ).run = 'gh release upload "$TARGET_TAG" file';
  },
  (workflow) => {
    workflow.jobs.preserve.steps.push({
      run: 'gh release edit "$TARGET_TAG" --draft=false',
    });
  },
]) {
  const unsafe = structuredClone(preservation);
  mutate(unsafe);
  assert.throws(() => verifyPreservation(unsafe));
}
console.log(
  "Reviewed CI actions, Node 24, artifact integrity, draft-only source preservation and production audit gates verified",
);
