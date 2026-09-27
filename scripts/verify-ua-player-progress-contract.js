const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createUaPlayerSessionBridge,
} = require("../src/modules/uaPlayerSessionBridge");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lampaua-progress-"));
  const protectedRoot = path.join(root, "protected");
  fs.mkdirSync(protectedRoot);
  let clock = 0;
  let timerId = 0;
  const timers = new Map();
  const owner = {};
  const bridge = createUaPlayerSessionBridge({
    tempRoot: path.join(root, "temporary"),
    protectedRoot,
    now: () => clock,
    schedule(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, at: clock + delay });
      return id;
    },
    cancel: (id) => timers.delete(id),
    stageProcess(executable, input) {
      const legacy = JSON.parse(fs.readFileSync(input, "utf8"));
      const id = crypto.randomUUID();
      const directory = path.join(protectedRoot, id);
      fs.mkdirSync(directory);
      const requestPath = path.join(directory, "request.json");
      fs.writeFileSync(requestPath, JSON.stringify(legacy));
      return {
        schema: "lampaua.player.stage-result",
        version: 1,
        session_id: legacy.session_id,
        request_id: id,
        nonce: crypto.randomBytes(16).toString("base64url"),
        bridge_root: protectedRoot,
        request_path: requestPath,
        result_path: path.join(directory, "result.json"),
      };
    },
  });
  let sessionId = 0;
  function launch(withIds = true) {
    return bridge.prepareLaunch({
      sessionId: `session-${++sessionId}`,
      owner,
      payload: {
        schema: "lampaua-player-session-v1",
        playlist_index: 0,
        items: [0, 1].map((index) => ({
          ...(withIds ? { id: `episode-${index}` } : {}),
          url: `https://media.example/${index}?secret=never-forward`,
        })),
      },
    });
  }
  return {
    root,
    owner,
    bridge,
    timers,
    launch,
    async advance(milliseconds) {
      clock += milliseconds;
      const due = [...timers].filter(([, timer]) => timer.at <= clock);
      for (const [id, timer] of due) {
        timers.delete(id);
        await timer.callback();
      }
    },
    dispose() {
      bridge.cleanupAll();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function snapshot(launch, sequence = 1, overrides = {}) {
  return {
    schema: "lampaua.player.playback-progress",
    version: 1,
    request_id: launch.requestId,
    nonce: launch.nonce,
    playback_generation: 7,
    sequence,
    current_index: 0,
    playback_results: [
      {
        index: 0,
        id: "episode-0",
        sequence,
        position_ms: 10_000,
        duration_ms: 40_000,
        completed: false,
      },
    ],
    ...overrides,
  };
}

function write(launch, value, leaf = "progress.json") {
  const target = path.join(path.dirname(launch.requestPath), leaf);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(
    temporary,
    typeof value === "string" ? value : JSON.stringify(value),
  );
  fs.renameSync(temporary, target);
}

async function verifyProgressAndFinal() {
  const f = fixture();
  try {
    const launch = f.launch();
    const progress = [];
    const finals = [];
    assert.equal(
      typeof launch.startMonitoring,
      "function",
      "Desktop has no active-session progress receiver",
    );
    const monitor = launch.startMonitoring({
      onProgress: (value) => progress.push(value),
      onResult: (value) => finals.push(value),
    });
    await monitor.notifyChildClosed({ code: 0, signal: null });
    assert.equal(
      fs.existsSync(launch.requestPath),
      true,
      "forwarding launcher exit must not delete the session",
    );
    write(launch, snapshot(launch));
    await f.advance(1_000);
    assert.deepEqual(progress, [
      {
        sequence: 1,
        playback_results: [
          {
            playlist_index: 0,
            sequence: 1,
            position: 10_000,
            duration: 40_000,
            completed: false,
          },
        ],
      },
    ]);
    await f.advance(1_000);
    assert.equal(
      progress.length,
      1,
      "unchanged snapshot must not be reapplied",
    );
    assert.equal(
      /nonce|secret|request_id|https/.test(JSON.stringify(progress)),
      false,
    );

    const second = snapshot(launch, 3, {
      current_index: 1,
      playback_results: [
        {
          index: 0,
          id: "episode-0",
          sequence: 2,
          position_ms: 12_000,
          duration_ms: 40_000,
          completed: false,
        },
        {
          index: 1,
          id: "episode-1",
          sequence: 3,
          position_ms: 3_000,
          duration_ms: 60_000,
          completed: false,
        },
      ],
    });
    write(launch, second);
    await f.advance(1_000);
    assert.deepEqual(
      progress.at(-1).playback_results.map((row) => row.position),
      [12_000, 3_000],
    );
    write(
      launch,
      snapshot(launch, 4, {
        current_index: 1,
        playback_results: [
          second.playback_results[0],
          { ...second.playback_results[1], sequence: 4, position_ms: 0 },
        ],
      }),
    );
    await f.advance(1_000);
    assert.deepEqual(progress.at(-1).playback_results, [
      {
        playlist_index: 1,
        sequence: 4,
        position: 0,
        duration: 60_000,
        completed: false,
      },
    ]);
    const missingId = snapshot(launch, 50);
    delete missingId.playback_results[0].id;
    for (const invalid of [
      missingId,
      snapshot(launch, 2),
      snapshot(launch, 50, { nonce: "wrong" }),
      snapshot(launch, 50, { playback_generation: 8 }),
      snapshot(launch, 50, {
        playback_results: [
          {
            index: 2,
            id: "episode-2",
            sequence: 50,
            position_ms: 1,
            duration_ms: 2,
            completed: false,
          },
        ],
      }),
      snapshot(launch, 50, {
        playback_results: [
          {
            index: 0,
            id: "wrong",
            sequence: 50,
            position_ms: 1,
            duration_ms: 2,
            completed: false,
          },
        ],
      }),
      snapshot(launch, 50, {
        playback_results: [
          {
            index: 0,
            id: "episode-0",
            sequence: 51,
            position_ms: 1,
            duration_ms: 2,
            completed: false,
          },
        ],
      }),
      snapshot(launch, 50, {
        playback_results: [
          {
            index: 0,
            id: "episode-0",
            sequence: 50,
            position_ms: 3,
            duration_ms: 2,
            completed: false,
          },
        ],
      }),
      " ".repeat(16 * 1024 * 1024 + 1),
    ]) {
      write(launch, invalid);
      await f.advance(1_000);
      assert.equal(
        progress.length,
        3,
        "invalid progress must not poison ordering or reach renderer",
      );
    }
    write(launch, snapshot(launch, 5));
    await f.advance(1_000);
    assert.equal(progress.length, 4);
    write(
      launch,
      {
        ...snapshot(launch, 6),
        schema: "lampaua.player.playback-result",
        status: "stopped",
      },
      "result.json",
    );
    write(launch, snapshot(launch, 7));
    await f.advance(1_000);
    await monitor.notifyChildClosed({ code: 0, signal: null });
    assert.equal(finals.length, 1);
    assert.equal(
      progress.length,
      4,
      "terminal result wins over pending progress",
    );
    assert.equal(f.timers.size, 0);
    assert.equal(launch.finish(), null);
  } finally {
    f.dispose();
  }
}

async function verifyLifecycleAndLegacy() {
  const f = fixture();
  try {
    const legacy = f.launch();
    const finals = [];
    const monitor = legacy.startMonitoring({
      onResult: (result) => finals.push(result),
    });
    write(
      legacy,
      {
        ...snapshot(legacy),
        schema: "lampaua.player.playback-result",
        status: "stopped",
      },
      "result.json",
    );
    await monitor.notifyChildClosed({ code: 0, signal: null });
    assert.equal(finals.length, 1, "old players need no progress file");
    const expiring = f.launch();
    expiring.startMonitoring({});
    await f.advance(86_400_000);
    assert.equal(fs.existsSync(expiring.requestPath), false);
    assert.equal(f.timers.size, 0);
    const bounded = [];
    for (let i = 0; i < 33; i++) {
      const entry = f.launch();
      entry.startMonitoring({});
      bounded.push(entry);
    }
    assert.equal(
      fs.existsSync(bounded[0].requestPath),
      false,
      "at most 32 sessions are retained",
    );
    assert.equal(fs.existsSync(bounded.at(-1).requestPath), true);
    f.bridge.cleanupOwner(f.owner);
    assert.equal(f.timers.size, 0);
    assert.equal(fs.existsSync(bounded.at(-1).requestPath), false);
  } finally {
    f.dispose();
  }
}

async function verifyUnsafeFiles() {
  const f = fixture();
  try {
    const launch = f.launch();
    const progress = [];
    launch.startMonitoring({ onProgress: (value) => progress.push(value) });
    const target = path.join(path.dirname(launch.requestPath), "progress.json");
    const outside = path.join(f.root, "outside.json");
    const content = JSON.stringify(snapshot(launch));
    fs.writeFileSync(outside, content);
    fs.linkSync(outside, target);
    await f.advance(1_000);
    assert.equal(
      progress.length,
      0,
      "hard-linked file is outside the bridge boundary",
    );
    fs.unlinkSync(target);
    const original = path.dirname(launch.requestPath);
    const moved = `${original}-moved`;
    fs.renameSync(original, moved);
    fs.symlinkSync(moved, original, "junction");
    fs.writeFileSync(path.join(moved, "progress.json"), content);
    await f.advance(1_000);
    assert.equal(progress.length, 0, "reparse session is rejected");
    launch.cleanup();
    assert.equal(fs.readFileSync(outside, "utf8"), content);
    assert.equal(
      fs.existsSync(path.join(moved, "progress.json")),
      true,
      "cleanup must not traverse a substituted directory",
    );
  } finally {
    f.dispose();
  }
}

async function verifyZeroSeekImmediatelyBeforeClose() {
  const f = fixture();
  try {
    const launch = f.launch();
    const received = [];
    launch.startMonitoring({
      onProgress: (value) =>
        received.push(["progress", value.playback_results[0].position]),
      onResult: (value) => received.push(["final", value.position]),
    });
    write(launch, snapshot(launch));
    await f.advance(1_000);
    const zero = snapshot(launch, 2);
    zero.playback_results[0].position_ms = 0;
    write(launch, zero);
    write(
      launch,
      { ...zero, schema: "lampaua.player.playback-result", status: "stopped" },
      "result.json",
    );
    await f.advance(1_000);
    assert.deepEqual(
      received,
      [
        ["progress", 10_000],
        ["progress", 0],
        ["final", 0],
      ],
      "authenticated seek to zero must reach timeline before terminal retirement",
    );
  } finally {
    f.dispose();
  }
}

async function verifyOptionalIdentifiers() {
  const f = fixture();
  try {
    const launch = f.launch(false);
    const received = [];
    launch.startMonitoring({ onProgress: (value) => received.push(value) });
    const noId = snapshot(launch);
    delete noId.playback_results[0].id;
    write(launch, noId);
    await f.advance(1_000);
    assert.equal(
      received.length,
      1,
      "id-less admitted item permits an omitted wire ID",
    );
    noId.sequence = 2;
    noId.playback_results[0].sequence = 2;
    noId.playback_results[0].id = null;
    write(launch, noId);
    await f.advance(1_000);
    assert.equal(
      received.length,
      2,
      "null ID is also valid only for an id-less item",
    );
  } finally {
    f.dispose();
  }
}

(async () => {
  await verifyProgressAndFinal();
  await verifyLifecycleAndLegacy();
  await verifyUnsafeFiles();
  const regressions = await Promise.allSettled([
    verifyZeroSeekImmediatelyBeforeClose(),
    verifyOptionalIdentifiers(),
  ]);
  const failures = regressions
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length)
    throw new AggregateError(failures, "Finalization/identifier regressions");
  console.log(
    "UA Player periodic progress, ordering, lifecycle and file-boundary contracts verified",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
