const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
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
console.log(
  "Reviewed CI actions, Node 24, artifact integrity and production audit gates verified",
);
