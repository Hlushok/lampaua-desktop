const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const yaml = require("yaml");
const version = require("../package.json").version;
function mergeWindowsUpdates(root = path.resolve(__dirname, "../dist")) {
  const sources = [
    ["release-x64", ["x64"]],
    ["legacy", ["ia32", "arm64"]],
  ].map(([directory, arches]) => {
    const folder = path.join(root, directory);
    const manifest = yaml.parse(
      fs.readFileSync(path.join(folder, "latest.yml"), "utf8"),
    );
    assert.equal(manifest.version, version);
    const allowed = arches.map((arch) => `lampaua-${arch}-${version}.exe`);
    if (directory === "release-x64")
      allowed.push(`lampaua-x64-${version}-portable.exe`);
    for (const file of manifest.files) {
      assert.equal(path.basename(file.url), file.url);
      assert.ok(
        allowed.includes(file.url),
        `Unexpected ${directory} artifact: ${file.url}`,
      );
      const bytes = fs.readFileSync(path.join(folder, file.url));
      assert.equal(bytes.length, file.size);
      assert.equal(
        crypto.createHash("sha512").update(bytes).digest("base64"),
        file.sha512,
      );
    }
    return { folder, manifest };
  });
  const files = sources
    .flatMap(({ manifest }) => manifest.files)
    .filter((file) => !file.url.includes("-portable"));
  for (const arch of ["x64", "ia32", "arm64"])
    assert.ok(
      files.some((file) => file.url === `lampaua-${arch}-${version}.exe`),
      arch,
    );
  assert.equal(new Set(files.map((file) => file.url)).size, files.length);
  const primary = files.find(
    (file) => file.url === `lampaua-x64-${version}.exe`,
  );
  // Validate every source before copying: legacy output must never replace MPV.
  for (const { folder, manifest } of sources) {
    for (const file of manifest.files) {
      fs.copyFileSync(path.join(folder, file.url), path.join(root, file.url));
      const blockmap = `${file.url}.blockmap`;
      if (fs.existsSync(path.join(folder, blockmap)))
        fs.copyFileSync(path.join(folder, blockmap), path.join(root, blockmap));
    }
    const portable = `lampaua-x64-${version}-portable.exe`;
    if (
      folder === path.join(root, "release-x64") &&
      fs.existsSync(path.join(folder, portable))
    )
      fs.copyFileSync(path.join(folder, portable), path.join(root, portable));
  }
  fs.writeFileSync(
    path.join(root, "latest.yml"),
    yaml.stringify({
      version,
      files: [primary, ...files.filter((file) => file !== primary)],
      path: primary.url,
      sha512: primary.sha512,
      releaseDate: new Date().toISOString(),
    }),
  );
  console.log(
    "Windows update metadata verified: x64 MPV, ia32/arm64 browser runtime",
  );
}
module.exports = mergeWindowsUpdates;
if (require.main === module) mergeWindowsUpdates();
