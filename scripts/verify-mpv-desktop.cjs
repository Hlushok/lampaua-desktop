const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const { parse } = require("acorn");
const root = path.resolve(__dirname, "..");
const exe = process.argv[process.argv.indexOf("--exe") + 1];
assert.ok(
  exe && fs.existsSync(exe),
  "Pass --exe pointing to the full desktop build",
);
const runId = `run-${Date.now()}`;
const output = path.join(root, ".cache/mpv-desktop-test/evidence", runId);
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
let server;
let killed = false;
let appExited = false;
let exitCode;
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
        : [`--mpv-test-run=${runId}`]),
      `--remote-debugging-port=${debugPort}`,
      "--remote-debugging-address=127.0.0.1",
    ],
    { windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on("exit", (code) => {
    appExited = true;
    exitCode = code;
  });
  const exit = new Promise((resolve) => child.once("exit", resolve));
  child.on("error", (error) => {
    log.write(String(error));
  });
  deadline = setTimeout(terminate, 300_000);
  let target;
  for (let i = 0; i < 160; i++) {
    if (appExited)
      throw new Error(`Application exited during startup: ${exitCode}`);
    try {
      target = (
        await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      ).find((entry) => entry.type === "page");
    } catch {
      /* The endpoint is not available until Chromium starts. */
    }
    if (target) break;
    await sleep(250);
  }
  assert.ok(target, "Desktop debugging target not found");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const response = JSON.parse(data);
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
  });
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
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
  async function play(name, params, data = {}) {
    await evaluate(
      `if(Lampa.PlayerVideo.video())Lampa.Player.close();window.__native={}; ${params ? `Lampa.PlayerVideo.setParams(${JSON.stringify(params)});` : ""} Lampa.Player.play(${JSON.stringify({ url: `${base}/${name}`, title: "LampaUa MPV test", launch_player: "inner", timeline: { hash: name, time: 0, percent: 0, duration: 0 }, ...data })})`,
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
      "({time:Lampa.PlayerVideo.video().currentTime,duration:Lampa.PlayerVideo.video().duration,tracks:Lampa.PlayerVideo.video().audioTracks.length,codec:__native['video-codec'],audio:__native['audio-codec'],ao:__native['current-ao']})",
    );
    assert.ok(info.duration > 10, JSON.stringify(info));
    results.push({ media: name, ...info });
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
    await evaluate("Lampa.Player.close();electronAPI.closeApp()");
    await Promise.race([
      exit,
      sleep(12000).then(() => {
        throw new Error("App did not close after proxy HLS");
      }),
    ]);
    assert.equal(exitCode, 0);
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
    await evaluate("electronAPI.closeApp()");
    await Promise.race([
      exit,
      sleep(12_000).then(() => {
        throw new Error("App did not close after network test");
      }),
    ]);
    assert.equal(exitCode, 0);
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify({ exe, runId, ok: true, results }, null, 2),
    );
    console.log("Network cancellation passed", output);
    return;
  }
  if (!process.argv.includes("--offline-only")) {
    for (const name of [
      "h264-aac.mp4",
      "h264-ac3.mkv",
      "h264-eac3.mkv",
      "xvid-mp3.avi",
    ]) {
      await play(name);
      await screenshot(name);
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
    await play("ytdl/manifest?quality=720&token=synthetic%2Btoken", null, {
      quality: { "720p": dash720, "1080p": dash1080 },
    });
    await wait(
      "Lampa.PlayerVideo.video().videoWidth===1280",
      "browser DASH 720p video",
    );
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
    await evaluate(
      `Lampa.Player.close();Lampa.Player.play({url:${JSON.stringify(dashBlocked)},title:'DASH network failure',launch_player:'inner'})`,
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
        `Lampa.Player.close();Lampa.Player.play({url:${JSON.stringify(`${base}/${name}`)},title:'Expected stream failure',launch_player:'inner'})`,
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
    await play("h264-aac.mp4");
    results.push({ reload: true, savedSettings: true });
    await evaluate(
      "Lampa.__mpvInstalled=false;void electronAPI.store.set('lampaUrl','http://lampaua.mooo.com/')",
    );
    await wait(
      "location.origin==='http://lampaua.mooo.com' && Boolean(window.appready && Lampa?.__mpvInstalled && window.plugin_app_ready && document.querySelector('.card'))",
      "legacy HTTP Lampa initialization",
      45_000,
    );
    await instrument();
    await play("xvid-mp3.avi");
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
    await play("xvid-mp3.avi");
    await evaluate(
      `(async()=>{Lampa.Player.close();await Lampa.PlayerVideo.video()?.destroy();for(let i=0;i<20;i++){const p=await _electronMpvVideo.create({renderMode:'canvas2d',width:320,height:180});await p.open(${JSON.stringify(`${base}/h264-aac.mp4`)});await p.play();await new Promise(r=>setTimeout(r,80));await p.destroy()}})()`,
    );
    results.push({ nativeCallbackStressCycles: 20 });
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
  await play("xvid-mp3.avi");
  await evaluate(
    `Lampa.Player.close();Lampa.Player.play({url:${JSON.stringify(`${base}/h264-aac.mp4`)},title:'Close during creation',launch_player:'inner'});`,
  );
  await evaluate("electronAPI.closeApp()");
  await Promise.race([
    exit,
    sleep(12_000).then(() => {
      throw new Error("App did not close cleanly during playback");
    }),
  ]);
  assert.equal(exitCode, 0);
  assert.deepEqual(
    profileSnapshot(),
    productionBefore,
    "Production profile metadata changed",
  );
  results.push({ cleanExit: true, productionProfileMetadataUnchanged: true });
  fs.writeFileSync(
    path.join(output, "results.json"),
    JSON.stringify({ exe, runId, ok: true, results }, null, 2),
  );
  console.log("Full desktop smoke passed", output);
}
main()
  .catch((error) => {
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
  })
  .finally(async () => {
    clearTimeout(deadline);
    ws?.close();
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
