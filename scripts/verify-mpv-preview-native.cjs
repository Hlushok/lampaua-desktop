const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");

async function main() {
  if (process.argv[2] !== "--child") {
    const [electron, addon, fixture] = process.argv.slice(2);
    const result = spawnSync(
      path.resolve(electron),
      [__filename, "--child", path.resolve(addon), path.resolve(fixture)],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          PATH:
            path.dirname(path.resolve(addon)) +
            path.delimiter +
            process.env.PATH,
        },
        encoding: "utf8",
        windowsHide: true,
        timeout: 20000,
      },
    );
    assert.equal(
      result.status,
      0,
      result.stderr || result.stdout || result.error?.message,
    );
    console.log(result.stdout.trim());
    return;
  }
  const native = require(process.argv[3]);
  assert.equal(
    typeof native.MpvPlayer.prototype.renderPreviewFrame,
    "function",
    "Private D3D11 preview readback is missing",
  );
  const file = process.argv[4];
  const server = http.createServer((req, res) => {
    const size = fs.statSync(file).size;
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    res.writeHead(match ? 206 : 200, {
      "Content-Length": end - start + 1,
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      ...(match ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    });
    const stream = fs.createReadStream(file, { start, end });
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let player;
  try {
    player = await native.createD3d11Player({ width: 320, height: 180 });
    await assert.rejects(player.renderPreviewFrame(320, 180));
    player.open(
      `http://127.0.0.1:${server.address().port}/video.mp4`,
      [],
      "auto",
    );
    let regularFrame;
    const regularDeadline = Date.now() + 5000;
    while (!regularFrame && Date.now() < regularDeadline) {
      player.pollEvents();
      regularFrame = await player.renderD3d11Frame(320, 180, 1);
      if (!regularFrame)
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(regularFrame, "Rejected preview poisoned the regular decoder");
    await player.releaseD3d11Frame(regularFrame.key);
    await player.destroy();
    player = null;
    await assert.rejects(
      native.createD3d11Player({ width: 320, height: 180, previewStart: -1 }),
    );
    await assert.rejects(
      native.createD3d11Player({ width: 640, height: 360, previewStart: 4 }),
    );
    const start = Date.now();
    player = await native.createD3d11Player({
      width: 320,
      height: 180,
      previewStart: 4,
    });
    await assert.rejects(player.renderPreviewFrame(321, 180));
    let dirty = false,
      loaded = false,
      time = -1,
      frame;
    player.setUpdateCallback(() => {
      dirty = true;
    });
    player.open(
      `http://127.0.0.1:${server.address().port}/video.mp4`,
      [],
      "auto",
    );
    while (Date.now() - start < 10000) {
      for (const event of player.pollEvents()) {
        assert.ok(!event.error, event.error);
        if (event.type === "file-loaded") loaded = true;
        if (event.name === "time-pos" && typeof event.data === "number")
          time = event.data;
      }
      if (loaded && dirty) {
        dirty = false;
        const next = await player.renderPreviewFrame(320, 180);
        if (next) frame = next;
      }
      if (frame && Math.abs(time - 4) < 0.5) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(frame, "No actual preview frame");
    assert.equal(frame.width, 320);
    assert.equal(frame.height, 180);
    assert.equal(frame.rgba.byteLength, 320 * 180 * 4);
    let min = 255,
      max = 0;
    for (let i = 0; i < frame.rgba.length; i += 4) {
      min = Math.min(min, frame.rgba[i]);
      max = Math.max(max, frame.rgba[i]);
    }
    assert.ok(max - min > 20, "Preview pixels are blank");
    console.log(
      JSON.stringify({
        nativePreview: true,
        seconds: time,
        width: frame.width,
        height: frame.height,
        range: max - min,
        ms: Date.now() - start,
      }),
    );
  } finally {
    if (player) await player.destroy();
    server.closeAllConnections();
    server.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
