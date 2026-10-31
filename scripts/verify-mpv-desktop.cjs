const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const { parse } = require("acorn");
const root = path.resolve(__dirname, "..");
function startupTimeout(args) {
  const index = args.indexOf("--startup-timeout-seconds");
  if (index < 0) return 40_000;
  const value = args[index + 1];
  assert.match(value || "", /^\d+$/);
  const seconds = Number(value);
  assert.ok(
    seconds >= 1 && seconds <= 120,
    "Startup timeout must be 1-120 seconds",
  );
  return seconds * 1000;
}
async function readDebugTargets(url, timeoutMs) {
  const abort = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { signal: abort.signal });
        return response.json();
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error("Startup debugging request timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}
const startupTimeoutMs = startupTimeout(process.argv);
const qualityOnly = process.argv.includes("--quality-only");
const d3d11Next = process.argv.includes("--d3d11-next");
assert.equal(
  d3d11Next && process.argv.includes("--d3d11"),
  false,
  "Select one D3D11 candidate variant",
);
const d3d11 = process.argv.includes("--d3d11") || d3d11Next;
const reuseTestProfile = process.argv.includes("--reuse-test-profile");
assert.ok(
  !reuseTestProfile || (d3d11 && !process.argv.includes("--release")),
  "Persistent profile requires the isolated D3D11 test package",
);
const exeIndex = process.argv.indexOf("--exe");
const exe = exeIndex < 0 ? undefined : process.argv[exeIndex + 1];
assert.ok(
  exe && fs.existsSync(exe),
  "Pass --exe pointing to the full desktop build",
);
if (reuseTestProfile || d3d11Next) {
  const packageFile = path.join(
    path.dirname(path.resolve(exe)),
    "resources/app/package.json",
  );
  assert.ok(
    fs.existsSync(packageFile),
    "Persistent profile requires the isolated D3D11 test package",
  );
  const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  if (d3d11Next)
    assert.equal(
      pkg.lampauaMpvD3d11NextTest,
      true,
      "Pass the upstream-native D3D11 test package",
    );
  assert.ok(
    pkg.lampauaMpvTest === true &&
      pkg.lampauaMpvD3d11Test === true &&
      pkg.main === "src/mpv-test-main.js",
    "Persistent profile requires the isolated D3D11 test package",
  );
}
const runId = `run-${Date.now()}`;
const output = path.join(
  root,
  d3d11Next
    ? ".cache/mpv-desktop-d3d11-next-test/evidence"
    : d3d11
      ? ".cache/mpv-desktop-d3d11-test/evidence"
      : ".cache/mpv-desktop-test/evidence",
  runId,
);
fs.mkdirSync(output, { recursive: true });
const log = fs.createWriteStream(path.join(output, "app.log"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fixtures = path.join(root, ".cache/mpv-prototype/fixtures");
const files = new Map(
  fs
    .readdirSync(fixtures, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => [entry.name, path.join(fixtures, entry.name)]),
);
const streamFixtures = path.join(fixtures, "streams");
if (fs.existsSync(streamFixtures))
  for (const name of fs.readdirSync(streamFixtures))
    for (const prefix of ["ytdl", "native-dash", "iptv", "sisi"])
      files.set(`${prefix}/${name}`, path.join(streamFixtures, name));
files.set("sisi/video.mp4", path.join(fixtures, "h264-aac.mp4"));
const requests = [];
let child;
let ws;
let traceSocket;
let server;
let killed = false;
let appExited = false;
let exitCode;
let rendererClosedAt = 0;
let deadline;
const results = [];
function profileSnapshot() {
  const folder = path.join(process.env.APPDATA, "LampaUa");
  if (!fs.existsSync(folder)) return [];

  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        const stat = fs.statSync(file);

        files.push([path.relative(folder, file), stat.size, stat.mtimeMs]);
      }
    }
  }
  visit(folder);
  return files.sort((a, b) => a[0].localeCompare(b[0]));
}
const productionBefore = profileSnapshot();
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
function terminate() {
  if (!child || appExited || killed) return;
  killed = true;
  try {
    execFileSync(
      "C:/Windows/System32/taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { timeout: 10_000, windowsHide: true },
    );
  } catch {
    child.kill();
  }
}
async function main() {
  server = http.createServer((req, res) => {
    log.write(`HTTP ${req.method} ${req.url} ${req.headers.range || ""}\n`);
    const request = new URL(req.url, "http://localhost");
    const name = request.pathname.slice(1);
    requests.push({ name, query: request.search, headers: req.headers });
    if (name.startsWith("ytdl/blocked-dash-")) {
      res.writeHead(503);
      res.end();
      return;
    }
    if (name === "stalled.mp4" || name === "stalled.ts") return;
    if (name === "postload-stall.mp4") {
      const data = fs.readFileSync(files.get("h264-aac.mp4"));
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
      const start = match ? Number(match[1]) : 0;
      const end = match?.[2]
        ? Math.min(Number(match[2]), data.length - 1)
        : data.length - 1;
      res.writeHead(match ? 206 : 200, {
        "Content-Type": "video/mp4",
        "Content-Length": end - start + 1,
        "Accept-Ranges": "bytes",
        ...(match
          ? { "Content-Range": `bytes ${start}-${end}/${data.length}` }
          : {}),
      });
      res.write(data.subarray(start, Math.min(start + 524288, end + 1)));
      return;
    }
    if (name === "stalled.m3u8") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:14\n#EXTINF:14,\nstalled.ts\n#EXT-X-ENDLIST\n",
      );
      return;
    }
    if (
      name.startsWith("native-dash/dash-") &&
      !/^bytes=\d+-\d+$/.test(req.headers.range || "")
    ) {
      res.writeHead(503);
      res.end("Bounded ranges required by the synthetic Ytdl proxy");
      return;
    }
    if (
      name.startsWith("sisi/") &&
      (req.headers.referer !== "https://provider.test/watch" ||
        req.headers["user-agent"] !== "LampaUa-SISI-Test" ||
        req.headers.authorization !== "Bearer synthetic-test")
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (name === "ytdl/manifest" || name === "native-dash/manifest.mpd") {
      const quality = request.searchParams.get("quality");
      if (["720", "1080", "blocked"].includes(quality)) {
        res.writeHead(200, { "Content-Type": "application/dash+xml" });
        res.end(
          fs
            .readFileSync(
              path.join(
                streamFixtures,
                `dash-${quality === "blocked" ? "720" : quality}.mpd`,
              ),
              "utf8",
            )
            .replaceAll(
              "dash-720-",
              quality === "blocked" ? "blocked-dash-720-" : "dash-720-",
            ),
        );
      } else if (quality === "local") {
        res.writeHead(200, { "Content-Type": "application/dash+xml" });
        res.end(
          `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT14S" minBufferTime="PT1S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="1" bandwidth="100000" codecs="avc1.42C01E"><BaseURL>file:///${path.join(fixtures, "h264-aac.mp4").replaceAll("\\", "/")}</BaseURL></Representation></AdaptationSet></Period></MPD>`,
        );
      } else {
        res.writeHead(404);
        res.end();
      }
      return;
    }
    if (name === "iptv/live.m3u8") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(
        fs
          .readFileSync(path.join(streamFixtures, "channel.m3u8"), "utf8")
          .replace("#EXT-X-PLAYLIST-TYPE:VOD\n", "")
          .replace("#EXT-X-ENDLIST", ""),
      );
      return;
    }
    if (name === "lite/iptvportal/api/stream") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(
        fs
          .readFileSync(path.join(streamFixtures, "channel.m3u8"), "utf8")
          .replaceAll("channel-", "/iptv/channel-"),
      );
      return;
    }
    if (name === "iptv/local.m3u8") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:14\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:14,\nfile:///${path.join(streamFixtures, "channel.ts").replaceAll("\\", "/")}\n#EXT-X-ENDLIST\n`,
      );
      return;
    }
    if (name === "redirect-local") {
      res.writeHead(302, {
        Location: `file:///${path.join(fixtures, "h264-aac.mp4").replaceAll("\\", "/")}`,
      });
      res.end();
      return;
    }
    if (name === "nested-local.m3u") {
      res.writeHead(200, { "Content-Type": "audio/x-mpegurl" });
      res.end(
        `#EXTM3U\nfile:///${path.join(fixtures, "h264-aac.mp4").replaceAll("\\", "/")}\n`,
      );
      return;
    }
    if (!files.has(name)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const file = files.get(name);
    const size = fs.statSync(file).size;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
    const start = range ? Number(range[1]) : 0;
    const end =
      range && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    if (start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(range ? 206 : 200, {
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      "Content-Type": name.endsWith("mp4")
        ? "video/mp4"
        : name.endsWith("m3u8")
          ? "application/vnd.apple.mpegurl"
          : name.endsWith("ts")
            ? "video/mp2t"
            : "application/octet-stream",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const debugPort = await freePort();
  const env = { ...process.env, PATH: "C:/Windows/System32;C:/Windows" };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(
    path.resolve(exe),
    [
      ...(process.argv.includes("--release")
        ? [`--user-data-dir=${path.join(output, "profile")}`]
        : reuseTestProfile
          ? []
          : [`--mpv-test-run=${runId}`]),
      ...(d3d11 && process.argv.includes("--performance-only")
        ? ["--mpv-test-window-log"]
        : []),
      `--remote-debugging-port=${debugPort}`,
      "--remote-debugging-address=127.0.0.1",
    ],
    {
      windowsHide: false,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.on("exit", (code) => {
    log.write(`PROCESS EXIT ${Date.now()} code=${code}\n`);
    appExited = true;
    exitCode = code;
  });
  const exit = new Promise((resolve) => child.once("exit", resolve));
  child.on("error", (error) => {
    log.write(String(error));
  });
  deadline = setTimeout(terminate, 300_000);
  let target;
  const startupDeadline = Date.now() + startupTimeoutMs;
  while (Date.now() < startupDeadline) {
    if (appExited)
      throw new Error(`Application exited during startup: ${exitCode}`);
    try {
      const remaining = startupDeadline - Date.now();
      if (remaining <= 0) break;
      const targets = await readDebugTargets(
        `http://127.0.0.1:${debugPort}/json/list`,
        remaining,
      );
      if (Date.now() >= startupDeadline) break;
      target = targets.find((entry) => entry.type === "page");
    } catch {
      /* The endpoint is not available until Chromium starts. */
    }
    if (target) break;
    await sleep(Math.min(250, Math.max(0, startupDeadline - Date.now())));
  }
  assert.ok(target, "Desktop debugging target not found");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.addEventListener("close", () => {
    rendererClosedAt = Date.now();
    log.write(`RENDERER CLOSED ${rendererClosedAt}\n`);
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  let traceComplete;
  const protocolMessage = ({ data }) => {
    const response = JSON.parse(data);
    if (response.method === "Tracing.tracingComplete")
      traceComplete?.(response.params);
    if (response.method === "Fetch.requestPaused") {
      void cdp("Fetch.failRequest", {
        requestId: response.params.requestId,
        errorReason: "InternetDisconnected",
      }).catch(() => {});
    }
    if (
      response.method === "Runtime.consoleAPICalled" &&
      response.params.type === "error"
    )
      log.write(`RENDERER ${JSON.stringify(response.params.args)}\n`);
    if (response.id) {
      const p = pending.get(response.id);
      if (!p) return;
      pending.delete(response.id);
      clearTimeout(p.timer);
      response.error
        ? p.reject(new Error(JSON.stringify(response.error)))
        : p.resolve(response.result);
    }
  };
  ws.addEventListener("message", protocolMessage);
  function cdp(method, params = {}, connection = ws) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
      connection.send(JSON.stringify({ id, method, params }));
    });
  }
  await cdp("Runtime.enable");
  async function evaluate(expression) {
    const result = await cdp("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function closeApplication() {
    const start = Date.now();
    rendererClosedAt = 0;
    log.write(`CLOSE REQUESTED ${start}\n`);
    await evaluate("electronAPI.closeApp()");
    let deadline;
    try {
      await Promise.race([
        exit,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () =>
              reject(new Error("App process did not exit within 20 seconds")),
            20000,
          );
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    const metrics = {
      rendererCloseMs: rendererClosedAt - start,
      closeMs: Date.now() - start,
    };
    assert.equal(exitCode, 0);
    assert.ok(
      metrics.rendererCloseMs >= 0 && metrics.rendererCloseMs < 5000,
      `Window close took ${metrics.rendererCloseMs} ms`,
    );
    return metrics;
  }
  async function wait(expression, label, timeout = 20_000) {
    const until = Date.now() + timeout;
    while (Date.now() < until && !killed) {
      if (await evaluate(expression)) return;
      await sleep(200);
    }
    throw new Error(`Timeout: ${label}`);
  }
  async function screenshot(name) {
    const { data } = await cdp("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const file = path.join(output, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  }
  await wait(
    "Boolean(window.appready && window.Lampa?.__mpvInstalled && window.plugin_app_ready && document.querySelector('.card'))",
    "full Lampa initialization",
    45_000,
  );
  results.push({
    startup: await evaluate(
      "(async()=>({url:location.href,version:await electronAPI.getAppVersion(),inner:Lampa.Storage.field('player_torrent'),catalog:Boolean(document.querySelector('.menu'))}))()",
    ),
  });
  await screenshot("catalog");
  const instrument = () =>
    evaluate(
      "window.__native={};window.__lifecycle=[];for(const name of ['create','start','destroy'])Lampa.Player.listener.follow(name,()=>__lifecycle.push({name,stack:new Error().stack})); document.addEventListener('mpv-event', e=>{if(e.detail.name)__native[e.detail.name]=e.detail.data},true); Lampa.Storage.set('player_normalization',false); Lampa.Storage.set('player','inner'); Lampa.Storage.set('player_torrent','inner')",
    );
  await instrument();
  if (
    d3d11 &&
    ["--performance-only", "--timeline-only", "--orientation-only"].some(
      (flag) => process.argv.includes(flag),
    )
  ) {
    const initialContext = await evaluate(
      "({origin:location.origin,secure:isSecureContext,gpu:Boolean(navigator.gpu)})",
    );
    if (!initialContext.secure) {
      // Restore only the isolated test profile after legacy HTTP QA. Never
      // weaken Chromium security to make an insecure origin pass a GPU gate.
      const configured = await evaluate("electronAPI.store.get('lampaUrl')");
      if (reuseTestProfile && configured !== "https://kinohub.uk/")
        await evaluate(
          "void electronAPI.store.set('lampaUrl','https://kinohub.uk/')",
        );
      else await cdp("Page.navigate", { url: "https://kinohub.uk/" });
      await wait(
        "location.origin==='https://kinohub.uk' && Boolean(window.appready && Lampa?.__mpvInstalled && window.plugin_app_ready && document.querySelector('.card'))",
        "secure GPU test origin",
        45000,
      );
      await instrument();
    }
    const secureGpuContext = await evaluate(
      "({origin:location.origin,secure:isSecureContext,gpu:Boolean(navigator.gpu)})",
    );
    results.push({ secureGpuContext, initialContext });
    assert.ok(
      secureGpuContext.secure && secureGpuContext.gpu,
      "D3D11 QA requires a secure WebGPU context",
    );
  }
  if (d3d11 && process.argv.includes("--gpu-info-only")) {
    const adapters = await evaluate(`(async()=>{
      const result=[];for(const preference of ['default','low-power','high-performance']){
        const adapter=await navigator.gpu?.requestAdapter(preference==='default'?{}:{powerPreference:preference});
        result.push({preference,info:adapter?{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description}:null});
      }return result;
    })()`);
    results.push({ adapters, shutdown: await closeApplication() });
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify({ exe, runId, ok: true, results }, null, 2),
    );
    console.log(JSON.stringify({ adapters, output }, null, 2));
    return;
  }
  if (d3d11 && process.argv.includes("--orientation-only")) {
    await play("d3d11-orientation.mp4");
    const picture = await screenshot("d3d11-orientation");
    const corners = JSON.parse(
      execFileSync(
        "C:/Users/stpuh/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe",
        [
          "-c",
          "from PIL import Image,ImageStat;import json,sys;im=Image.open(sys.argv[1]).convert('RGB');w,h=im.size;print(json.dumps([ImageStat.Stat(im.crop((int(w*x)-5,int(h*y)-5,int(w*x)+5,int(h*y)+5))).mean for x,y in [(.25,.25),(.75,.25),(.25,.75),(.75,.75)]]))",
          picture,
        ],
        { encoding: "utf8", windowsHide: true },
      ),
    );
    results.push({
      orientationCorners: corners,
      shutdown: await closeApplication(),
    });
    const [red, green, blue, yellow] = corners.map((rgb) => {
      const peak = Math.max(...rgb);
      assert.ok(peak > 32, "Orientation sample is obscured or blank");
      return rgb.map((value) => value / peak);
    });
    assert.ok(
      red[0] > 0.75 && red[1] < 0.25 && red[2] < 0.25,
      "Top-left source corner is inverted",
    );
    assert.ok(
      green[1] > 0.75 && green[0] < 0.25 && green[2] < 0.25,
      "Top-right source corner is inverted",
    );
    assert.ok(
      blue[2] > 0.75 && blue[0] < 0.25 && blue[1] < 0.25,
      "Bottom-left source corner is inverted",
    );
    assert.ok(
      yellow[0] > 0.75 && yellow[1] > 0.75 && yellow[2] < 0.25,
      "Bottom-right source corner is inverted",
    );
    assert.deepEqual(profileSnapshot(), productionBefore);
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify({ exe, runId, ok: true, results }, null, 2),
    );
    console.log("D3D11 four-corner image orientation passed", output);
    return;
  }
  if (d3d11 && process.argv.includes("--performance-only")) {
    const { summarizeFrameCadence } = require("./mpv/performance-metrics.cjs");
    const tracePerformance = process.argv.includes("--trace-performance");
    const gpuRecovery = process.argv.includes("--gpu-recovery-only");
    const previewStress = process.argv.includes("--preview-stress");
    assert.ok(
      !previewStress || !gpuRecovery,
      "Preview throughput and GPU recovery are separate tests",
    );
    assert.ok(
      !gpuRecovery || !tracePerformance,
      "GPU recovery and cadence tracing are separate tests",
    );
    let traceFinished;
    const traceMarker = `lampaua-mpv-${runId}`;
    const sampleIndex = process.argv.indexOf("--sample-seconds");
    const sampleSeconds =
      sampleIndex < 0 ? 30 : Number(process.argv[sampleIndex + 1]);
    const seekIndex = process.argv.indexOf("--seek-seconds");
    const seekSeconds = seekIndex < 0 ? 0 : Number(process.argv[seekIndex + 1]);
    assert.ok(
      Number.isFinite(sampleSeconds) &&
        sampleSeconds >= 5 &&
        sampleSeconds <= 180,
    );
    assert.ok(
      Number.isFinite(seekSeconds) && seekSeconds >= 0 && seekSeconds <= 86400,
    );
    if (process.argv.includes("--assert-performance"))
      assert.ok(
        sampleSeconds >= 30,
        "Acceptance requires at least a 30-second window",
      );
    clearTimeout(deadline);
    deadline = setTimeout(terminate, (sampleSeconds + 180) * 1000);
    const mediaIndex = process.argv.indexOf("--media");
    const media =
      mediaIndex < 0
        ? "d3d11-continuous-hevc-hdr.mp4"
        : process.argv[mediaIndex + 1];
    let source;
    if (process.argv.includes("--local-torrent")) {
      const response = await fetch("http://localhost:8090/torrents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list" }),
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(response.status, 200);
      const torrents = await response.json();
      assert.equal(torrents.length, 1, "Select exactly one local test torrent");
      const torrent = torrents[0];
      const file = [...torrent.file_stats].sort(
        (a, b) => b.length - a.length,
      )[0];
      assert.ok(file && /^[a-f0-9]{40}$/i.test(torrent.hash));
      const url = new URL(
        `http://localhost:8090/stream/${encodeURIComponent(path.basename(file.path))}`,
      );
      url.searchParams.set("link", torrent.hash);
      url.searchParams.set("index", String(file.id));
      url.searchParams.set("play", "");
      source = url.href;
      results.push({ input: "local TorrServer", bytes: file.length });
    } else {
      assert.ok(files.has(media), "Create the continuous fixture first");
      source = `${base}/${encodeURIComponent(media)}`;
      results.push({ input: media });
    }
    const idleRafFps = await evaluate(`new Promise(resolve=>{
      const start=performance.now();let count=0;
      const frame=now=>{count++;if(now-start>=2000)resolve(count*1000/(now-start));else requestAnimationFrame(frame)};
      requestAnimationFrame(frame);
    })`);
    await evaluate(
      `window.__native={};Lampa.Player.play({url:${JSON.stringify(source)},title:'Перевірка плавності 4К D3D11',launch_player:'inner'})`,
    );
    await wait(
      "Lampa.PlayerVideo.video()?.currentTime>1 || Lampa.PlayerVideo.video()?.error",
      "D3D11 performance startup",
      45000,
    );
    assert.equal(
      await evaluate("Lampa.PlayerVideo.video()?.error || null"),
      null,
    );
    assert.equal(
      await evaluate("document.querySelector('mpv-video')?.mode"),
      "d3d11",
    );
    if (seekSeconds > 0) {
      await evaluate(
        `window.__performanceRestarted=false;document.querySelector('mpv-video').addEventListener('mpv-event',e=>{if(e.detail.type==='playback-restart')__performanceRestarted=true});Lampa.PlayerVideo.video().currentTime=${seekSeconds}`,
      );
      await wait(
        `__performanceRestarted && Math.abs(__native['time-pos']-${seekSeconds})<5 && !__native['paused-for-cache']`,
        "seek to measured scene",
        45000,
      );
    }
    if (process.argv.includes("--wait-for-cache"))
      await wait(
        "__native['demuxer-cache-duration']>=5 && !__native['paused-for-cache']",
        "five seconds of demuxer cache",
        60000,
      );
    if (tracePerformance || gpuRecovery) {
      const browser = await (
        await fetch(`http://127.0.0.1:${debugPort}/json/version`)
      ).json();
      traceSocket = new WebSocket(browser.webSocketDebuggerUrl);
      traceSocket.addEventListener("message", protocolMessage);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Browser trace connection timed out")),
          15000,
        );
        traceSocket.addEventListener(
          "open",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        traceSocket.addEventListener(
          "error",
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
          { once: true },
        );
      });
      if (tracePerformance) {
        traceFinished = new Promise((resolve) => {
          traceComplete = resolve;
        });
        await cdp(
          "Tracing.start",
          {
            transferMode: "ReturnAsStream",
            streamFormat: "json",
            streamCompression: "gzip",
            traceConfig: {
              recordMode: "recordUntilFull",
              traceBufferSizeInKb: 131072,
              excludedCategories: ["*"],
              includedCategories: [
                "devtools.timeline",
                "v8",
                "disabled-by-default-display.framedisplayed",
                "disabled-by-default-devtools.timeline.frame",
              ],
            },
          },
          traceSocket,
        );
      }
    }
    const firstPicture = await screenshot("d3d11-motion-before");
    await sleep(800);
    const secondPicture = await screenshot("d3d11-motion-after");
    const pixels = JSON.parse(
      execFileSync(
        "C:/Users/stpuh/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe",
        [
          "-c",
          "from PIL import Image,ImageChops,ImageStat;import sys,json;a=Image.open(sys.argv[1]).convert('RGB');b=Image.open(sys.argv[2]).convert('RGB');w,h=a.size;box=(int(w*.1),int(h*.2),int(w*.9),int(h*.8));a=a.crop(box);b=b.crop(box);print(json.dumps({'mean':sum(ImageStat.Stat(a).mean)/3,'delta':sum(ImageStat.Stat(ImageChops.difference(a,b)).mean)/3}))",
          firstPicture,
          secondPicture,
        ],
        { encoding: "utf8", windowsHide: true },
      ),
    );
    assert.ok(
      pixels.mean > 5 && pixels.delta > 0.5,
      "D3D11 compositor image is blank or static",
    );
    await sleep(tracePerformance ? 6000 : 4000);
    if (tracePerformance)
      await evaluate(`console.timeStamp(${JSON.stringify(traceMarker)})`);
    if (previewStress) await cdp("Page.bringToFront");
    if (previewStress)
      await require("./verify-mpv-timeline.cjs").startStress(evaluate);
    await evaluate(`(()=>{
      const surface=document.querySelector('mpv-video');
      if(typeof surface.drawGpuFrame!=='function')throw new Error('Rebuild the D3D11 test package for per-frame telemetry');
      window.__d3d11Cadence={active:true,startMs:performance.now(),samples:[],raf:0,overflow:false,visibilityChanges:[],longTasks:[]};
      const observer=new PerformanceObserver(list=>{for(const task of list.getEntries())if(__d3d11Cadence.longTasks.length<256)__d3d11Cadence.longTasks.push({at:task.startTime,duration:task.duration})});
      observer.observe({type:'longtask'});
      __d3d11Cadence.stopLongTasks=()=>observer.disconnect();
      const visibility=()=>{const stats=__d3d11Cadence;if(stats.active&&stats.visibilityChanges.length<128)stats.visibilityChanges.push({at:performance.now(),visibility:document.visibilityState,focused:document.hasFocus()})};
      visibility();
      document.addEventListener('visibilitychange',visibility);
      window.addEventListener('focus',visibility);
      window.addEventListener('blur',visibility);
      __d3d11Cadence.stopVisibility=()=>{document.removeEventListener('visibilitychange',visibility);window.removeEventListener('focus',visibility);window.removeEventListener('blur',visibility)};
      const draw=surface.drawGpuFrame.bind(surface);
      surface.drawGpuFrame=async(frame,metadata)=>{
        const receiveMs=performance.now();
        await draw(frame,metadata);
        const submitMs=performance.now();
        const stats=__d3d11Cadence;
        if(!stats.active)return;
        if(stats.samples.length>=24000){stats.overflow=true;return}
        stats.samples.push({...metadata,receiveMs,submitMs,releaseMs:null,
          timeSeconds:__native['time-pos'],drops:__native['frame-drop-count'],
          decoderDrops:__native['decoder-frame-drop-count'],avsync:__native.avsync,
          rafCount:stats.raf,buffering:__native['paused-for-cache'],error:surface.error||null,
          visibility:document.visibilityState,focused:document.hasFocus()});
      };
      const raf=()=>{if(__d3d11Cadence.active){__d3d11Cadence.raf++;requestAnimationFrame(raf)}};
      requestAnimationFrame(raf);
    })()`);
    await sleep(sampleSeconds * 1000);
    const measured = await evaluate(`(()=>{
      const endMs=performance.now();
      __d3d11Cadence.active=false;
      __d3d11Cadence.stopVisibility();
      __d3d11Cadence.stopLongTasks();
      return {samples:__d3d11Cadence.samples,overflow:__d3d11Cadence.overflow,visibilityChanges:__d3d11Cadence.visibilityChanges,
        measurement:{startMs:__d3d11Cadence.startMs,endMs},
        longTasks:__d3d11Cadence.longTasks,
        guestAccessRequests:performance.getEntriesByType('resource').filter(entry=>{try{return new URL(entry.name).pathname==='/testaccsdb'}catch{return false}}).map(entry=>({at:entry.startTime,duration:entry.duration})),
        state:{mode:document.querySelector('mpv-video')?.mode,width:__native.width,height:__native.height,
          fps:__native['container-fps'],hwdec:__native['hwdec-current'],pixelFormat:__native['video-params/pixelformat'],
          hardwarePixelFormat:__native['video-params/hw-pixelformat'],error:Lampa.PlayerVideo.video()?.error||null}};
    })()`);
    let preview;
    if (previewStress) {
      preview = await require("./verify-mpv-timeline.cjs").stopStress(evaluate);
      results.push({ previewStress: preview });
    }
    fs.writeFileSync(
      path.join(output, "frames.json"),
      JSON.stringify(measured.samples),
    );
    let compositor;
    if (tracePerformance) {
      await sleep(6000);
      await cdp("Tracing.end", {}, traceSocket);
      const completed = await Promise.race([
        traceFinished,
        sleep(15000).then(() => {
          throw new Error("Compositor trace completion timed out");
        }),
      ]);
      assert.ok(!completed.dataLossOccurred && completed.stream);
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const part = await cdp(
            "IO.read",
            {
              handle: completed.stream,
              size: 1048576,
            },
            traceSocket,
          );
          const bytes = Buffer.from(
            part.data,
            part.base64Encoded ? "base64" : "utf8",
          );
          size += bytes.length;
          assert.ok(size <= 128 * 1024 * 1024, "Trace archive exceeds limit");
          chunks.push(bytes);
          if (part.eof) break;
        }
      } finally {
        await cdp("IO.close", { handle: completed.stream }, traceSocket);
      }
      const archive = Buffer.concat(chunks);
      fs.writeFileSync(path.join(output, "compositor-trace.json.gz"), archive);
      const { traceEvents } = JSON.parse(
        require("node:zlib")
          .gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 })
          .toString("utf8"),
      );
      assert.ok(Array.isArray(traceEvents));
      const marker = traceEvents.find(
        (event) =>
          event.name === "TimeStamp" &&
          event.args?.data?.message === traceMarker,
      );
      assert.ok(marker, "Missing renderer trace clock marker");
      compositor =
        require("./mpv/compositor-trace.cjs").summarizeCompositorTrace(
          traceEvents,
          {
            rendererPid: marker.pid,
            startUs: marker.ts,
            endUs: marker.ts + sampleSeconds * 1e6,
            sourceFps: measured.state.fps,
          },
        );
      fs.writeFileSync(
        path.join(output, "compositor-summary.json"),
        JSON.stringify({ marker, compositor }, null, 2),
      );
    }
    const cadence = summarizeFrameCadence(
      measured.samples,
      measured.state.fps,
      idleRafFps,
      measured.measurement,
    );
    const windows = [];
    const firstTime = measured.measurement.startMs;
    for (
      let offset = 0;
      offset + 30000 <= sampleSeconds * 1000;
      offset += 30000
    ) {
      const measurement = {
        startMs: firstTime + offset,
        endMs: firstTime + offset + 30000,
      };
      const frames = measured.samples.filter(
        (frame) =>
          frame.receiveMs >= measurement.startMs &&
          frame.receiveMs < measurement.endMs,
      );
      windows.push(
        summarizeFrameCadence(
          frames,
          measured.state.fps,
          idleRafFps,
          measurement,
        ),
      );
    }
    results.push({
      requestedMode: "d3d11",
      ...measured.state,
      overflow: measured.overflow,
      visibilityChanges: measured.visibilityChanges,
      longTasks: measured.longTasks,
      guestAccessRequests: measured.guestAccessRequests,
      sampleSeconds,
      measurement: measured.measurement,
      idleRafFps,
      pixels,
      cadence,
      ...(tracePerformance ? { compositor } : {}),
      windows,
      evidence:
        "Consumer arrival and GPU submission, not physical-presentation counts. GPU-safe release times are not exposed to the page; see separate transport gate.",
    });
    await screenshot("d3d11-measured");
    if (gpuRecovery) {
      const protocol = await (
        await fetch(`http://127.0.0.1:${debugPort}/json/protocol`)
      ).json();
      assert.ok(
        protocol.domains
          .find((domain) => domain.domain === "Browser")
          ?.commands.some((command) => command.name === "crashGpuProcess"),
        "Test runtime has no GPU crash command",
      );
      const before = await evaluate("__native['time-pos']");
      assert.ok(
        before > 5,
        "GPU recovery fixture has no established resume position",
      );
      const started = Date.now();
      await cdp("Browser.crashGpuProcess", {}, traceSocket);
      await wait(
        "['webgl','canvas2d'].includes(document.querySelector('mpv-video')?.mode) && __native['time-pos']>1",
        "software recovery after GPU process loss",
        25000,
      );
      await sleep(1000);
      const resumed = await evaluate("__native['time-pos']");
      assert.ok(
        resumed >= before - 1,
        `GPU recovery lost VOD position: ${before} -> ${resumed}`,
      );
      await sleep(1200);
      assert.ok(
        await evaluate(`__native['time-pos']>${resumed + 0.5}`),
        "Playback clock did not recover",
      );
      await evaluate("Lampa.PlayerVideo.video().pause()");
      await wait("__native.pause===true", "pause after GPU recovery");
      await evaluate(
        "Lampa.PlayerVideo.video().currentTime=20;Lampa.PlayerVideo.video().play()",
      );
      await wait(
        "__native.pause===false && __native['time-pos']>=20 && __native['time-pos']<25",
        "seek/play after GPU recovery",
      );
      const first = await screenshot("gpu-recovered-before");
      await sleep(850);
      const last = await screenshot("gpu-recovered-after");
      const motion = JSON.parse(
        execFileSync(
          "C:/Users/stpuh/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe",
          [
            "-c",
            "from PIL import Image,ImageChops,ImageStat;import sys,json;a=Image.open(sys.argv[1]).convert('RGB');b=Image.open(sys.argv[2]).convert('RGB');w,h=a.size;box=(int(w*.1),int(h*.2),int(w*.9),int(h*.8));a=a.crop(box);b=b.crop(box);print(json.dumps({'mean':sum(ImageStat.Stat(a).mean)/3,'delta':sum(ImageStat.Stat(ImageChops.difference(a,b)).mean)/3}))",
            first,
            last,
          ],
          { encoding: "utf8", windowsHide: true },
        ),
      );
      assert.ok(
        motion.mean > 5 && motion.delta > 0.5,
        "GPU recovery left a blank or static picture",
      );
      const error = await evaluate("Lampa.PlayerVideo.video()?.error || null");
      assert.equal(error, null);
      results.push({
        gpuRecovery: {
          pipeline: "software",
          renderer: await evaluate("document.querySelector('mpv-video')?.mode"),
          elapsedMs: Date.now() - started,
          before,
          resumed,
          motion,
          error,
          controls: true,
        },
      });
    }
    results.push({ shutdown: await closeApplication() });
    assert.deepEqual(
      profileSnapshot(),
      productionBefore,
      "Production profile metadata changed",
    );
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify({ exe, runId, diagnostic: true, results }, null, 2),
    );
    console.log(
      JSON.stringify(
        { ...results.find((result) => result.requestedMode), output },
        null,
        2,
      ),
    );
    if (previewStress) {
      assert.ok(
        preview.requests >= Math.floor(sampleSeconds / 3),
        "Insufficient preview work during throughput measurement",
      );
      assert.ok(
        preview.frames >= Math.floor(preview.requests * 0.8),
        "Most preview requests did not decode frames",
      );
    }
    if (process.argv.includes("--assert-performance")) {
      assert.equal(
        measured.state.mode,
        "d3d11",
        "Performance run silently fell back",
      );
      assert.ok(
        measured.state.width >= 3840 && measured.state.height >= 2160,
        "Expected a 4K source",
      );
      assert.equal(
        measured.state.hwdec,
        "d3d11va",
        "Expected zero-copy hardware decoding",
      );
      assert.equal(measured.state.pixelFormat, "d3d11");
      assert.equal(measured.state.error, null);
      assert.equal(measured.overflow, false);
      assert.ok(
        measured.measurement.endMs - measured.measurement.startMs >=
          sampleSeconds * 1000,
        "Measurement ended early",
      );
      assert.equal(cadence.passed, true, JSON.stringify(cadence));
      assert.equal(windows.length, Math.floor(sampleSeconds / 30));
      for (const window of windows)
        assert.equal(window.passed, true, JSON.stringify(window));
    }
    return;
  }

  if (
    !process.argv.includes("--offline-only") &&
    !process.argv.includes("--network-only")
  ) {
    await evaluate(
      `window.__externalLaunches=0;window.__savedPath=Lampa.Storage.field('player_nw_path');Lampa.Player.listener.follow('external',()=>__externalLaunches++);Lampa.Storage.set('player_nw_path','C:/Contract/nonexistent-test-player.exe');Lampa.Player.play({url:${JSON.stringify(`${base}/h264-aac.mp4`)},title:'External routing contract',launch_player:'other'})`,
    );
    await wait("window.__externalLaunches===1", "explicit external route");
    assert.equal(await evaluate("Lampa.Storage.field('player')"), "inner");
    assert.equal(
      await evaluate("document.querySelectorAll('mpv-video').length"),
      0,
    );
    await evaluate("Lampa.Storage.set('player_nw_path',__savedPath||'')");
    results.push({
      explicitExternalRoute: true,
      externalProcessNotStarted: true,
      savedInnerUnchanged: true,
    });
  }
  async function play(name, params, data = {}, expectedEngine = "native") {
    await evaluate(
      `if(Lampa.PlayerVideo.video())Lampa.Player.close();window.__native={}; ${params ? `Lampa.PlayerVideo.setParams(${JSON.stringify(params)});` : ""} Lampa.Player.play(${JSON.stringify({ url: `${base}/${name}`, title: `Перевірка: ${name}`, launch_player: "inner", timeline: { hash: name, time: 0, percent: 0, duration: 0 }, ...data })})`,
    );
    try {
      await wait("Lampa.PlayerVideo.video()?.currentTime>0.6", `play ${name}`);
    } catch (error) {
      results.push({
        diagnostic: await evaluate(
          "({native:window.__native,lifecycle:window.__lifecycle,video:(v=>v?{connected:v.isConnected,time:v.currentTime,duration:v.duration,paused:v.paused,error:v.error,src:v.src}:null)(Lampa.PlayerVideo.video()),surface:[...document.querySelectorAll('mpv-video')].map(v=>({id:v.playerId,src:v.src,time:v.currentTime,duration:v.duration,mode:v.mode}))})",
        ),
      });
      await screenshot("failed-playback");
      throw error;
    }
    const info = await evaluate(
      "({time:Lampa.PlayerVideo.video().currentTime,duration:Lampa.PlayerVideo.video().duration,tracks:Lampa.PlayerVideo.video().audioTracks.length,codec:__native['video-codec'],audio:__native['audio-codec'],ao:__native['current-ao'],mode:document.querySelector('mpv-video')?.mode})",
    );
    assert.ok(info.duration > 10, JSON.stringify(info));
    if (d3d11 && expectedEngine === "native")
      assert.equal(
        info.mode,
        "d3d11",
        "Desktop silently fell back instead of presenting D3D11 frames",
      );
    if (
      d3d11 &&
      expectedEngine === "navigation-recovery" &&
      info.mode !== "d3d11"
    ) {
      assert.equal(
        info.mode,
        "webgl",
        "Navigation recovery did not select a supported native pipeline",
      );
      const diagnostics = fs.readFileSync(
        path.join(
          process.argv.includes("--release")
            ? path.join(output, "profile")
            : path.join(
                process.env.APPDATA,
                `LampaUaDesktopMpv${d3d11Next ? "D3d11Next" : "D3d11"}Test${reuseTestProfile ? "" : `-${runId}`}`,
              ),
          "logs/mpv-test.jsonl",
        ),
        "utf8",
      );
      const originCapabilities = await evaluate(
        "({secureContext:window.isSecureContext,webGpu:Boolean(navigator.gpu),origin:location.origin})",
      );
      const retiredOwner = /"type":"d3d11-retired-fallback"/.test(diagnostics);
      assert.ok(
        retiredOwner || !originCapabilities.webGpu,
        "Software recovery has no confirmed cause",
      );
      results.push({
        navigationRecovery: "software",
        quarantinedGpuOwner: retiredOwner,
        originCapabilities,
      });
    }
    results.push({ media: name, ...info });
  }
  if (process.argv.includes("--timeline-only")) {
    await require("./verify-mpv-timeline.cjs")({
      debugPort,
      play,
      evaluate,
      cdp,
      sleep,
      output,
      results,
    });
    results.push({ shutdown: await closeApplication() });
    assert.deepEqual(
      profileSnapshot(),
      productionBefore,
      "Production profile metadata changed",
    );
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify({ exe, runId, ok: true, results }, null, 2),
    );
    console.log("Desktop timeline QA passed", output);
    return;
  }
  if (process.argv.includes("--visual-only")) {
    await sleep(10_000);
    await play("h264-aac.mp4");
    await screenshot("visible-playback");
    await sleep(30_000);
    results.push({ shutdown: await closeApplication() });
    assert.deepEqual(profileSnapshot(), productionBefore);
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify({ exe, runId, ok: true, results }, null, 2),
    );
    console.log("Visible desktop diagnostic finished", output);
    return;
  }
  async function checkNetworkCancellation(
    name,
    requestName = name,
    afterPlayback = false,
  ) {
    await evaluate(
      `Lampa.Player.close();Lampa.Player.play({url:${JSON.stringify(`${base}/${name}`)},title:'Stalled network test',launch_player:'inner'})`,
    );
    if (afterPlayback) {
      await wait(
        "Lampa.PlayerVideo.video()?.currentTime>1",
        "playback before stalled segment",
        30_000,
      );
      await evaluate("Lampa.PlayerVideo.to(9);Lampa.PlayerVideo.play()");
    }
    for (let i = 0; i < 50; i++) {
      if (requests.some((entry) => entry.name === requestName)) break;
      await sleep(100);
    }
    assert.ok(requests.some((entry) => entry.name === requestName));
    const pingStart = Date.now();
    await evaluate("electronAPI.getAppVersion()");
    assert.ok(Date.now() - pingStart < 2000, "Main process blocked on network");
    await evaluate("Lampa.Player.close()");
    const recoveryStart = Date.now();
    await play("h264-aac.mp4");
    assert.ok(
      Date.now() - recoveryStart < 8000,
      "Stalled source blocked recovery",
    );
    results.push({
      stalledNetworkCancelled: name,
      afterPlayback,
      recoveryMs: Date.now() - recoveryStart,
    });
  }
  if (process.argv.includes("--iptv-proxy-only")) {
    await play(
      `lite/iptvportal/api/stream?target=${Buffer.from("http://provider.test/live/video.m3u8").toString("base64url")}&sig=synthetic`,
      null,
      { iptv: true },
    );
    await screenshot("iptv-proxy-hls");
    await evaluate("Lampa.Player.close()");
    results.push({ shutdown: await closeApplication() });
    assert.deepEqual(
      profileSnapshot(),
      productionBefore,
      "Production profile metadata changed",
    );
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify({ exe, runId, ok: true, results }, null, 2),
    );
    console.log("IPTV proxy HLS passed", output);
    return;
  }
  if (process.argv.includes("--network-only")) {
    await checkNetworkCancellation("stalled.mp4");
    await checkNetworkCancellation("stalled.m3u8", "stalled.ts");
    await checkNetworkCancellation("postload-stall.mp4", undefined, true);
    results.push({ shutdown: await closeApplication() });
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify({ exe, runId, ok: true, results }, null, 2),
    );
    console.log("Network cancellation passed", output);
    return;
  }
  if (process.argv.includes("--controls-only")) {
    assert.ok(
      files.has("hevc-4k-hdr.mp4"),
      "Run node scripts/create-mpv-stream-fixtures.cjs --4k-only first",
    );
    await play("hevc-4k-hdr.mp4");
    assert.equal(await evaluate("__native.width"), 3840);
    assert.equal(await evaluate("__native.height"), 2160);
    const latencies = [];
    const controlsResult = {
      fourKControls: true,
      width: 3840,
      height: 2160,
      samples: latencies,
    };
    results.push(controlsResult);
    for (let i = 0; i < 24; i++) {
      const start = Date.now();
      await evaluate(`(async()=>{
        const video=Lampa.PlayerVideo.video();
        await video.pause();
        video.currentTime=${2 + (i % 7)};
        await video.play();
        await electronAPI.getAppVersion();
      })()`);
      const elapsed = Date.now() - start;
      latencies.push(elapsed);
      assert.ok(elapsed < 2000, `4K controls blocked main for ${elapsed} ms`);
      await sleep(100);
    }
    await wait(
      "Lampa.PlayerVideo.video()?.currentTime>8.2",
      "4K seek and resume",
      30000,
    );
    await screenshot("4k-controls");
    controlsResult.maxControlMs = Math.max(...latencies);
    controlsResult.hwdec = await evaluate("__native['hwdec-current']");
    controlsResult.mode = await evaluate(
      "document.querySelector('mpv-video')?.mode",
    );
    if (d3d11) {
      assert.equal(
        controlsResult.mode,
        "d3d11",
        "D3D11 controls caused a software fallback",
      );
      assert.equal(
        controlsResult.hwdec,
        "d3d11va",
        "D3D11 control test lost zero-copy decoding",
      );
      const layout = [];
      await evaluate(
        "Lampa.PlayerVideo.video().currentTime=1;Lampa.PlayerVideo.video().play()",
      );
      await wait(
        "__native['time-pos']>=1 && __native['time-pos']<5",
        "restart layout fixture",
      );
      for (const size of [
        { width: 1280, height: 720 },
        { width: 960, height: 640 },
      ]) {
        try {
          await cdp("Emulation.setDeviceMetricsOverride", {
            ...size,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await wait(
            `innerWidth===${size.width} && innerHeight===${size.height}`,
            "resized video viewport",
          );
          await sleep(500);
          await screenshot(`4k-layout-${size.width}`);
          const state = await evaluate(
            "({mode:document.querySelector('mpv-video')?.mode,width:innerWidth,height:innerHeight,error:Lampa.PlayerVideo.video()?.error||null})",
          );
          assert.equal(state.mode, "d3d11");
          assert.equal(state.error, null);
          layout.push(state);
        } finally {
          await cdp("Emulation.clearDeviceMetricsOverride");
        }
      }
      const original = await evaluate(
        "({width:innerWidth,height:innerHeight})",
      );
      try {
        await evaluate("electronAPI.toggleFullscreen()");
        await wait(
          `innerWidth!==${original.width} || innerHeight!==${original.height}`,
          "fullscreen video viewport",
        );
        await sleep(650);
        await screenshot("4k-layout-fullscreen");
        assert.equal(
          await evaluate("document.querySelector('mpv-video')?.mode"),
          "d3d11",
        );
      } finally {
        const current = await evaluate(
          "({width:innerWidth,height:innerHeight})",
        );
        if (
          current.width !== original.width ||
          current.height !== original.height
        )
          await evaluate("electronAPI.toggleFullscreen()");
      }
      await wait(
        `innerWidth===${original.width} && innerHeight===${original.height}`,
        "windowed viewport restored",
      );
      controlsResult.layout = layout;
      controlsResult.fullscreen = true;
    }
    Object.assign(controlsResult, await closeApplication());
    assert.deepEqual(
      profileSnapshot(),
      productionBefore,
      "Production profile metadata changed",
    );
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify({ exe, runId, ok: true, results }, null, 2),
    );
    console.log("4K control responsiveness passed", output);
    return;
  }
  if (!process.argv.includes("--offline-only")) {
    if (qualityOnly)
      await evaluate(
        "window.__qualityErrors=[];document.addEventListener('error',e=>{if(['VIDEO','MPV-VIDEO'].includes(e.target.nodeName))__qualityErrors.push({src:e.target.src,error:String(e.target.error?.message||e.target.error)})},true)",
      );
    for (const name of [
      ...(qualityOnly ? ["hevc-4k-hdr.mp4"] : []),
      "h264-aac.mp4",
      "h264-ac3.mkv",
      "h264-eac3.mkv",
      "xvid-mp3.avi",
    ]) {
      await play(name);
      await screenshot(name);
      if (qualityOnly) {
        await sleep(5000);
        assert.equal(
          await evaluate("Boolean(Lampa.PlayerVideo.video()?.error)"),
          false,
          name,
        );
        if (name === "hevc-4k-hdr.mp4") {
          assert.equal(await evaluate("__native.width"), 3840);
          assert.equal(await evaluate("__native.height"), 2160);
          results.push({ positiveQuality: "4K HEVC", error: false });
        }
      }
    }
    await evaluate("Lampa.PlayerVideo.pause()");
    await sleep(400);
    const pausedTime = await evaluate("Lampa.PlayerVideo.video().currentTime");
    await sleep(700);
    assert.ok(
      Math.abs(
        (await evaluate("Lampa.PlayerVideo.video().currentTime")) - pausedTime,
      ) < 0.15,
      "Pause did not stabilize",
    );
    await evaluate(
      "Lampa.PlayerVideo.volume(0.37);Lampa.PlayerVideo.speed('1.5');Lampa.PlayerVideo.to(5)",
    );
    await wait(
      "Lampa.PlayerVideo.video().currentTime>=5 && Math.abs(__native.volume-37)<0.1 && __native.speed===1.5",
      "seek, volume, speed",
    );
    const first = await screenshot("moving-1");
    await sleep(800);
    const second = await screenshot("moving-2");
    const python =
      "C:/Users/stpuh/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe";
    const pixels = JSON.parse(
      execFileSync(
        python,
        [
          "-c",
          "from PIL import Image,ImageChops,ImageStat;import sys,json;a=Image.open(sys.argv[1]).convert('RGB');b=Image.open(sys.argv[2]).convert('RGB');w,h=a.size;box=(int(w*.2),int(h*.25),int(w*.8),int(h*.6));a=a.crop(box);b=b.crop(box);print(json.dumps({'mean':sum(ImageStat.Stat(a).mean)/3,'delta':sum(ImageStat.Stat(ImageChops.difference(a,b)).mean)/3}))",
          first,
          second,
        ],
        { encoding: "utf8" },
      ),
    );
    assert.ok(
      pixels.mean > 5 && pixels.delta > 0.5,
      `Blank/static picture: ${JSON.stringify(pixels)}`,
    );
    results.push({ controls: "pause/seek/volume/speed", pixels });
    const ytdlArgument = process.argv.indexOf("--ytdl-plugin");
    const ytdlFile =
      ytdlArgument >= 0
        ? process.argv[ytdlArgument + 1]
        : path.resolve(root, "../lampac/module/Ytdl/plugins/ytdl.js");
    const ytdlSource = fs.readFileSync(ytdlFile, "utf8");
    const declarations = parse(ytdlSource, { ecmaVersion: "latest" }).body[0]
      .expression.callee.body.body;
    const names = new Set(["isDashUrl", "destroyDash", "installDashAdapter"]);
    const functions = declarations.filter(
      (node) => node.type === "FunctionDeclaration" && names.has(node.id.name),
    );
    assert.equal(
      functions.length,
      3,
      "Current Ytdl DASH adapter contract changed",
    );
    await wait("Boolean(window.dashjs)", "browser DASH library available");
    const dash720 = `${base}/ytdl/manifest?quality=720&token=synthetic%2Btoken`;
    const dash1080 = `${base}/ytdl/manifest?quality=1080&token=synthetic%2Btoken`;
    const dashBlocked = `${base}/ytdl/manifest?quality=blocked`;
    await evaluate(`(()=>{
      let dashPlayer=null,originalPlayerVideoUrl=null;
      const dashFallbacks=${JSON.stringify({ [dash720]: `${base}/h264-aac.mp4`, [dash1080]: `${base}/h264-aac.mp4`, [dashBlocked]: `${base}/h264-aac.mp4` })};
      ${functions.map((node) => ytdlSource.slice(node.start, node.end)).join("\n")}
      window.__ytdlWarnings=[];const notify=Lampa.Noty.show;
      Lampa.Noty.show=function(message,...args){if(String(message).includes('DASH'))__ytdlWarnings.push(message);return notify.call(this,message,...args)};
      installDashAdapter();
    })()`);
    results.push({
      ytdlAdapterSourceSHA256: crypto
        .createHash("sha256")
        .update(ytdlSource)
        .digest("hex"),
    });
    await evaluate("Lampa.Storage.set('video_quality_default','720')");
    await play(
      "ytdl/manifest?quality=720&token=synthetic%2Btoken",
      null,
      {
        quality: { "720p": dash720, "1080p": dash1080 },
      },
      "browser",
    );
    await wait(
      "Lampa.PlayerVideo.video().videoWidth===1280",
      "browser DASH 720p video",
    );
    if (qualityOnly) {
      await sleep(5000);
      assert.equal(
        await evaluate("Boolean(Lampa.PlayerVideo.video()?.error)"),
        false,
      );
      results.push({ positiveQuality: "720p browser DASH", error: false });
    }
    await evaluate(
      `window.__native={};Lampa.PlayerPanel.listener.send('quality',{name:'1080p',url:${JSON.stringify(dash1080)}})`,
    );
    await wait(
      "Lampa.PlayerVideo.video()?.currentTime>0.6 && Lampa.PlayerVideo.video().videoWidth===1920 && Lampa.PlayerVideo.video().nodeName==='VIDEO'",
      "browser DASH quality switch to 1080p",
    );
    assert.equal(
      await evaluate("document.querySelectorAll('mpv-video').length"),
      0,
    );
    assert.deepEqual(await evaluate("__ytdlWarnings"), []);
    await evaluate("Lampa.PlayerVideo.pause()");
    await sleep(600);
    const dashPaused = await evaluate("Lampa.PlayerVideo.video().currentTime");
    await sleep(400);
    assert.ok(
      Math.abs(
        (await evaluate("Lampa.PlayerVideo.video().currentTime")) - dashPaused,
      ) < 0.15,
    );
    await evaluate("Lampa.PlayerVideo.to(5);Lampa.PlayerVideo.play()");
    await wait("Lampa.PlayerVideo.video().currentTime>5.3", "DASH seek/resume");
    await screenshot("ytdl-dash-1080p");
    if (qualityOnly) {
      await sleep(5000);
      assert.equal(
        await evaluate("Boolean(Lampa.PlayerVideo.video()?.error)"),
        false,
      );
      results.push({ positiveQuality: "1080p browser DASH", error: false });
    }
    assert.ok(
      requests.some((entry) => /dash-1080-chunk-0/.test(entry.name)),
      "Separate video segment requested",
    );
    assert.ok(
      requests.some((entry) => /dash-1080-chunk-1/.test(entry.name)),
      "Separate audio segment requested",
    );
    assert.ok(
      requests.some(
        (entry) =>
          entry.name === "ytdl/manifest" &&
          entry.query.includes("token=synthetic%2Btoken"),
      ),
      "Signed query preserved",
    );
    results.push({
      ytdlDash: true,
      qualitySwitch: "720p -> 1080p",
      separateAudioVideo: true,
      pauseSeek: true,
      fallback360p: false,
      engine: "browser DASH",
    });
    if (qualityOnly) {
      await play("native-dash/manifest.mpd?quality=1080");
      await sleep(5000);
      assert.equal(
        await evaluate("Boolean(Lampa.PlayerVideo.video()?.error)"),
        false,
      );
      assert.deepEqual(await evaluate("__qualityErrors"), []);
      results.push({
        positiveQuality: "1080p native DASH",
        error: false,
        intentionalFailuresSkipped: true,
      });
      results.push({ shutdown: await closeApplication() });
      assert.deepEqual(profileSnapshot(), productionBefore);
      fs.writeFileSync(
        path.join(output, "results.json"),
        JSON.stringify({ exe, runId, ok: true, results }, null, 2),
      );
      console.log("Positive 720p/1080p/4K quality checks passed", output);
      return;
    }
    await evaluate(
      `Lampa.Player.close();Lampa.Player.play({url:${JSON.stringify(dashBlocked)},title:'Очікувана тестова помилка HTTP 503',launch_player:'inner'})`,
    );
    for (
      let i = 0;
      i < 100 &&
      !requests.some((entry) => entry.name.startsWith("ytdl/blocked-dash-"));
      i++
    )
      await sleep(100);
    assert.ok(
      requests.some((entry) => entry.name.startsWith("ytdl/blocked-dash-")),
    );
    assert.equal(await evaluate("Lampa.PlayerVideo.video().nodeName"), "VIDEO");
    assert.equal(
      await evaluate("document.querySelectorAll('mpv-video').length"),
      0,
    );
    const dashRecoveryStart = Date.now();
    await evaluate("electronAPI.getAppVersion();Lampa.Player.close()");
    await play("h264-aac.mp4");
    assert.ok(
      Date.now() - dashRecoveryStart < 8000,
      "Failed browser DASH blocked native playback recovery",
    );
    results.push({
      failedBrowserDashCancelled: true,
      recoveryMs: Date.now() - dashRecoveryStart,
    });
    await play("native-dash/manifest.mpd?quality=1080");
    assert.match(await evaluate("__native['audio-codec']"), /AAC/);
    results.push({ genericNativeDash: true, boundedRanges: true });
    for (const name of [
      "native-dash/manifest.mpd?quality=missing",
      "native-dash/manifest.mpd?quality=local",
      "iptv/local.m3u8",
      "sisi/video.mp4",
    ]) {
      await evaluate(
        `Lampa.Player.close();Lampa.Player.play({url:${JSON.stringify(`${base}/${name}`)},title:'Очікувана тестова помилка потоку',launch_player:'inner'})`,
      );
      await wait(
        "Boolean(Lampa.PlayerVideo.video()?.error)",
        `expected error ${name}`,
      );
      const error = await evaluate("Lampa.PlayerVideo.video().error");
      if (name.includes("missing"))
        assert.deepEqual(error, { code: 2, message: "HTTP 404" });
      if (name === "sisi/video.mp4")
        assert.deepEqual(error, { code: 2, message: "HTTP 403" });
      results.push({ negative: name, expectedFailure: true, error });
    }
    await play("iptv/channel.m3u8", null, { iptv: true });
    await play(
      `lite/iptvportal/api/stream?target=${Buffer.from("http://provider.test/live/video.m3u8").toString("base64url")}&sig=synthetic`,
      null,
      { iptv: true },
    );
    await play("iptv/channel.ts", null, { iptv: true });
    await evaluate(
      `Lampa.Player.close();Lampa.Player.play({url:${JSON.stringify(`${base}/iptv/live.m3u8`)},title:'IPTV non-ending HLS',iptv:true,launch_player:'inner'})`,
    );
    await wait(
      "Lampa.PlayerVideo.video()?.currentTime>0.6",
      "non-ending IPTV HLS",
    );
    await screenshot("iptv-hls");
    results.push({
      iptv: "HLS VOD, HTTP MPEG-TS, non-ending HLS",
      channelSwitches: 2,
    });
    const protectedHeaders = {
      Referer: "https://provider.test/watch",
      "User-Agent": "LampaUa-SISI-Test",
      Authorization: "Bearer synthetic-test",
    };
    await play("sisi/video.mp4", null, { headers: protectedHeaders });
    await play("sisi/channel.m3u8", null, { headers: protectedHeaders });
    const cleanStart = requests.length;
    await play("h264-aac.mp4");
    assert.ok(
      requests.slice(cleanStart).some((entry) => entry.name === "h264-aac.mp4"),
    );
    for (const entry of requests
      .slice(cleanStart)
      .filter((entry) => entry.name === "h264-aac.mp4")) {
      assert.equal(entry.headers.authorization, undefined);
      assert.equal(entry.headers.referer, undefined);
      assert.notEqual(
        entry.headers["user-agent"],
        protectedHeaders["User-Agent"],
      );
    }
    results.push({
      sisi: "protected MP4 and HLS",
      headersForwarded: true,
      headersClearedForNextSource: true,
    });
    await checkNetworkCancellation("stalled.mp4");
    await checkNetworkCancellation("stalled.m3u8", "stalled.ts");
    await checkNetworkCancellation("postload-stall.mp4", undefined, true);
    const subtitlePackets = JSON.parse(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "s",
          "-show_packets",
          "-of",
          "json",
          files.get("tracks-subs.mkv"),
        ],
        { encoding: "utf8", windowsHide: true },
      ),
    ).packets;
    assert.ok(
      subtitlePackets?.length,
      "Empty embedded subtitle fixture; run create-mpv-stream-fixtures.cjs --tracks-subs",
    );
    await play("tracks-subs.mkv", { track: 1, sub: 0 });
    await wait(
      "Lampa.PlayerVideo.video().audioTracks.length===2 && Lampa.PlayerVideo.video().textTracks.length===1",
      "audio and subtitle discovery",
    );
    const audioId = await evaluate(
      "Lampa.PlayerVideo.video().audioTracks[1].id",
    );
    const subId = await evaluate("Lampa.PlayerVideo.video().textTracks[0].id");
    await wait(
      `String(__native.aid)===String(${audioId}) && String(__native.sid)===String(${subId})`,
      "restored audio/subtitle selection",
    );
    results.push({ restoredTrackSelection: true });
    await evaluate(
      "Lampa.PlayerVideo.video().audioTracks[1].enabled=true;Lampa.PlayerVideo.video().textTracks[0].mode='showing';Lampa.PlayerVideo.subsview(true)",
    );
    await wait(
      `String(__native.aid)===String(${audioId}) && String(__native.sid)===String(${subId})`,
      "native track selection",
    );
    await wait(
      "Lampa.PlayerVideo.video().currentTime > 2",
      "embedded subtitle display interval",
    );
    await evaluate("Lampa.PlayerPanel.hide()");
    await sleep(500);
    await screenshot("subtitles-on");
    await evaluate(
      "Lampa.PlayerVideo.video().textTracks[0].mode='disabled';Lampa.PlayerVideo.subsview(false);Lampa.PlayerVideo.video().muted=true",
    );
    await wait(
      "__native.sid==='no' && __native.volume===0",
      "subtitle off and mute",
    );
    await evaluate("Lampa.PlayerVideo.video().muted=false");
    await wait("__native.volume>0", "unmute");
    results.push({
      trackControls: { audioId, subId, muted: true, unmuted: true },
    });
    await play("resume-long.mp4");
    const resumeHash = `${runId}-resume`;
    const resumePlay = `Lampa.Player.play({url:${JSON.stringify(`${base}/resume-long.mp4`)},title:'Resume test',launch_player:'inner',timeline:Lampa.Timeline.view(${JSON.stringify(resumeHash)})})`;
    await evaluate(
      `Lampa.Player.close();Lampa.Storage.set('player_timecode','continue');${resumePlay}`,
    );
    await wait(
      "Lampa.PlayerVideo.video()?.currentTime>0.5",
      "resume fixture start",
    );
    await evaluate("Lampa.PlayerVideo.to(20)");
    await wait("Lampa.PlayerVideo.video()?.currentTime>=20", "timeline seek");
    await sleep(400);
    await evaluate("Lampa.Player.close()");
    const saved = await evaluate(
      `Lampa.Timeline.view(${JSON.stringify(resumeHash)})`,
    );
    assert.ok(
      saved.time >= 20 && saved.duration > 50,
      `Position not saved: ${JSON.stringify(saved)}`,
    );
    await evaluate(resumePlay);
    await wait(
      "Lampa.PlayerVideo.video()?.currentTime>=19",
      "saved position resume",
    );
    results.push({
      savedPosition: saved.time,
      resumedPosition: await evaluate("Lampa.PlayerVideo.video().currentTime"),
    });
    for (const name of ["missing.mp4", "redirect-local", "nested-local.m3u"]) {
      await evaluate(
        `Lampa.Player.close();Lampa.Player.play({url:${JSON.stringify(`${base}/${name}`)},title:'Negative MPV test',launch_player:'inner'})`,
      );
      await wait(
        "Boolean(Lampa.PlayerVideo.video()?.error)",
        `negative ${name}`,
      );
      results.push({
        negative: name,
        error: await evaluate("Lampa.PlayerVideo.video().error"),
      });
    }
    await play("xvid-mp3.avi");
    await evaluate(
      "Lampa.Storage.set('mpv_test_preserved','saved');Lampa.Storage.set('player','other');Lampa.__mpvInstalled=false",
    );
    await cdp("Page.reload");
    await wait(
      "Boolean(window.appready && Lampa?.__mpvInstalled && window.plugin_app_ready && document.querySelector('.card'))",
      "reload initialization",
      45_000,
    );
    assert.equal(
      await evaluate("Lampa.Storage.field('player')"),
      "other",
      "Reload overwrote saved external choice",
    );
    assert.equal(
      await evaluate("Lampa.Storage.get('mpv_test_preserved')"),
      "saved",
    );
    await instrument();
    await play("h264-aac.mp4", null, {}, "navigation-recovery");
    results.push({ reload: true, savedSettings: true });
    const urlBeforeLegacy = await evaluate("electronAPI.store.get('lampaUrl')");
    await evaluate(
      "Lampa.__mpvInstalled=false;void electronAPI.store.set('lampaUrl','http://lampaua.mooo.com/')",
    );
    await wait(
      "location.origin==='http://lampaua.mooo.com' && Boolean(window.appready && Lampa?.__mpvInstalled && window.plugin_app_ready && document.querySelector('.card'))",
      "legacy HTTP Lampa initialization",
      45_000,
    );
    await instrument();
    await play("xvid-mp3.avi", null, {}, "navigation-recovery");
    results.push({ legacyOrigin: await evaluate("location.origin") });
    await screenshot("legacy-http-playback");
    await evaluate(
      "Lampa.Player.close();Lampa.Controller.toggle('settings');Lampa.Settings.create('app_settings')",
    );
    await wait(
      "document.body.classList.contains('settings--open')",
      "visible app settings",
    );
    await sleep(700);
    await screenshot("settings");
    await cdp("Emulation.setDeviceMetricsOverride", {
      width: 800,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await screenshot("settings-800x600");
    await cdp("Emulation.clearDeviceMetricsOverride");
    await evaluate("Lampa.Controller.toggle('content')");
    await play("xvid-mp3.avi", null, {}, "navigation-recovery");
    await evaluate("Lampa.Player.close();Lampa.PlayerVideo.video()?.destroy()");
    const stressLatencies = [];
    for (let cycle = 0; cycle < 20; cycle++) {
      const start = Date.now();
      await evaluate(
        `(async()=>{const p=await _electronMpvVideo.create({renderMode:'canvas2d',width:320,height:180});await p.open(${JSON.stringify(`${base}/h264-aac.mp4`)});await p.play();await new Promise(r=>setTimeout(r,80));await p.destroy()})()`,
      );
      const elapsed = Date.now() - start;
      assert.ok(
        elapsed < 5000,
        `Native stress cycle ${cycle} took ${elapsed} ms`,
      );
      stressLatencies.push(elapsed);
    }
    results.push({ nativeCallbackStressCycles: 20, stressLatencies });
    if (urlBeforeLegacy !== "http://lampaua.mooo.com/") {
      await evaluate(
        `void electronAPI.store.set('lampaUrl',${JSON.stringify(urlBeforeLegacy)})`,
      );
      await wait(
        `location.origin===${JSON.stringify(new URL(urlBeforeLegacy).origin)} && Boolean(window.appready && Lampa?.__mpvInstalled && window.plugin_app_ready && document.querySelector('.card'))`,
        "restore test origin after legacy QA",
        45000,
      );
      await instrument();
    }
  }
  await cdp("Network.enable");
  await cdp("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp("Network.setBypassServiceWorker", { bypass: true });
  await cdp("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await cdp("Fetch.enable", {
    patterns: [
      {
        urlPattern: "*kinohub.uk/*",
        resourceType: "Document",
        requestStage: "Request",
      },
    ],
  });
  const offlineNavigation = await cdp("Page.navigate", {
    url: `https://kinohub.uk/?mpv-offline=${Date.now()}`,
  });
  results.push({ offlineNavigation });
  try {
    await wait(
      "/LampaUa/.test(document.querySelector('h1')?.textContent || '')",
      "unavailable-site error page",
    );
  } catch (error) {
    results.push({
      offlineDiagnostic: await evaluate(
        "({url:location.href,text:document.body?.innerText?.slice(0,1500)})",
      ),
    });
    await screenshot("offline-diagnostic");
    throw error;
  }
  await screenshot("site-unavailable");
  results.push({ unavailableSiteErrorPage: true });
  await cdp("Fetch.disable");
  await cdp("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await cdp("Page.reload");
  await wait(
    "Boolean(window.appready && Lampa?.__mpvInstalled && window.plugin_app_ready && document.querySelector('.card'))",
    "offline recovery initialization",
    45_000,
  );
  await instrument();
  await play("xvid-mp3.avi", null, {}, "navigation-recovery");
  await evaluate(
    `Lampa.Player.close();Lampa.Player.play({url:${JSON.stringify(`${base}/h264-aac.mp4`)},title:'Close during creation',launch_player:'inner'});`,
  );
  const shutdown = await closeApplication();
  assert.deepEqual(
    profileSnapshot(),
    productionBefore,
    "Production profile metadata changed",
  );
  results.push({
    cleanExit: true,
    productionProfileMetadataUnchanged: true,
    shutdown,
  });
  fs.writeFileSync(
    path.join(output, "results.json"),
    JSON.stringify({ exe, runId, ok: true, results }, null, 2),
  );
  console.log("Full desktop smoke passed", output);
}
main()
  .catch(async (error) => {
    console.error(error);
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify(
        { exe, runId, ok: false, error: String(error), results },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    if (process.argv.includes("--hold-on-failure")) {
      console.error(
        "Holding isolated QA process for stack inspection, PID",
        child?.pid,
      );
      await sleep(60000);
    }
  })
  .finally(async () => {
    clearTimeout(deadline);
    ws?.close();
    traceSocket?.close();
    terminate();
    if (child && !appExited)
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        sleep(10_000),
      ]);
    server?.closeAllConnections();
    server?.close();
    log.end();
  });
