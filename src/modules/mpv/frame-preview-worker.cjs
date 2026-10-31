const native = require(process.argv[2]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Keep one isolated decoder warm. Cancellation/deadline/source changes terminate
// this process without touching the visible player's queues or render context.
let player, identity;
let gpu = false,
  busy = false,
  dirty = false,
  loaded = false;
let width = 0,
  height = 0;
process.parentPort.on("message", async ({ data }) => {
  if (busy) return;
  busy = true;
  try {
    const nextIdentity = JSON.stringify([
      data.source,
      data.headers,
      data.format,
    ]);
    const reused = !!player;
    if (!player) {
      identity = nextIdentity;
      try {
        player = await native.createD3d11Player({
          width: 320,
          height: 180,
          previewStart: data.seconds,
        });
        gpu = true;
      } catch {
        player = new native.MpvPlayer({
          mode: "software",
          preview: true,
          start: data.seconds,
        });
      }
      player.setUpdateCallback(() => {
        dirty = true;
      });
      player.open(data.source, data.headers, data.format);
    } else {
      if (identity !== nextIdentity) throw new Error("Source changed");
      player.pollEvents();
      dirty = false;
      player.seek(data.seconds);
    }
    let restarted = false,
      seekSeen = !reused,
      time = -1,
      lastFrame;
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      for (const event of player.pollEvents()) {
        if (event.error || event.type === "end-file")
          throw new Error("Preview unavailable");
        if (event.type === "file-loaded") loaded = true;
        if (event.type === "seek") {
          seekSeen = true;
          lastFrame = null;
          restarted = false;
        }
        if (event.type === "playback-restart") restarted = true;
        if (event.name === "time-pos" && typeof event.data === "number")
          time = event.data;
        if (event.name === "width") width = Number(event.data) || 0;
        if (event.name === "height") height = Number(event.data) || 0;
      }
      if (dirty && loaded && seekSeen && width > 0 && height > 0) {
        dirty = false;
        const scale = Math.min(320 / width, 180 / height);
        const render = gpu
          ? player.renderPreviewFrame.bind(player)
          : player.renderFrame.bind(player);
        const frame = await render(
          Math.max(2, Math.floor(width * scale)),
          Math.max(2, Math.floor(height * scale)),
        );
        if (frame) lastFrame = frame;
      }
      if (lastFrame && restarted && Math.abs(time - data.seconds) <= 2) {
        process.parentPort.postMessage({ ...lastFrame, seconds: time });
        return;
      }
      await sleep(10);
    }
    throw new Error("Preview deadline");
  } catch {
    // Do not forward provider URLs, headers or native errors to renderer/logs.
    process.parentPort.postMessage(null);
  } finally {
    busy = false;
  }
});
