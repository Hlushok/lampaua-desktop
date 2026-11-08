const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const test = require("node:test");
const YAML = require("yaml");
const { channel } = require("node:diagnostics_channel");
const {
  ensureElectron,
  observeDownloadErrors,
} = require("../scripts/ensure-electron.cjs");

function harness(results) {
  const calls = [];
  const delays = [];
  return {
    calls,
    delays,
    options: {
      run(...args) {
        calls.push(args);
        assert.ok(results.length, "Unexpected extra install attempt");
        return results.shift();
      },
      async wait(milliseconds) {
        delays.push(milliseconds);
      },
      log() {},
    },
  };
}

const success = () => ({ status: 0, stdout: "", stderr: "" });
const failure = (stderr) => ({ status: 1, stdout: "", stderr });

test("Electron preparation retries HTTP 503 without rerunning contract tests", async () => {
  const h = harness([
    failure("HTTPError: Response code 503 (Service Unavailable)"),
    failure("HTTPError: Response code 503 (Service Unavailable)"),
    success(),
  ]);
  await ensureElectron(h.options);
  assert.deepEqual(h.delays, [10000, 30000]);
  assert.equal(h.calls.length, 3);
  for (const [command, args, options] of h.calls) {
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [
      require.resolve("../scripts/ensure-electron.cjs"),
      "--install",
    ]);
    assert.equal(options.timeout, 120000);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env, undefined, "Keep official installer checksums");
  }
});

test("An already installed or cached Electron needs no retry delay", async () => {
  const h = harness([success()]);
  await ensureElectron(h.options);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.delays, []);
});

for (const message of [
  "HTTPError: Response code 408 (Request Timeout)",
  "HTTPError: Response code 429 (Too Many Requests)",
  "HTTPError: Response code 502 (Bad Gateway)",
  "Error: getaddrinfo EAI_AGAIN github.com",
  "Error: read ECONNRESET",
])
  test(`Transient installer failure is retried: ${message}`, async () => {
    const h = harness([failure(message), success()]);
    await ensureElectron(h.options);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.delays, [10000]);
  });

for (const [code, retries] of [
  ["ECONNRESET", true],
  ["EAI_AGAIN", true],
  ["UND_ERR_SOCKET", true],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", false],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", false],
])
  test(`Original fetch cause is preserved without leaking request data: ${code}`, async () => {
    const error = new TypeError("fetch failed", {
      cause: Object.assign(new Error("private signed URL and headers"), {
        code,
      }),
    });
    assert.ok(!error.stack.includes(code));
    const output = [];
    const unsubscribe = observeDownloadErrors((line) => output.push(line));
    try {
      channel("undici:request:error").publish({
        error,
        request: { url: "https://private.invalid/?secret=token" },
      });
    } finally {
      unsubscribe();
    }
    const stderr = `${error.stack}\n${output.join("\n")}`;
    assert.match(stderr, new RegExp(code));
    assert.doesNotMatch(stderr, /private|secret|token|headers/);
    const h = harness([failure(stderr), ...(retries ? [success()] : [])]);
    if (retries) await ensureElectron(h.options);
    else await assert.rejects(ensureElectron(h.options));
    assert.equal(h.calls.length, retries ? 2 : 1);
  });

test("A TLS cause takes precedence over a timeout in an AggregateError", async () => {
  const output = [];
  const unsubscribe = observeDownloadErrors((line) => output.push(line));
  try {
    channel("undici:request:error").publish({
      error: new AggregateError([
        Object.assign(new Error(), { code: "ETIMEDOUT" }),
        Object.assign(new Error(), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }),
      ]),
    });
  } finally {
    unsubscribe();
  }
  const h = harness([failure(output.join("\n"))]);
  await assert.rejects(ensureElectron(h.options));
  assert.equal(h.calls.length, 1);
});

test("Real native fetch socket failure reaches the installer diagnostics", async () => {
  const server = http.createServer((_request, response) => response.destroy());
  const output = [];
  const unsubscribe = observeDownloadErrors((line) => output.push(line));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    await assert.rejects(
      fetch(`http://127.0.0.1:${server.address().port}/`, {
        signal: AbortSignal.timeout(2000),
      }),
      /fetch failed/,
    );
    const h = harness([failure(output.join("\n")), success()]);
    await ensureElectron(h.options);
    assert.equal(h.calls.length, 2);
  } finally {
    unsubscribe();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("A stalled download has a bounded timeout and retry budget", async () => {
  const h = harness([
    { status: null, error: { code: "ETIMEDOUT" } },
    success(),
  ]);
  await ensureElectron(h.options);
  assert.equal(h.calls.length, 2);
});

test("Four failed downloads fail CI instead of accepting incomplete Electron", async () => {
  const h = harness(
    Array.from({ length: 4 }, () => failure("Response code 503")),
  );
  await assert.rejects(ensureElectron(h.options), /4 attempts/);
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.delays, [10000, 30000, 60000]);
});

for (const message of [
  "HTTPError: Response code 404 (Not Found)",
  "Error: SHA256 checksum mismatch",
  "Error: checksum mismatch after HTTPError: Response code 503",
  "Error: self-signed certificate",
  "Error: Cannot find module extract-zip",
])
  test(`Permanent installer failure is not hidden: ${message}`, async () => {
    const h = harness([failure(message)]);
    await assert.rejects(
      ensureElectron(h.options),
      /Electron preparation failed/,
    );
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.delays, []);
  });

for (const name of ["sync-upstream.yml", "validate.yml"])
  test(`${name} restores the versioned Electron cache and prepares it before contracts`, () => {
    const workflow = YAML.parse(
      fs.readFileSync(
        path.join(__dirname, "../.github/workflows", name),
        "utf8",
      ),
    );
    const job =
      workflow.jobs[name === "sync-upstream.yml" ? "sync" : "contracts"];
    assert.equal(
      job.env.electron_config_cache,
      "${{ github.workspace }}/.cache/electron-download-cache",
    );
    const cache = job.steps.find((step) =>
      step.uses?.startsWith("actions/cache@"),
    );
    assert.ok(cache);
    assert.equal(cache.with.path, "${{ env.electron_config_cache }}");
    assert.equal(
      cache.with.key,
      "${{ runner.os }}-${{ runner.arch }}-electron-v1-${{ hashFiles('yarn.lock') }}",
    );
    assert.equal(cache.with["restore-keys"], undefined);
    const prepare = job.steps.find(
      (step) => step.run === "node scripts/ensure-electron.cjs",
    );
    assert.ok(prepare);
    assert.equal(prepare["continue-on-error"], undefined);
    assert.equal(prepare["timeout-minutes"], 10);
    const validate = job.steps.find((step) =>
      step.run?.includes("verify-desktop-upgrade.cjs"),
    );
    assert.ok(job.steps.indexOf(cache) < job.steps.indexOf(prepare));
    assert.ok(job.steps.indexOf(prepare) < job.steps.indexOf(validate));
  });
