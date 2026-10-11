const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const yaml = require("yaml");
const {
  syncUpstream,
  sameJavascript,
  onlyVersionChanged,
} = require("./sync-upstream.cjs");
const policy = require("../build/upstream-sync-policy.json");
const cache = path.resolve(__dirname, "../.cache");
fs.mkdirSync(cache, { recursive: true });
const root = fs.mkdtempSync(path.join(cache, "upstream-sync-contract-"));
let counter = 0;

function fixture({
  plugin = "function launch() {\n  return 'base';\n}\n",
  packageExtra = {},
  unknownConflict = false,
  newFile = false,
  licenseChange = false,
} = {}) {
  const cwd = path.join(root, String(counter++));
  fs.mkdirSync(cwd);
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  const write = (file, source) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), source);
  };
  const pkg = (value) => JSON.stringify(value, null, 2) + "\n";
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Sync contract fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  git("config", "core.hooksPath", ".git/hooks");
  const basePackage = { name: "donor", version: "1.0.0", dependencies: {} };
  write("README.md", "Base documentation\n");
  write("CHANGELOG.md", "Base history\n");
  write("package.json", pkg(basePackage));
  write("scripts/generate-icons.js", "console.log('old icons');\n");
  write("src/plugin.js", 'function launch() { return "base"; }\n');
  write("src/modules/torrServerManager.js", "const enabled = true;\n");
  write("src/unowned.js", "const value = 'base';\n");
  write("LICENSE", "Original license\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("branch", "donor");
  write("README.md", "LampaUa documentation\n");
  write("CHANGELOG.md", "LampaUa 2.x history\n");
  write(
    "package.json",
    pkg({ ...basePackage, name: "lampaua", version: "2.0.0" }),
  );
  write("src/plugin.js", 'function launch() { return "fork-mpv"; }\n');
  write("src/modules/torrServerManager.js", "const enabled = false;\n");
  if (unknownConflict) write("src/unowned.js", "const value = 'fork';\n");
  git("rm", "-q", "scripts/generate-icons.js");
  git("add", ".");
  git("commit", "-qm", "fork");
  const ours = git("rev-parse", "HEAD").trim();
  git("switch", "-q", "donor");
  write("README.md", "Donor-only payment information\n");
  write("CHANGELOG.md", "Donor 1.x release\n");
  write(
    "package.json",
    pkg({ ...basePackage, version: "1.0.1", ...packageExtra }),
  );
  write("scripts/generate-icons.js", "console.log(\n  'old icons',\n);\n");
  write("src/plugin.js", plugin);
  write("src/modules/torrServerManager.js", "const enabled =\n  true;\n");
  if (unknownConflict) write("src/unowned.js", "const value = 'donor';\n");
  if (newFile) write("src/new-upstream.js", "const donor = true;\n");
  if (licenseChange) write("LICENSE", "Changed license\n");
  git("add", ".");
  git("commit", "-qm", "upstream");
  git("switch", "-q", "main");
  return {
    cwd,
    ours,
    git,
    write,
    read: (file) => fs.readFileSync(path.join(cwd, file), "utf8"),
    run: () => syncUpstream({ cwd, ref: "donor" }),
  };
}

try {
  assert.ok(sameJavascript('const a = "x";', "const a='x'\n"));
  assert.ok(sameJavascript("const a=0x10;", "const a = 16;"));
  assert.ok(sameJavascript("const a=1n;", "const a = 1n;"));
  assert.ok(
    sameJavascript('"use strict"; const a=1;', "'use strict'; const a = 1;"),
  );
  assert.ok(!sameJavascript('"use strict";', '"use\\x20strict";'));
  assert.ok(!sameJavascript("const a=1;", "const a=2;"));
  assert.ok(!sameJavascript("const a=/x/i;", "const a=/x/g;"));
  assert.ok(
    !sameJavascript("const a=String.raw`\\u0061`;", "const a=String.raw`a`;"),
  );
  assert.ok(
    !sameJavascript("function a(){return 1;}", "function a(){return\n1;}"),
  );
  assert.ok(!sameJavascript("const a=1;", "invalid javascript !!!"));
  assert.ok(
    !sameJavascript(
      "// copyright old\nconst a=1;",
      "// copyright new\nconst a=1;",
    ),
  );
  assert.ok(
    sameJavascript(
      "const a=1;",
      "// eslint-disable-next-line no-unused-vars\nconst a=1;",
      policy.ignoredFormatComments,
    ),
  );
  assert.ok(
    !sameJavascript(
      "const a=1;",
      "// eslint-disable-next-line no-eval\nconst a=1;",
      policy.ignoredFormatComments,
    ),
  );
  assert.ok(
    onlyVersionChanged(
      '{"version":"1","name":"x"}',
      '{"name":"x","version":"2"}',
    ),
  );
  assert.ok(
    !onlyVersionChanged(
      '{"version":"1","name":"x"}',
      '{"version":"2","name":"y"}',
    ),
  );
  assert.ok(!onlyVersionChanged("not-json", '{"version":"2"}'));

  const workflow = yaml.parse(
    fs.readFileSync(
      path.resolve(__dirname, "../.github/workflows/sync-upstream.yml"),
      "utf8",
    ),
  );
  const steps = workflow.jobs.sync.steps;
  const stepIndex = (name) => steps.findIndex((step) => step.name === name);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.sync["runs-on"], "windows-latest");
  assert.equal(workflow.jobs.sync.defaults.run.shell, "bash");
  assert.equal(
    steps[stepIndex("Verify pinned libmpv input contract")].shell,
    "pwsh",
  );
  assert.ok(
    stepIndex("Install fork dependencies for sync rules") <
      stepIndex("Merge upstream with bounded fork rules"),
  );
  assert.ok(
    stepIndex("Validate merged fork before pushing") <
      stepIndex("Commit validated merge"),
  );
  assert.ok(
    stepIndex("Verify pinned libmpv input contract") <
      stepIndex("Commit validated merge"),
  );
  assert.ok(
    stepIndex("Commit validated merge") < stepIndex("Push updated fork"),
  );
  assert.equal(
    steps[stepIndex("Merge upstream with bounded fork rules")].run,
    "node scripts/sync-upstream.cjs",
  );
  const commands = steps
    .map((step) => step.run || "")
    .join("\n")
    .replace(/\\\r?\n\s*/g, " ");
  const issues = [
    ...commands.matchAll(/\bgh issue (?:list|comment|close|create)\b[^\n]*/g),
  ];
  assert.equal(issues.length, 6);
  for (const [command] of issues)
    assert.ok(command.includes('--repo "$GITHUB_REPOSITORY"'));
  assert.equal(
    steps[stepIndex("Preserve sync diagnostic report")].if,
    "always()",
  );

  const safe = fixture({
    plugin:
      "// eslint-disable-next-line no-unused-vars\nfunction launch() {\n  return 'base';\n}\n",
  });
  safe.write("user-notes.txt", "Keep this untracked file\n");
  const result = safe.run();
  assert.equal(result.error, undefined);
  assert.deepEqual(result.manualReview, []);
  assert.equal(result.mergePending, true);
  assert.equal(safe.git("rev-parse", "HEAD").trim(), safe.ours);
  assert.equal(safe.git("ls-files", "-u"), "");
  assert.equal(safe.read("README.md"), "LampaUa documentation\n");
  assert.equal(safe.read("CHANGELOG.md"), "LampaUa 2.x history\n");
  assert.equal(JSON.parse(safe.read("package.json")).version, "2.0.0");
  assert.equal(JSON.parse(safe.read("package.json")).name, "lampaua");
  assert.equal(
    safe.read("src/plugin.js"),
    'function launch() { return "fork-mpv"; }\n',
  );
  assert.equal(
    safe.read("src/modules/torrServerManager.js"),
    "const enabled = false;\n",
  );
  assert.ok(!fs.existsSync(path.join(safe.cwd, "scripts/generate-icons.js")));
  assert.equal(safe.read("user-notes.txt"), "Keep this untracked file\n");
  safe.git("commit", "-qm", "verified merge");
  assert.equal(safe.run().upToDate, true);
  assert.equal(safe.git("status", "--porcelain", "--untracked-files=no"), "");

  for (const options of [
    { plugin: "function launch(){return 'new-behavior';}\n" },
    { plugin: "// copyright changed\nfunction launch(){return 'base';}\n" },
    { plugin: "invalid javascript !!!\n" },
  ]) {
    const repo = fixture(options);
    assert.ok(repo.run().manualReview.includes("src/plugin.js"));
    assert.equal(repo.git("rev-parse", "HEAD").trim(), repo.ours);
    assert.ok(repo.git("ls-files", "-u").includes("src/plugin.js"));
  }
  const dependency = fixture({
    packageExtra: { dependencies: { surprise: "9" } },
  });
  assert.ok(
    dependency
      .run()
      .manualReview.includes("package.json: non-version upstream change"),
  );
  const unknown = fixture({ unknownConflict: true });
  assert.ok(unknown.run().manualReview.includes("src/unowned.js"));
  const license = fixture({ licenseChange: true });
  assert.ok(
    license
      .run()
      .manualReview.includes("LICENSE: protected release/sync input changed"),
  );
  for (const staged of [false, true]) {
    const dirty = fixture();
    dirty.write("src/plugin.js", "User's pending changes\n");
    if (staged) dirty.git("add", "src/plugin.js");
    assert.match(dirty.run().error, /dirty/);
    assert.equal(dirty.read("src/plugin.js"), "User's pending changes\n");
    assert.ok(!fs.existsSync(path.join(dirty.cwd, ".git/MERGE_HEAD")));
  }
  const collision = fixture({ newFile: true });
  collision.write("src/new-upstream.js", "Untracked user content\n");
  assert.match(collision.run().error, /Untracked files/);
  assert.equal(
    collision.read("src/new-upstream.js"),
    "Untracked user content\n",
  );
  assert.ok(!fs.existsSync(path.join(collision.cwd, ".git/MERGE_HEAD")));

  console.log(
    "Upstream sync policies, semantic guards and user-change preservation verified",
  );
} finally {
  const resolved = fs.realpathSync(root);
  assert.ok(resolved.startsWith(fs.realpathSync(cache) + path.sep));
  assert.ok(path.basename(resolved).startsWith("upstream-sync-contract-"));
  fs.rmSync(resolved, { recursive: true, force: true });
}
