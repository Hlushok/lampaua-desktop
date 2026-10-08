const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const written = [];
const operations = [];
let large = false;
let fail = false;
const fakeFs = {
  mkdirSync() {
    if (fail) throw new Error("Disk unavailable");
  },
  existsSync: () => true,
  statSync: () => ({ size: large ? 1048577 : 0 }),
  unlinkSync: (file) => operations.push(["unlink", file]),
  renameSync: (from, to) => operations.push(["rename", from, to]),
  appendFileSync: (file, data) => written.push({ file, ...JSON.parse(data) }),
};
const moduleValue = { exports: {} };
const source = fs.readFileSync(
  path.resolve(__dirname, "../src/modules/mpv/manager.js"),
  "utf8",
);
vm.runInNewContext(source + "\nmodule.exports.diagnostic = diagnostic;", {
  module: moduleValue,
  __dirname: path.resolve(__dirname, "../src/modules/mpv"),
  require(name) {
    if (name === "node:fs") return fakeFs;
    if (name === "electron")
      return { app: { getPath: () => "C:/Contract/MpvTest" } };
    if (name === "./testMode") return { isMpvEnabled: () => true };
    if (name === "./policy") return {};
    return require(name);
  },
});
const { diagnostic } = moduleValue.exports;
diagnostic("end-file", { playerId: "one", error: "HTTP 503" });
assert.equal(written[0].error, "HTTP 503");
diagnostic("end-file", {
  playerId: "one",
  error: "HTTP 503 https://provider.test/?token=secret",
  url: "https://provider.test/?token=secret",
  headers: { Authorization: "secret" },
});
assert.equal(written[1].error, "media failure");
assert.ok(!JSON.stringify(written).includes("secret"));
large = true;
diagnostic("destroy-complete", { playerId: "one" });
assert.equal(operations.length, 2);
assert.equal(operations[0][0], "unlink");
assert.equal(operations[1][0], "rename");
assert.equal(operations[0][1], written[0].file + ".previous");
assert.equal(operations[1][1], written[0].file);
fail = true;
assert.doesNotThrow(() =>
  diagnostic("open", { playerId: "two", format: "hls" }),
);
assert.equal(written.length, 3);
console.log(
  "MPV diagnostic redaction, rotation and failure isolation verified",
);
