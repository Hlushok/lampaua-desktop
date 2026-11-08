const { spawnSync } = require("node:child_process");
const { channel } = require("node:diagnostics_channel");
const { setTimeout } = require("node:timers/promises");

const retryDelays = [10000, 30000, 60000];

function observeDownloadErrors(log = console.error) {
  const errors = channel("undici:request:error");
  const report = ({ error }) => {
    const pending = [error];
    const seen = new Set();
    const codes = new Set();
    while (pending.length && seen.size < 32) {
      const current = pending.pop();
      if (!current || typeof current !== "object" || seen.has(current))
        continue;
      seen.add(current);
      if (
        typeof current.code === "string" &&
        /^[A-Z0-9_]{1,64}$/.test(current.code)
      )
        codes.add(current.code);
      if (current.cause) pending.push(current.cause);
      if (Array.isArray(current.errors))
        pending.push(...current.errors.slice(0, 32));
    }
    // The installer prints only err.stack, which omits fetch's nested cause.
    // Report codes only, never the request URL, headers, or error messages.
    if (codes.size)
      log(`Electron download error codes: ${[...codes].join(",")}`);
  };
  errors.subscribe(report);
  return () => errors.unsubscribe(report);
}

function retryable(result) {
  const detail = `${result.error?.code || ""}\n${result.stdout || ""}\n${result.stderr || ""}`;
  if (
    /checksum|certificate|CERT_|TLS_|SELF_SIGNED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|MODULE_NOT_FOUND|EACCES|EPERM/i.test(
      detail,
    )
  )
    return false;
  return /(?:Response code|status code) (?:408|429|5\d{2})\b|\b(?:EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET)\b/i.test(
    detail,
  );
}

async function ensureElectron({
  run = spawnSync,
  wait = setTimeout,
  log = console.log,
} = {}) {
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    log(`Preparing Electron (attempt ${attempt + 1}/4)`);
    // Use Electron's own cache-aware installer, including its checksum checks.
    const result = run(process.execPath, [__filename, "--install"], {
      encoding: "utf8",
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const output of [result.stdout, result.stderr, result.error?.message])
      if (output) log(output.trimEnd());
    if (result.status === 0 && !result.error && !result.signal) {
      log("Electron preparation verified by the official installer");
      return;
    }
    if (attempt === retryDelays.length || !retryable(result))
      throw new Error(
        `Electron preparation failed after ${attempt + 1} attempts; validation must not continue`,
      );
    log(
      `Transient download failure; retrying in ${retryDelays[attempt] / 1000}s`,
    );
    await wait(retryDelays[attempt]);
  }
}

if (require.main === module) {
  if (process.argv[2] === "--install") {
    observeDownloadErrors();
    require("electron/install.js");
  } else {
    ensureElectron().catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}

module.exports = { ensureElectron, observeDownloadErrors };
