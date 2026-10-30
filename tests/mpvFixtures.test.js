const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const qa = fs.readFileSync(
  path.join(__dirname, "../scripts/verify-mpv-desktop.cjs"),
  "utf8",
);
const start = qa.indexOf("const subtitlePackets = JSON.parse(");
const end = qa.indexOf('await play("tracks-subs.mkv"', start);
assert.ok(start >= 0 && end > start);

function check(packets) {
  let probes = 0;
  vm.runInNewContext(qa.slice(start, end), {
    assert,
    files: new Map([["tracks-subs.mkv", "fixture.mkv"]]),
    execFileSync(command, args, options) {
      probes++;
      assert.equal(command, "ffprobe");
      assert.deepEqual(Array.from(args), [
        "-v",
        "error",
        "-select_streams",
        "s",
        "-show_packets",
        "-of",
        "json",
        "fixture.mkv",
      ]);
      assert.equal(options.encoding, "utf8");
      return JSON.stringify({ packets });
    },
  });
  assert.equal(probes, 1);
}

for (const packets of [undefined, []]) {
  test(`Desktop QA rejects ${packets ? "empty" : "missing"} subtitle packets`, () => {
    assert.throws(() => check(packets), /Empty embedded subtitle fixture/);
  });
}

test("Desktop QA accepts a nonempty embedded subtitle fixture", () => {
  check([{ codec_type: "subtitle", pts_time: "1.021000", duration_time: "9" }]);
});
