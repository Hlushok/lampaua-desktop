const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

async function main() {
  const option = (name) => process.argv[process.argv.indexOf(name) + 1];
  const addon = path.resolve(option("--addon"));
  if (!process.argv.includes("--child")) {
    const child = spawnSync(
      process.argv.includes("--electron")
        ? path.resolve(option("--electron"))
        : process.execPath,
      [
        "--expose-gc",
        __filename,
        "--child",
        "--addon",
        addon,
        ...(process.argv.includes("--max-gpu-ready-ms")
          ? ["--max-gpu-ready-ms", option("--max-gpu-ready-ms")]
          : []),
      ],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          PATH:
            path.resolve(".cache/mpv-prototype/sdk") +
            path.delimiter +
            process.env.PATH,
        },
        windowsHide: true,
        encoding: "utf8",
        timeout: 90000,
      },
    );
    if (child.error) throw child.error;
    assert.equal(child.status, 0, child.stderr || child.stdout);
    console.log(child.stdout.trim());
    return;
  }

  const native = require(addon);
  assert.equal(
    typeof native.createD3d11TestProducer,
    "function",
    "D3D11 test producer is not implemented/enabled",
  );
  assert.equal(typeof native.getD3d11TestResources, "function");
  const baselineResources = native.getD3d11TestResources();
  const create = (options = {}) =>
    native.createD3d11TestProducer({
      width: 128,
      height: 72,
      fps: 24,
      ...options,
    });
  const producer = await create();
  try {
    assert.equal(
      producer.stats().hardware,
      true,
      "WARP is not a passing device",
    );
    assert.match(producer.stats().adapterLuid, /^[0-9a-f]+:[0-9a-f]+$/i);
    const frames = [];
    for (let i = 0; i < 3; i++) frames.push(await producer.nextFrame());
    assert.ok(frames.every(Boolean));
    if (process.argv.includes("--max-gpu-ready-ms")) {
      const limit = Number(option("--max-gpu-ready-ms"));
      assert.ok(
        frames.every((frame) => frame.gpuReadyMs <= limit),
        `GPU completion wait exceeds ${limit}ms: ${frames.map((frame) => frame.gpuReadyMs).join(", ")}`,
      );
    }
    assert.equal(new Set(frames.map((f) => f.key.slot)).size, 3);
    assert.equal(await producer.nextFrame(), null);
    const before = producer.stats();
    assert.equal(
      await producer.releaseFrame({
        ...frames[0].key,
        sequence: frames[0].key.sequence + 1,
      }),
      false,
    );
    assert.deepEqual(producer.stats(), before);
    const foreign = await create();
    try {
      const other = await foreign.nextFrame();
      assert.equal(await producer.releaseFrame(other.key), false);
      assert.deepEqual(producer.stats(), before);
    } finally {
      await foreign.destroy();
    }
    for (const frame of frames) {
      assert.equal(frame.textureInfo.pixelFormat, "bgra");
      assert.equal(Buffer.isBuffer(frame.textureInfo.handle.ntHandle), true);
      assert.equal(frame.textureInfo.handle.ntHandle.length, 8);
      assert.ok(frame.targetTimeNs > 0);
      assert.ok(frame.gpuReadyMs >= 0);
      const pixels = await producer.readMarker(frame.key);
      assert.equal(pixels.sequence, frame.key.sequence % 0x1000000);
    }
    assert.equal(await producer.releaseFrame(frames[0].key), true);
    assert.equal(await producer.releaseFrame(frames[0].key), false);
    const reused = await producer.nextFrame();
    assert.equal(reused.key.slot, frames[0].key.slot);
    assert.notEqual(reused.key.sequence, frames[0].key.sequence);
    assert.equal(await producer.releaseFrame(frames[0].key), false);

    await producer.resize({ width: 160, height: 90, generation: 2 });
    const second = await producer.nextFrame();
    assert.equal(second.key.generation, 2);
    for (let generation = 3; generation <= 102; generation++) {
      await producer.resize({
        width: 160 + generation,
        height: 100,
        generation,
      });
      assert.ok(producer.stats().textureCount <= 6);
      assert.equal(await producer.nextFrame(), null);
    }
    assert.equal(producer.stats().requestedGeneration, 102);
    for (const frame of [reused, frames[1], frames[2]]) {
      assert.equal(await producer.releaseFrame(frame.key), true);
    }
    const latest = await producer.nextFrame();
    assert.equal(latest.key.generation, 102);
    assert.equal(latest.textureInfo.codedSize.width, 262);
    assert.equal(await producer.releaseFrame(second.key), true);
    assert.equal(await producer.releaseFrame(second.key), false);
    assert.equal(producer.stats().textureCount, 3);
    assert.equal(await producer.releaseFrame(latest.key), true);
    await assert.rejects(
      producer.resize({ width: 4000, height: 2160, generation: 103 }),
    );
    await assert.rejects(
      producer.resize({ width: 160, height: 90, generation: 1 }),
    );
  } finally {
    const closing = producer.destroy();
    assert.strictEqual(producer.destroy(), closing);
    await closing;
  }
  assert.equal(producer.stats().textureCount, 0);
  assert.equal(producer.stats().destroyed, true);
  await assert.rejects(producer.nextFrame(), /closed|destroyed/i);

  const overloaded = await create({ renderDelayMs: 80 });
  const burst = Array.from({ length: 40 }, () =>
    overloaded.nextFrame().catch((error) => {
      assert.match(error.message, /queue.*full|closed/i);
      return null;
    }),
  );
  const overloadedClose = overloaded.destroy();
  await overloadedClose;
  await Promise.all(burst);
  assert.equal(
    overloaded.stats().textureCount,
    0,
    "A full queue must still close",
  );

  for (const fault of ["device-removed", "mutex-timeout"]) {
    const broken = await create();
    const held = await broken.nextFrame();
    await broken.injectFault(fault);
    await assert.rejects(broken.nextFrame(), /device|mutex/i);
    assert.equal(broken.stats().failed, true);
    assert.equal(
      broken.stats().activeLeases,
      1,
      "Fault timeout must not free a lease",
    );
    assert.equal(
      await broken.releaseFrame({ ...held.key, generation: 500 }),
      false,
    );
    assert.equal(broken.stats().activeLeases, 1);
    await broken.destroy();
    assert.equal(broken.stats().textureCount, 0);
  }

  let heartbeat = 0;
  const timer = setInterval(() => heartbeat++, 5);
  try {
    for (let cycle = 0; cycle < 10; cycle++) {
      const pending = await create({ renderDelayMs: 80 });
      const start = heartbeat;
      const rendering = pending.nextFrame();
      const closing = pending.destroy();
      global.gc();
      await rendering;
      await closing;
      assert.ok(heartbeat - start >= 5, "Render/destroy blocked the JS thread");
      assert.equal(pending.stats().textureCount, 0);
    }
  } finally {
    clearInterval(timer);
  }
  const { pending: orphanRender } = await (async () => {
    const orphan = await create({ renderDelayMs: 80 });
    return { pending: orphan.nextFrame() };
  })();
  global.gc();
  await orphanRender;
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    global.gc();
    if (
      native.getD3d11TestResources().textureCount ===
      baselineResources.textureCount
    )
      break;
  }
  assert.deepEqual(
    native.getD3d11TestResources(),
    baselineResources,
    "GC and close must return native textures, handles and threads to baseline",
  );
  console.log(
    "D3D11 hardware pool: bounds, pixels, ownership, resize, faults and lifecycle passed",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
