const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = fs.readFileSync(
  path.join(__dirname, "../scripts/verify-mpv-desktop.cjs"),
  "utf8",
);
const start = source.indexOf("function startupTimeout(args) {");
const end = source.indexOf("const startupTimeoutMs =", start);
assert.ok(start >= 0 && end > start);
const timeout = vm.runInNewContext(
  `${source.slice(start, end)}\nstartupTimeout`,
  { assert },
);
test("ordinary Desktop startup budget remains 40 seconds", () => {
  assert.equal(timeout([]), 40_000);
});
test("portable startup budget is explicit and bounded", () => {
  assert.equal(timeout(["--startup-timeout-seconds", "120"]), 120_000);
  assert.equal(timeout(["--startup-timeout-seconds", "1"]), 1000);
});
for (const value of [
  undefined,
  "0",
  "-1",
  "121",
  "Infinity",
  "1.5",
  "--release",
]) {
  test(`rejects invalid startup timeout ${value}`, () => {
    assert.throws(() => timeout(["--startup-timeout-seconds", value]));
  });
}

test("startup loop rejects a target returned after its deadline", async () => {
  const loopStart = source.indexOf("  const startupDeadline =");
  const loopEnd = source.indexOf(
    '  assert.ok(target, "Desktop debugging target not found")',
    loopStart,
  );
  assert.ok(loopStart >= 0 && loopEnd > loopStart);
  let now = 0;
  const fetch = async () => {
    now = 5000;
    return {
      json: async () => [
        { type: "page", webSocketDebuggerUrl: "ws://localhost/test" },
      ],
    };
  };
  const target = await vm.runInNewContext(
    `(async()=>{let target;${source.slice(loopStart, loopEnd)}return target;})()`,
    {
      Date: { now: () => now },
      startupTimeoutMs: 1000,
      appExited: false,
      debugPort: 1,
      fetch,
      readDebugTargets: async () => (await fetch()).json(),
      sleep: async () => {
        now += 250;
      },
    },
  );
  assert.equal(target, undefined);
});

const readStart = source.indexOf("async function readDebugTargets(");
assert.ok(readStart > start && readStart < end);
function loadReader(fetch) {
  return vm.runInNewContext(
    `${source.slice(readStart, end)}\nreadDebugTargets`,
    {
      fetch,
      AbortController,
      setTimeout,
      clearTimeout,
    },
  );
}
for (const phase of ["fetch", "body"]) {
  test(`startup budget bounds a hanging ${phase}`, async () => {
    let signal;
    const never = new Promise(() => {});
    const reader = loadReader(async (_, options) => {
      signal = options.signal;
      return phase === "fetch" ? never : { json: () => never };
    });
    await assert.rejects(
      reader("http://localhost/test", 10),
      /Startup debugging request timed out/,
    );
    assert.equal(signal.aborted, true);
  });
}
test("startup reader returns a timely target and releases its request", async () => {
  let signal;
  const reader = loadReader(async (_, options) => {
    signal = options.signal;
    return { json: async () => [{ type: "page" }] };
  });
  assert.equal(
    JSON.stringify(await reader("http://localhost/test", 1000)),
    '[{"type":"page"}]',
  );
  assert.equal(signal.aborted, true);
});
