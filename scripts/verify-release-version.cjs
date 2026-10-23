const assert = require("node:assert/strict");

function verifyReleaseVersion(version, ref) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  if (ref.startsWith("refs/tags/")) {
    assert.equal(
      ref,
      `refs/tags/v${version}`,
      "Release tag must match package.json before building any artifacts",
    );
  }
  return version;
}

if (require.main === module) {
  if (process.argv.includes("--self-test")) {
    assert.equal(verifyReleaseVersion("2.0.3", "refs/tags/v2.0.3"), "2.0.3");
    assert.throws(() => verifyReleaseVersion("2.0.2", "refs/tags/v2.0.3"));
    assert.throws(() => verifyReleaseVersion("2.0.3", "refs/tags/v2.0.3-test"));
    assert.throws(() => verifyReleaseVersion("invalid", "refs/heads/main"));
    assert.equal(verifyReleaseVersion("2.0.3", "refs/heads/main"), "2.0.3");
    console.log("Release tag/version mismatch fails before packaging");
  } else {
    console.log(
      "Verified release version",
      verifyReleaseVersion(
        require("../package.json").version,
        process.env.GITHUB_REF || "",
      ),
    );
  }
}

module.exports = { verifyReleaseVersion };
