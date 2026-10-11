const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const { parse } = require("acorn");
const defaultPolicy = require("../build/upstream-sync-policy.json");

function normalize(value) {
  if (typeof value === "bigint") return { bigintValue: value.toString() };
  if (value instanceof RegExp)
    return { source: value.source, flags: value.flags };
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !["start", "end", "loc", "range"].includes(key) &&
          !(value.type === "Literal" && key === "raw"),
      )
      .map(([key, item]) => [key, normalize(item)]),
  );
}

function javascriptShape(source, ignoredComments = []) {
  const comments = [];
  const tree = parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowHashBang: true,
    onComment: comments,
  });
  return {
    tree: normalize(tree),
    comments: comments
      .map(({ type, value }) => ({ type, value: value.trim() }))
      .filter((comment) => !ignoredComments.includes(comment.value)),
  };
}

function sameJavascript(base, incoming, ignoredComments) {
  try {
    return isDeepStrictEqual(
      javascriptShape(base, ignoredComments),
      javascriptShape(incoming, ignoredComments),
    );
  } catch {
    return false;
  }
}

function onlyVersionChanged(base, incoming) {
  try {
    const left = JSON.parse(base);
    const right = JSON.parse(incoming);
    if (typeof left.version !== "string" || typeof right.version !== "string")
      return false;
    delete left.version;
    delete right.version;
    return isDeepStrictEqual(left, right);
  } catch {
    return false;
  }
}

function syncUpstream({
  cwd = path.resolve(__dirname, ".."),
  ref = "upstream/main",
  policy = defaultPolicy,
} = {}) {
  cwd = path.resolve(cwd);
  const report = { ref, preserved: [], manualReview: [] };
  const git = (args, allowed = [0]) => {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (!allowed.includes(result.status))
      throw new Error(result.stderr.trim() || result.stdout.trim());
    return result;
  };
  const output = (args) => git(args).stdout.trim();
  const names = (args) => git(args).stdout.split("\0").filter(Boolean);
  const blob = (commit, file) => {
    const entry = git(["ls-tree", "-z", commit, "--", file]).stdout;
    if (!entry) return null;
    const match = /^(100644|100755) blob ([a-f0-9]+)\t/.exec(entry);
    if (!match)
      throw new Error(`Manual review required for file mode: ${file}`);
    return {
      mode: match[1],
      sha: match[2],
      source: git(["show", `${commit}:${file}`]).stdout,
    };
  };
  const preserve = (file, reason) => {
    const original = blob(report.ours, file);
    if (!original) throw new Error(`Fork-owned file missing: ${file}`);
    const target = path.join(cwd, file);
    if (
      fs.existsSync(target) &&
      (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink())
    )
      throw new Error(`Refusing nonregular worktree file: ${file}`);
    const parent = fs.realpathSync(path.dirname(target));
    if (parent !== cwd && !parent.startsWith(cwd + path.sep))
      throw new Error(`Worktree path escapes repository: ${file}`);
    fs.writeFileSync(target, original.source);
    git([
      "update-index",
      "--add",
      "--cacheinfo",
      `${original.mode},${original.sha},${file}`,
    ]);
    report.preserved.push({ file, reason });
  };

  try {
    for (const file of [
      ...policy.forkOwnedFiles,
      ...policy.retiredFiles,
      ...policy.formatOnlyFiles,
      ...policy.manualOnlyFiles,
      policy.versionOnlyPackage,
    ]) {
      if (
        !/^[A-Za-z0-9_./-]+$/.test(file) ||
        file.startsWith("/") ||
        file.split("/").includes("..")
      )
        throw new Error(`Invalid policy path: ${file}`);
    }
    if (!/^[A-Za-z0-9_./-]+$/.test(ref) || ref.startsWith("-"))
      throw new Error("Invalid upstream ref");
    if (output(["status", "--porcelain", "--untracked-files=no"]))
      throw new Error("Tracked worktree or index is dirty; no merge started");
    report.ours = output(["rev-parse", "HEAD"]);
    report.incoming = output(["rev-parse", "--verify", `${ref}^{commit}`]);
    report.base = output(["merge-base", report.ours, report.incoming]);
    if (
      git(["merge-base", "--is-ancestor", report.incoming, report.ours], [0, 1])
        .status === 0
    ) {
      report.upToDate = true;
      return report;
    }
    const changed = new Set(
      names(["diff", "--name-only", "-z", report.base, report.incoming]),
    );
    const collisions = names([
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]).filter((file) => changed.has(file));
    if (collisions.length)
      throw new Error(
        `Untracked files would be affected: ${collisions.join(", ")}`,
      );
    const merge = git(
      ["merge", "--no-ff", "--no-commit", report.incoming],
      [0, 1],
    );
    if (git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], [0, 1]).status !== 0)
      throw new Error(merge.stderr.trim() || "Merge did not start");

    for (const file of policy.forkOwnedFiles)
      preserve(file, "fork-owned documentation");
    for (const file of policy.retiredFiles) {
      if (blob(report.ours, file))
        throw new Error(`Retired file unexpectedly exists in fork: ${file}`);
      if (names(["ls-files", "-z", "--", file]).length) {
        git(["rm", "--force", "--", file]);
        report.preserved.push({ file, reason: "keep retired file deleted" });
      }
    }
    const packageFile = policy.versionOnlyPackage;
    const basePackage = blob(report.base, packageFile);
    const incomingPackage = blob(report.incoming, packageFile);
    if (
      basePackage &&
      incomingPackage &&
      onlyVersionChanged(basePackage.source, incomingPackage.source)
    ) {
      preserve(packageFile, "upstream package change is version-only");
    } else {
      report.manualReview.push(`${packageFile}: non-version upstream change`);
    }
    const conflicts = names(["diff", "--name-only", "--diff-filter=U", "-z"]);
    for (const file of conflicts) {
      if (!policy.formatOnlyFiles.includes(file)) continue;
      const base = blob(report.base, file);
      const incoming = blob(report.incoming, file);
      if (
        base &&
        incoming &&
        sameJavascript(
          base.source,
          incoming.source,
          policy.ignoredFormatComments,
        )
      )
        preserve(file, "upstream syntax tree and retained comments unchanged");
    }
    for (const file of policy.manualOnlyFiles) {
      if (changed.has(file))
        report.manualReview.push(
          `${file}: protected release/sync input changed`,
        );
    }
    report.manualReview.push(
      ...names(["diff", "--name-only", "--diff-filter=U", "-z"]),
    );
    report.manualReview = [...new Set(report.manualReview)];
    report.mergePending = true;
    return report;
  } catch (error) {
    report.error = error.message;
    return report;
  }
}

module.exports = { syncUpstream, sameJavascript, onlyVersionChanged };
if (require.main === module) {
  const report = syncUpstream();
  fs.mkdirSync(path.resolve(__dirname, "../.cache"), { recursive: true });
  fs.writeFileSync(
    path.resolve(__dirname, "../.cache/upstream-sync-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Upstream sync\n\n${report.error || (report.manualReview.length ? "Manual review required" : "Policy checks passed")}\n\n` +
        report.preserved
          .map(({ file, reason }) => `- ${file}: ${reason}\n`)
          .join("") +
        report.manualReview.map((file) => `- Review: ${file}\n`).join(""),
    );
  }
  if (report.error || report.manualReview.length) process.exitCode = 1;
}
