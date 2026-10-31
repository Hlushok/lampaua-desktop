const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");

for (const software of [false, true])
  test(`preview worker ${software ? "software" : "D3D11"} reuses its decoder, waits for a new seek, and rejects source changes`, async () => {
    let handle,
      update,
      events = [],
      creates = 0,
      opens = 0,
      seeks = 0,
      renders = 0;
    const output = [];
    const player = {
      setUpdateCallback(callback) {
        update = callback;
      },
      open() {
        opens++;
        events = [
          { type: "file-loaded" },
          { name: "width", data: 1920 },
          { name: "height", data: 1080 },
          { name: "time-pos", data: 5 },
          { type: "playback-restart" },
        ];
        update();
      },
      seek(seconds) {
        seeks++;
        // A dirty callback alone must not reuse the old paused frame.
        update();
        setTimeout(() => {
          events = [
            { type: "seek" },
            { name: "time-pos", data: seconds },
            { type: "playback-restart" },
          ];
          update();
        }, 15);
      },
      pollEvents() {
        const next = events;
        events = [];
        return next;
      },
      async renderPreviewFrame(width, height) {
        renders++;
        return { width, height, rgba: new Uint8Array(width * height * 4) };
      },
    };
    player.renderFrame = player.renderPreviewFrame;
    vm.runInNewContext(
      fs.readFileSync(
        require.resolve("../src/modules/mpv/frame-preview-worker.cjs"),
        "utf8",
      ),
      {
        require: () => ({
          async createD3d11Player() {
            if (software) throw new Error("D3D11 unavailable");
            creates++;
            return player;
          },
          MpvPlayer: class {
            constructor() {
              creates++;
              return player;
            }
          },
        }),
        process: {
          argv: ["", "", "native"],
          parentPort: {
            on(_event, callback) {
              handle = callback;
            },
            postMessage(value) {
              output.push(value);
            },
          },
        },
        setTimeout,
        Date,
        JSON,
      },
    );
    const source = {
      source: "https://example.org/movie",
      headers: [],
      format: "auto",
    };
    await handle({ data: { ...source, seconds: 5 } });
    assert.equal(output[0].seconds, 5);
    await handle({ data: { ...source, seconds: 9 } });
    assert.equal(output[1].seconds, 9);
    assert.equal(creates, 1);
    assert.equal(opens, 1);
    assert.equal(seeks, 1);
    assert.equal(
      renders,
      2,
      "An old dirty frame was rendered before the seek event",
    );
    await handle({
      data: { ...source, source: "https://other.example/movie", seconds: 12 },
    });
    assert.equal(output[2], null);
    assert.equal(seeks, 1);
  });
