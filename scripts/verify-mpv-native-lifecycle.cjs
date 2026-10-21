const assert = require("node:assert/strict");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");

async function main() {
  if (process.argv[2] !== "--child") {
    const [electron, addon] = process.argv.slice(2);
    assert.ok(
      electron && addon,
      "Pass the pinned Electron executable and addon",
    );
    const probe = spawnSync(
      path.resolve(electron),
      ["--expose-gc", __filename, "--child", path.resolve(addon)],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          PATH:
            path.dirname(path.resolve(addon)) +
            path.delimiter +
            process.env.PATH,
        },
        windowsHide: true,
        encoding: "utf8",
        timeout: 60000,
      },
    );
    if (probe.error) throw probe.error;
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
    console.log(probe.stdout.trim());
    return;
  }

  const { MpvPlayer } = require(process.argv[3]);
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const queuePlayer = new MpvPlayer({ mode: "software" });
  try {
    queuePlayer.pause();
    queuePlayer.setAudioTrack("invalid-track");
    queuePlayer.open(
      `http://127.0.0.1:${server.address().port}/must-not-load`,
      [],
      "auto",
    );
    let failed = false;
    const deadline = Date.now() + 3000;
    while (!failed && Date.now() < deadline) {
      failed = queuePlayer
        .pollEvents()
        .some((event) => event.type === "command-error");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      failed,
      true,
      "Native async command failure was not delivered",
    );
    const drainDeadline = Date.now() + 1000;
    while (Date.now() < drainDeadline) {
      queuePlayer.pollEvents();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      requests,
      0,
      "A failed command still dispatched pending loadfile",
    );
  } finally {
    await queuePlayer.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
  for (let i = 0; i < 16; i++) {
    const player = new MpvPlayer({ mode: "software" });
    const frame = player.renderFrame(64, 64);
    const closing = player.destroy();
    assert.equal(typeof closing.then, "function");
    assert.strictEqual(player.destroy(), closing);
    await new Promise((resolve) => setImmediate(resolve));
    global.gc();
    assert.strictEqual(player.destroy(), closing);
    await frame;
    await closing;
    await new Promise((resolve) => setImmediate(resolve));
    global.gc();
    assert.strictEqual(player.destroy(), closing);
    await player.destroy();
  }
  console.log(
    "Native MPV failed-queue, frame/cleanup and repeated-destroy lifecycle verified",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
