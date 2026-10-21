const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const yaml = require("yaml");
const version = require("../package.json").version;
// electron-updater compares the kernel version, not the macOS product version.
const minimumSystemVersion = "22.0.0";
function finalizeMacUpdates(root = path.resolve(__dirname, "../dist")) {
  const file = path.join(root, "latest-mac.yml");
  const info = yaml.parse(fs.readFileSync(file, "utf8"));
  assert.equal(info.version, version);
  for (const arch of ["x64", "arm64"])
    assert.ok(
      info.files.some(
        (entry) => entry.url === `lampaua-${arch}-${version}.zip`,
      ),
      `Missing macOS ${arch} updater ZIP`,
    );
  for (const entry of info.files) {
    assert.equal(path.basename(entry.url), entry.url);
    assert.ok(
      ["x64", "arm64"].some((arch) =>
        ["zip", "dmg"].some(
          (ext) => entry.url === `lampaua-${arch}-${version}.${ext}`,
        ),
      ),
    );
    const bytes = fs.readFileSync(path.join(root, entry.url));
    assert.equal(
      crypto.createHash("sha512").update(bytes).digest("base64"),
      entry.sha512,
    );
    if (entry.size !== undefined) assert.equal(bytes.length, entry.size);
  }
  assert.ok(info.path.endsWith(".zip"), "macOS updater must select a ZIP");
  info.minimumSystemVersion = minimumSystemVersion;
  fs.writeFileSync(file, yaml.stringify(info));
  console.log(
    "macOS updater files verified; macOS 13 / Darwin 22 minimum applied",
  );
  return info;
}
module.exports = { finalizeMacUpdates, minimumSystemVersion };
if (require.main === module) finalizeMacUpdates();
