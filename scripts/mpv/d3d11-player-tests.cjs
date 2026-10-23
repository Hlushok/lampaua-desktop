const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async function playerTests(native) {
  assert.equal(
    typeof native.createD3d11Player,
    "function",
    "D3D11 player factory is not implemented",
  );
  if (process.argv.includes("--production-only")) {
    for (const name of [
      "createD3d11TestProducer",
      "getD3d11TestResources",
      "probeD3d11Context",
    ])
      assert.equal(
        native[name],
        undefined,
        `Production exposes test export ${name}`,
      );
    for (const name of ["injectD3d11Fault", "readD3d11Marker"])
      assert.equal(
        native.MpvPlayer.prototype[name],
        undefined,
        `Production exposes test method ${name}`,
      );
    const player = await native.createD3d11Player({ width: 96, height: 54 });
    await player.destroy();
    console.log(
      "Production D3D11 factory smoke passed; test-only exports absent",
    );
    return;
  }
  const baseline = native.getD3d11TestResources();
  if (process.argv.includes("--expect-api-rejection")) {
    await assert.rejects(
      native.createD3d11Player({ width: 96, height: 54 }),
      (error) => error.code === "MPV_D3D11_API" && error.apiVersion === 131077,
    );
    assert.deepEqual(native.getD3d11TestResources(), baseline);
    console.log(
      "D3D11 player rejected old runtime API without leaked resources",
    );
    return;
  }
  for (const options of [
    { width: 0, height: 2 },
    { width: 3841, height: 2 },
    { width: 2, height: NaN },
    { width: 2.5, height: 2 },
  ])
    await assert.rejects(native.createD3d11Player(options));
  assert.throws(() => new native.MpvPlayer({ mode: "d3d11" }), /factory/i);
  let ticks = 0;
  let previous = performance.now();
  let maxGapMs = 0;
  const heartbeat = setInterval(() => {
    ticks++;
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - previous);
    previous = now;
  }, 5);
  try {
    for (let i = 0; i < 5; i++) {
      const initializing = native.createD3d11Player({ width: 96, height: 54 });
      global.gc?.();
      const player = await initializing;
      assert.equal(
        await player.renderD3d11Frame(96, 54, 1),
        null,
        "Empty player must not invent a presented frame",
      );
      assert.throws(() => player.renderFrame(96, 54), /D3D11/);
      const retiring =
        i === 0 ? player.retireD3d11Playback() : Promise.resolve();
      const closing = player.destroy();
      assert.strictEqual(player.destroy(), closing);
      global.gc?.();
      await closing;
      await retiring;
      assert.deepEqual(native.getD3d11TestResources(), baseline);
    }
    if (process.argv.includes("--player-smoke")) {
      console.log(
        "D3D11 async init, empty-frame, GC and idempotent cleanup smoke passed",
      );
      return;
    }

    const folder = path.resolve(".cache/mpv-prototype/fixtures");
    const files = {
      "/h264.mp4": "h264-aac.mp4",
      "/hevc.mp4": "hevc-4k-hdr-30s.mp4",
      "/red.mp4": "d3d11-red.mp4",
    };
    let protectedRequests = 0;
    const server = http.createServer((req, res) => {
      if (req.url === "/red.mp4") {
        protectedRequests++;
        if (req.headers["x-fixture"] !== "gpu-fixture") {
          res.writeHead(403).end();
          return;
        }
      }
      const name = files[req.url];
      if (!name || !fs.existsSync(path.join(folder, name))) {
        res.writeHead(404).end();
        return;
      }
      const file = path.join(folder, name);
      const size = fs.statSync(file).size;
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416).end();
        return;
      }
      res.writeHead(range ? 206 : 200, {
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": "video/mp4",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      });
      const stream = fs.createReadStream(file, { start, end });
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const reports = [];
    let colorPixel;
    try {
      const retiring = await native.createD3d11Player({
        width: 160,
        height: 90,
      });
      const pump = () => retiring.pollEvents();
      const timer = setInterval(pump, 5);
      let retained;
      try {
        retiring.open(
          `http://127.0.0.1:${server.address().port}/h264.mp4`,
          [],
          "auto",
        );
        retiring.play();
        const deadline = performance.now() + 5000;
        while (!retained && performance.now() < deadline) {
          retained = await retiring.renderD3d11Frame(160, 90, 1);
          if (!retained) await wait(3);
        }
        assert.ok(retained, "Retirement fixture did not produce a GPU lease");
        clearInterval(timer);
        retiring.setEventCallback();
        retiring.setSpeed(1.1);
        retiring.play();
        retiring.pause();
        retiring.play();
        const stopped = retiring.retireD3d11Playback();
        assert.strictEqual(retiring.retireD3d11Playback(), stopped);
        await stopped;
        await assert.rejects(retiring.renderD3d11Frame(160, 90, 1), /closing/);
        assert.throws(() => retiring.play(), /core not initialized \(-3\)/);
        assert.equal(
          typeof (await retiring.readD3d11Marker(retained.key)),
          "number",
        );
        assert.equal(await retiring.releaseD3d11Frame(retained.key), true);
        retained = null;
      } finally {
        clearInterval(timer);
        if (retained) await retiring.releaseD3d11Frame(retained.key);
        await retiring.destroy();
      }
      assert.deepEqual(native.getD3d11TestResources(), baseline);
      for (let cycle = 0; cycle < 8; cycle++) {
        const failed = await native.createD3d11Player({
          width: 160,
          height: 90,
        });
        let ended = false;
        const poll = () => {
          for (const event of failed.pollEvents())
            if (event.type === "end-file") ended = true;
        };
        const timer = setInterval(poll, 5);
        try {
          failed.setEventCallback(poll);
          failed.open(
            `http://127.0.0.1:${server.address().port}/missing.mp4`,
            [],
            "auto",
          );
          failed.setVolume(100);
          failed.setSpeed(1);
          failed.play();
          const deadline = performance.now() + 5000;
          while (!ended && performance.now() < deadline) await wait(5);
          assert.equal(ended, true, "Failed source did not report end-file");
          clearInterval(timer);
          failed.setEventCallback();
          failed.pause();
          const retired = failed.retireD3d11Playback();
          assert.deepEqual(
            failed.pollEvents(),
            [],
            "Main event pump raced retirement reply consumption",
          );
          await retired;
        } finally {
          clearInterval(timer);
          await failed.destroy();
        }
        assert.deepEqual(native.getD3d11TestResources(), baseline);
      }
      for (const media of process.argv.includes("--player-lifecycle-only")
        ? []
        : ["h264", "hevc"]) {
        const player = await native.createD3d11Player({
          width: 640,
          height: 360,
        });
        const properties = {};
        const errors = [];
        const avsync = [];
        const pump = () => {
          for (const event of player.pollEvents()) {
            if (event.type === "property-change")
              properties[event.name] = event.data;
            if (
              event.name === "avsync" &&
              typeof event.data === "number" &&
              properties["time-pos"] > 1
            )
              avsync.push(Math.abs(event.data));
            if (event.error || event.type === "command-error")
              errors.push(event.error ?? event.type);
          }
        };
        const timer = setInterval(pump, 5);
        const frames = [];
        let warmupDrops;
        try {
          player.setEventCallback(pump);
          player.open(
            `http://127.0.0.1:${server.address().port}/${media}.mp4`,
            [],
            "auto",
          );
          player.play();
          const deadline = performance.now() + 15000;
          const expectedFrames = media === "hevc" ? 240 : 48;
          while (
            frames.length < expectedFrames &&
            performance.now() < deadline
          ) {
            const frame = await player.renderD3d11Frame(640, 360, 1);
            if (frame) {
              assert.equal(
                "rgba" in frame,
                false,
                "D3D11 playback must not return CPU video pixels",
              );
              assert.equal(frame.textureInfo.pixelFormat, "bgra");
              assert.equal(
                Buffer.isBuffer(frame.textureInfo.handle.ntHandle),
                true,
              );
              assert.equal(frame.textureInfo.handle.ntHandle.byteLength, 8);
              assert.equal(frame.key.generation, 1);
              assert.equal(frame.frameFlags & 1, 1);
              if (
                !(frame.frameFlags & 6) &&
                frame.targetTimeNs > 0 &&
                properties["time-pos"] >= 2
              ) {
                warmupDrops ??= {
                  video: properties["frame-drop-count"],
                  decoder: properties["decoder-frame-drop-count"],
                };
                assert.ok(
                  Number.isFinite(properties.avsync),
                  "Missing native A/V telemetry",
                );
                frames.push(frame);
                avsync.push(Math.abs(properties.avsync));
              }
              assert.equal(await player.releaseD3d11Frame(frame.key), true);
              assert.equal(await player.releaseD3d11Frame(frame.key), false);
            }
            if (!warmupDrops) global.gc?.();
            assert.equal(
              errors.length,
              0,
              JSON.stringify({ media, errors, properties }),
            );
            await wait(2);
          }
          assert.equal(
            frames.length,
            expectedFrames,
            `${media}: insufficient real video frames; ${JSON.stringify(properties)}`,
          );
          if (media === "hevc") {
            assert.equal(properties.width, 3840);
            assert.equal(properties.height, 2160);
            assert.equal(properties["hwdec-current"], "d3d11va");
            assert.equal(properties["video-params/pixelformat"], "d3d11");
          }
          for (const frame of frames.slice(5)) {
            assert.ok(
              Math.abs(frame.clockTimeNs - frame.targetTimeNs) < 200000000,
              "Frame target time must use the actual monotonic nanosecond base",
            );
            assert.ok(frame.renderSubmissionMs >= 0 && frame.gpuReadyMs >= 0);
            assert.ok(
              frame.gpuExecutionMs === null ||
                (Number.isFinite(frame.gpuExecutionMs) &&
                  frame.gpuExecutionMs >= 0),
              "GPU elapsed timing must come from D3D11 timestamp queries, not CPU call duration",
            );
          }
          const timedFrames = frames.filter(
            (frame) => frame.gpuExecutionMs !== null,
          );
          assert.ok(
            timedFrames.length > 0,
            "No valid D3D11 GPU timestamp samples",
          );
          const targetInterval =
            (frames.at(-1).targetTimeNs - frames[5].targetTimeNs) /
            (frames.length - 6);
          assert.ok(
            targetInterval > 15000000 && targetInterval < 70000000,
            `Target time units/cadence invalid: ${targetInterval}`,
          );
          assert.ok(
            avsync.length > 0,
            "Missing real A/V synchronization telemetry after warmup",
          );
          assert.ok(
            Math.max(...avsync) <= 0.05,
            `A/V error exceeds 50ms: ${Math.max(...avsync)}`,
          );
          const dropDelta = properties["frame-drop-count"] - warmupDrops.video;
          const decoderDropDelta =
            properties["decoder-frame-drop-count"] - warmupDrops.decoder;
          assert.ok(
            dropDelta <= 1 && decoderDropDelta <= 1,
            JSON.stringify({
              media,
              videoDrops: properties["frame-drop-count"],
              decoderDrops: properties["decoder-frame-drop-count"],
              maxGpu: Math.max(...frames.map((f) => f.gpuExecutionMs)),
              maxSubmit: Math.max(...frames.map((f) => f.renderSubmissionMs)),
              maxReady: Math.max(...frames.map((f) => f.gpuReadyMs)),
              warmupDrops,
              dropDelta,
              decoderDropDelta,
            }),
          );
          reports.push({
            media,
            frames: frames.length,
            targetIntervalNs: targetInterval,
            warmupDrops,
            dropDelta,
            decoderDropDelta,
            avsyncMax: Math.max(...avsync),
            gpuElapsedMaxMs: Math.max(
              ...timedFrames.map((f) => f.gpuExecutionMs),
            ),
            gpuTimestampSamples: timedFrames.length,
            submissionMaxMs: Math.max(
              ...frames.map((f) => f.renderSubmissionMs),
            ),
            gpuReadyMaxMs: Math.max(...frames.map((f) => f.gpuReadyMs)),
            targetWaitMaxMs: Math.max(...frames.map((f) => f.targetWaitMs)),
            properties: structuredClone(properties),
          });
          player.pause();
          player.seek(1);
          await wait(50);
          await player.renderD3d11Frame(640, 360, 2).then(async (frame) => {
            if (frame) {
              assert.equal(frame.key.generation, 2);
              await player.releaseD3d11Frame(frame.key);
            }
          });
          if (media === "h264") {
            let uncaught = 0;
            const onUncaught = () => uncaught++;
            process.on("uncaughtException", onUncaught);
            player.setUpdateCallback(() => {
              throw new Error("intentional D3D11 callback failure");
            });
            try {
              player.seek(2);
              const until = performance.now() + 2000;
              while (!errors.length && performance.now() < until) {
                const frame = await player.renderD3d11Frame(640, 360, 3);
                if (frame) await player.releaseD3d11Frame(frame.key);
                await wait(5);
              }
              assert.equal(
                uncaught,
                0,
                "Native notification must not leak callback exceptions to the process",
              );
              assert.ok(
                errors.some((error) =>
                  /notification callback failed/.test(error),
                ),
                "Native callback failure must be reported as a bounded player error",
              );
            } finally {
              player.setUpdateCallback();
              process.off("uncaughtException", onUncaught);
            }
          }
        } finally {
          clearInterval(timer);
          player.setEventCallback();
          await player.destroy();
          assert.deepEqual(native.getD3d11TestResources(), baseline);
        }
      }
      assert.equal(
        typeof native.MpvPlayer.prototype.injectD3d11Fault,
        "function",
        "Missing test-only native device fault hook",
      );
      const invalidQueue = await native.createD3d11Player({
        width: 160,
        height: 90,
      });
      try {
        invalidQueue.pause();
        invalidQueue.setAudioTrack("invalid-track");
        invalidQueue.open(
          `http://127.0.0.1:${server.address().port}/red.mp4`,
          ["X-Fixture: gpu-fixture"],
          "auto",
        );
        let failed = false;
        const deadline = performance.now() + 2000;
        while (!failed && performance.now() < deadline) {
          failed = invalidQueue
            .pollEvents()
            .some((event) => event.type === "command-error");
          await wait(5);
        }
        assert.equal(failed, true);
        assert.equal(
          protectedRequests,
          0,
          "A failed D3D11 control request dispatched pending loadfile",
        );
      } finally {
        await invalidQueue.destroy();
      }
      const colorPlayer = await native.createD3d11Player({
        width: 160,
        height: 90,
      });
      const colorPump = setInterval(() => colorPlayer.pollEvents(), 5);
      try {
        colorPlayer.open(
          `http://127.0.0.1:${server.address().port}/red.mp4`,
          ["X-Fixture: gpu-fixture"],
          "auto",
        );
        colorPlayer.play();
        const deadline = performance.now() + 5000;
        while (colorPixel === undefined && performance.now() < deadline) {
          const frame = await colorPlayer.renderD3d11Frame(160, 90, 1);
          if (frame) {
            colorPixel = await colorPlayer.readD3d11Marker(frame.key);
            await colorPlayer.releaseD3d11Frame(frame.key);
          } else await wait(5);
        }
        assert.ok(
          Number.isInteger(colorPixel),
          "Missing test-only GPU color sample",
        );
        assert.ok(
          (colorPixel & 255) > 220 &&
            ((colorPixel >> 8) & 255) < 16 &&
            ((colorPixel >> 16) & 255) < 16,
          `Expected SDR red reference, GPU pixel=${colorPixel}`,
        );
        assert.ok(
          protectedRequests > 0,
          "Header-protected color fixture was not requested",
        );
      } finally {
        clearInterval(colorPump);
        await colorPlayer.destroy();
      }
      for (let cycle = 0; cycle < 50; cycle++) {
        const pending = native.createD3d11Player({ width: 160, height: 90 });
        global.gc?.();
        const player = await pending;
        const pump = () => player.pollEvents();
        const timer = setInterval(pump, 5);
        try {
          player.setEventCallback(pump);
          player.open(
            `http://127.0.0.1:${server.address().port}/h264.mp4`,
            [],
            "auto",
          );
          player.play();
          let received = false;
          const until = performance.now() + 5000;
          while (!received && performance.now() < until) {
            const pendingFrame = player.renderD3d11Frame(160, 90, 1);
            global.gc?.();
            const frame = await pendingFrame;
            if (frame) {
              assert.equal(await player.releaseD3d11Frame(frame.key), true);
              received = true;
            } else await wait(3);
          }
          assert.equal(received, true, `No frame in lifecycle cycle ${cycle}`);
          player.seek(1);
          const pendingFrame = player.renderD3d11Frame(160, 90, 2);
          global.gc?.();
          if (cycle === 47) {
            const closing = player.destroy();
            assert.equal(
              await pendingFrame,
              null,
              "Closing must discard a pending GPU frame",
            );
            assert.strictEqual(player.destroy(), closing);
            await closing;
          } else if (cycle === 48) {
            const frame = await pendingFrame;
            if (frame) await player.releaseD3d11Frame(frame.key);
            await player.injectD3d11Fault("timestamp-disjoint");
            let recovered = false;
            const deadline = performance.now() + 2000;
            while (!recovered && performance.now() < deadline) {
              const next = await player.renderD3d11Frame(160, 90, 2);
              if (next) {
                recovered = next.gpuExecutionMs === null;
                await player.releaseD3d11Frame(next.key);
              }
              await wait(3);
            }
            assert.equal(
              recovered,
              true,
              "Disjoint GPU timestamp must mark telemetry unavailable without stopping video",
            );
          } else if (cycle === 49) {
            await pendingFrame.then(async (frame) => {
              if (frame) await player.releaseD3d11Frame(frame.key);
            });
            await player.injectD3d11Fault("device-removed");
            await assert.rejects(
              player.renderD3d11Frame(160, 90, 2),
              /device removed/i,
            );
          } else {
            const frame = await pendingFrame;
            if (frame) await player.releaseD3d11Frame(frame.key);
          }
        } finally {
          clearInterval(timer);
          player.setEventCallback();
          const closing = player.destroy();
          assert.strictEqual(player.destroy(), closing);
          global.gc?.();
          await closing;
          assert.deepEqual(native.getD3d11TestResources(), baseline);
        }
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    console.log(
      JSON.stringify(
        {
          reports,
          lifecycleCycles: 50,
          colorPixel,
          ticks,
          maxGapMs,
          resources: native.getD3d11TestResources(),
        },
        null,
        2,
      ),
    );
  } finally {
    await wait(20);
    clearInterval(heartbeat);
    assert.ok(ticks > 0, "Main thread heartbeat never ran");
    assert.ok(
      maxGapMs < 100,
      `D3D11 player blocked main thread: ${maxGapMs}ms`,
    );
  }
};
