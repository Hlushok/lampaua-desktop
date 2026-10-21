const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const http = require("node:http");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const source = fs.readFileSync(
  path.join(__dirname, "../src/modules/utils/electronNetFetch.js"),
  "utf8",
);
function fixture(fetch, ready = true) {
  const timers = new Set();
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    AbortController,
    AbortSignal,
    DOMException,
    ReadableStream,
    Response,
    require(name) {
      assert.equal(name, "electron");
      return { app: { isReady: () => ready }, net: { fetch } };
    },
    setTimeout(callback, ms) {
      assert.equal(ms, 30_000);
      const timer = { callback, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      timers.delete(timer);
    },
  });
  return { fetch: module.exports.electronNetFetch, timers };
}
async function main() {
  await assert.rejects(
    fixture(() => {}, false).fetch("http://test"),
    /whenReady/,
  );
  let received;
  const normal = fixture(async (input, options) => {
    received = { input, options };
    return new Response("payload", {
      status: 206,
      headers: { "Content-Range": "bytes 0-6/7" },
    });
  });
  const result = await normal.fetch("http://test", {
    method: "POST",
    body: "request",
    headers: { Range: "bytes=0-6" },
    bypassCustomProtocolHandlers: false,
  });
  assert.equal(received.options.method, "POST");
  assert.equal(received.options.body, "request");
  assert.equal(received.options.headers.Range, "bytes=0-6");
  assert.equal(received.options.bypassCustomProtocolHandlers, true);
  assert.equal(result.status, 206);
  assert.equal(result.headers.get("Content-Range"), "bytes 0-6/7");
  assert.equal(normal.timers.size, 0, "No timeout during the response body");
  assert.equal(await result.text(), "payload");

  let cancelled = false;
  let signal;
  const stalled = fixture(async (_input, options) => {
    signal = options.signal;
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  const stream = await stalled.fetch("http://test");
  const reader = stream.body.getReader();
  const pending = reader.read();
  await reader.cancel("player closed");
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);

  for (const from of ["input", "options"]) {
    const caller = new AbortController();
    const abortable = fixture(async (_input, options) => {
      signal = options.signal;
      return new Response(null, { status: 204 });
    });
    await abortable.fetch(
      from === "input" ? { signal: caller.signal } : "http://test",
      from === "options" ? { signal: caller.signal } : {},
    );
    caller.abort();
    assert.equal(signal.aborted, true);
  }
  const timeout = fixture(
    async (_input, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () =>
          reject(options.signal.reason),
        );
      }),
  );
  const waiting = timeout.fetch("http://test");
  [...timeout.timers][0].callback();
  await assert.rejects(waiting, { name: "TimeoutError" });
  assert.equal(timeout.timers.size, 0);

  const failure = fixture(async () => {
    throw new Error("connection failed");
  });
  await assert.rejects(failure.fetch("http://test"), /connection failed/);
  assert.equal(failure.timers.size, 0);
  const readFailure = fixture(
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error("peer closed"));
          },
        }),
      ),
  );
  await assert.rejects(
    (await readFailure.fetch("http://test")).text(),
    /peer closed/,
  );
  console.log(
    "Chromium fetch passthrough, header timeout, abort and stream cancellation verified",
  );
}
async function realElectron() {
  const { app, net, protocol } = require("electron");
  const profile = path.resolve(__dirname, `../.cache/network-qa-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  const trace = (message) =>
    fs.appendFileSync(path.join(profile, "network-qa.log"), `${message}\n`);
  trace("starting");
  app.setPath("userData", profile);
  const { electronNetFetch } = require("../src/modules/utils/electronNetFetch");
  let closed;
  const cancelled = new Promise((resolve) => {
    closed = resolve;
  });
  const server = http.createServer((request, response) => {
    trace(`HTTP ${request.method} ${request.url}`);
    if (request.url === "/gzip") {
      response.writeHead(200, { "Content-Encoding": "gzip" });
      response.end(zlib.gzipSync("compressed payload"));
    } else if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/gzip" });
      response.end();
    } else if (request.url === "/cancel") {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.write("streaming".repeat(8192));
      response.on("close", closed);
    } else if (request.url === "/range") {
      assert.equal(request.headers.range, "bytes=2-5");
      response.writeHead(206, { "Content-Range": "bytes 2-5/8" });
      response.end("2345");
    } else if (request.method === "POST") {
      request.pipe(response);
    } else {
      response.writeHead(204);
      response.end();
    }
  });
  try {
    await app.whenReady();
    trace("ready");
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    protocol.handle("http", (request) => {
      trace(`PROTOCOL ${request.method} ${request.url}`);
      return electronNetFetch(request);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const route of ["gzip", "redirect"]) {
      trace(`FETCH ${route}`);
      assert.equal(
        await (await net.fetch(`${base}/${route}`)).text(),
        "compressed payload",
      );
      trace(`PASS ${route}`);
    }
    const range = await net.fetch(`${base}/range`, {
      headers: { Range: "bytes=2-5" },
    });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("Content-Range"), "bytes 2-5/8");
    assert.equal(await range.text(), "2345");
    assert.equal(
      await (
        await net.fetch(`${base}/post`, {
          method: "POST",
          body: "request body",
        })
      ).text(),
      "request body",
    );
    assert.equal(
      (await net.fetch(`${base}/head`, { method: "HEAD" })).status,
      204,
    );
    trace("FETCH cancel");
    const streaming = await electronNetFetch(`${base}/cancel`);
    trace("HEADERS cancel");
    const reader = streaming.body.getReader();
    await reader.read();
    trace("READ cancel");
    await reader.cancel();
    trace("CANCELLED reader");
    let timeout;
    try {
      await Promise.race([
        cancelled,
        new Promise((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Chromium socket was not cancelled")),
            3000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    console.log(
      "Real Electron network: protocol bypass, gzip, redirects, Range, POST, HEAD and socket cancellation verified",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
if (process.versions.electron) {
  realElectron()
    .then(() => require("electron").app.quit())
    .catch((error) => {
      console.error(error);
      require("electron").app.exit(1);
    });
} else {
  main()
    .then(() => {
      const index = process.argv.indexOf("--electron");
      if (index < 0) return;
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      execFileSync(path.resolve(process.argv[index + 1]), [__filename], {
        env,
        stdio: "inherit",
        timeout: 30_000,
        windowsHide: true,
      });
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
