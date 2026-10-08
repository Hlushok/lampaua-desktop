const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const yaml = require("yaml");
const merge = require("./merge-windows-updates.cjs");
const version = require("../package.json").version;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lampaua-update-contract-"));
const manifests = {};
try {
  for (const [directory, arches] of [
    ["release-x64", ["x64"]],
    ["legacy", ["arm64", "ia32"]],
  ]) {
    const folder = path.join(root, directory);
    fs.mkdirSync(folder);
    const files = arches.map((arch) => {
      const bytes = Buffer.from(`synthetic-${arch}`);
      const url = `lampaua-${arch}-${version}.exe`;
      fs.writeFileSync(path.join(folder, url), bytes);
      return {
        url,
        size: bytes.length,
        sha512: crypto.createHash("sha512").update(bytes).digest("base64"),
      };
    });
    manifests[directory] = { version, files };
    fs.writeFileSync(
      path.join(folder, "latest.yml"),
      yaml.stringify(manifests[directory]),
    );
  }
  merge(root);
  const merged = yaml.parse(
    fs.readFileSync(path.join(root, "latest.yml"), "utf8"),
  );
  assert.equal(merged.path, `lampaua-x64-${version}.exe`);
  assert.equal(merged.files[0].url, merged.path);
  assert.equal(merged.files.length, 3);
  const bad = manifests.legacy;
  bad.files[0].sha512 = "invalid";
  fs.writeFileSync(path.join(root, "legacy/latest.yml"), yaml.stringify(bad));
  assert.throws(() => merge(root), /AssertionError/);
  assert.deepEqual(
    yaml.parse(fs.readFileSync(path.join(root, "latest.yml"), "utf8")),
    merged,
    "A corrupt input must not replace the updater manifest",
  );
  console.log(
    "Windows architecture selection and corrupt-update rejection verified",
  );
} finally {
  // Only remove the exact temporary directory created by this test.
  const resolved = path.resolve(root);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(resolved).startsWith("lampaua-update-contract-"));
  fs.rmSync(resolved, { recursive: true, force: true });
}
