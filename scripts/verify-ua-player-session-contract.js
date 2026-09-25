const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");
const bridgeModulePath = path.join(
  projectRoot,
  "src",
  "modules",
  "uaPlayerSessionBridge.js",
);
const MAX_RESULT_BYTES = 1024 * 1024;

function createTemporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lampaua-session-contract-"));
}

function writeAtomicJson(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value));
  fs.renameSync(temporaryPath, filePath);
}

function createStageHarness(protectedRoot) {
  const calls = [];
  fs.mkdirSync(protectedRoot, { recursive: true });
  return {
    calls,
    stageProcess(executablePath, sessionPath) {
      const legacy = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
      const requestId = crypto.randomUUID();
      const nonce = crypto.randomBytes(16).toString("base64url");
      const directory = path.join(protectedRoot, requestId);
      const requestPath = path.join(directory, "request.json");
      const resultPath = path.join(directory, "result.json");
      fs.mkdirSync(directory);
      fs.writeFileSync(requestPath, '{"fixture":true}');
      calls.push({ executablePath, legacy, requestPath, resultPath });
      return {
        schema: "lampaua.player.stage-result",
        version: 1,
        session_id: legacy.session_id,
        request_id: requestId,
        nonce,
        bridge_root: protectedRoot,
        request_path: requestPath,
        result_path: resultPath,
      };
    },
  };
}

function validPayload() {
  const item = Object.create({ inherited_secret: "drop-me" });
  Object.assign(item, {
    id: "episode-2",
    url: "https://stream.example.test/video.m3u8?token=session-only",
    resolver_url: "https://resolver.example.test/item/2",
    title: "Серія 2",
    poster: "https://images.example.test/poster.jpg",
    headers: {
      Authorization: "Bearer session-secret",
      Cookie: "sid=must-not-cross",
      "X-Playback": "allowed",
    },
    resolver_headers: { Referer: "https://example.test/" },
    position_ms: 12_000,
    season: 1,
    episode: 2,
    tmdb_id: 123,
    quality: {
      "1080p": "https://stream.example.test/1080.m3u8",
      "720p": { url: "https://stream.example.test/720.m3u8" },
    },
    subtitles: [
      {
        url: "https://subtitles.example.test/uk.vtt",
        label: "Українська",
        language: "uk",
        default: true,
        secret: "drop-me",
      },
    ],
    segments: [{ start: 10, end: 20, kind: "intro", source: "lampa" }],
    unknown_secret: "drop-me",
    callback() {},
  });

  return {
    schema: "lampaua-player-session-v1",
    title: "Сезон 1",
    playlist_index: 0,
    auto_next: true,
    items: [item],
    unknown_root: "drop-me",
  };
}

function validResult(overrides = {}) {
  return {
    schema: "lampaua-player-result-v1",
    end_by: "user",
    url: "https://stream.example.test/video.m3u8?token=result-token",
    position: 24_000,
    duration: 48_000,
    playlist_index: 0,
    playback_results: [
      {
        end_by: "playing",
        url: "https://stream.example.test/video.m3u8",
        position: 20_000,
        duration: 48_000,
        playlist_index: 0,
      },
    ],
    ...overrides,
  };
}

function validCanonicalResult(launch, overrides = {}) {
  return {
    schema: "lampaua.player.playback-result",
    version: 1,
    request_id: launch.requestId,
    nonce: launch.nonce,
    status: "stopped",
    current_index: 0,
    playback_results: [
      {
        index: 0,
        id: "episode-2",
        position_ms: 20_000,
        duration_ms: 48_000,
        completed: false,
      },
    ],
    ...overrides,
  };
}

function verifySessionCreation(createUaPlayerSessionBridge) {
  const temporaryRoot = createTemporaryRoot();
  const protectedRoot = path.join(temporaryRoot, "protected");
  const stage = createStageHarness(protectedRoot);
  const owner = {};
  const executablePath = path.join(temporaryRoot, "UAPlayer.exe");
  const bridge = createUaPlayerSessionBridge({
    tempRoot: path.join(temporaryRoot, "temporary"),
    protectedRoot,
    stageProcess: stage.stageProcess,
  });

  try {
    const fallback = bridge.prepareLaunch({
      sessionId: "fallback",
      positionalUrl: "https://stream.example.test/plain.m3u8",
      owner,
    });
    assert.deepEqual(fallback.args, [
      "--url",
      "https://stream.example.test/plain.m3u8",
    ]);
    assert.equal(fallback.finish(), null);

    const first = bridge.prepareLaunch({
      sessionId: "session-a",
      executablePath,
      payload: validPayload(),
      positionalUrl: "https://stream.example.test/plain.m3u8",
      owner,
    });
    const second = bridge.prepareLaunch({
      sessionId: "session-b",
      executablePath,
      payload: validPayload(),
      owner,
    });
    assert.notEqual(first.requestPath, second.requestPath);
    assert.equal(
      path.dirname(first.requestPath).startsWith(protectedRoot),
      true,
    );
    assert.deepEqual(first.args, ["--payload-file", first.requestPath]);

    const written = stage.calls[0].legacy;
    assert.equal(written.schema, "lampaua-player-session-v1");
    assert.equal(written.session_id, "session-a");
    assert.equal(written.items.length, 1);
    assert.equal(written.items[0].thumbnail.endsWith("poster.jpg"), true);
    assert.equal(
      written.items[0].headers.Authorization,
      "Bearer session-secret",
    );
    assert.equal(written.items[0].headers.Cookie, undefined);
    assert.equal(written.items[0].unknown_secret, undefined);
    assert.equal(written.items[0].callback, undefined);
    assert.equal(written.items[0].inherited_secret, undefined);
    assert.equal(written.unknown_root, undefined);
    assert.deepEqual(Object.keys(written.items[0].quality), ["1080p", "720p"]);
    assert.equal(written.items[0].subtitles[0].secret, undefined);
    assert.equal(written.items[0]._session_segments[0].start_ms, 10_000);

    first.cleanup();
    first.cleanup();
    assert.equal(fs.existsSync(path.dirname(first.requestPath)), false);
    bridge.cleanupOwner(owner);
    assert.equal(fs.existsSync(path.dirname(second.requestPath)), false);

    assert.throws(
      () =>
        bridge.prepareLaunch({
          sessionId: "invalid-url",
          payload: {
            schema: "lampaua-player-session-v1",
            items: [{ url: "javascript:alert(1)" }],
          },
          owner,
        }),
      /URL/,
    );

    assert.throws(
      () =>
        bridge.prepareLaunch({
          sessionId: "too-many",
          payload: {
            schema: "lampaua-player-session-v1",
            items: Array.from({ length: 257 }, (_, index) => ({
              url: `https://stream.example.test/${index}`,
            })),
          },
          owner,
        }),
      /256/,
    );

    const largeHeader = "x".repeat(16_000);
    assert.throws(
      () =>
        bridge.prepareLaunch({
          sessionId: "too-large",
          payload: {
            schema: "lampaua-player-session-v1",
            items: Array.from({ length: 256 }, (_, index) => ({
              url: `https://stream.example.test/${index}`,
              headers: Object.fromEntries(
                Array.from({ length: 4 }, (unused, headerIndex) => [
                  `X-Large-${headerIndex}`,
                  largeHeader,
                ]),
              ),
            })),
          },
          owner,
        }),
      /4 MiB/,
    );
  } finally {
    bridge.cleanupAll();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function verifyResultValidation(createUaPlayerSessionBridge) {
  const temporaryRoot = createTemporaryRoot();
  const protectedRoot = path.join(temporaryRoot, "protected");
  const stage = createStageHarness(protectedRoot);
  const executablePath = path.join(temporaryRoot, "UAPlayer.exe");
  const bridge = createUaPlayerSessionBridge({
    tempRoot: path.join(temporaryRoot, "temporary"),
    protectedRoot,
    stageProcess: stage.stageProcess,
  });
  const owner = {};

  function prepare(sessionId) {
    return bridge.prepareLaunch({
      sessionId,
      executablePath,
      payload: validPayload(),
      owner,
    });
  }

  function verifyRejected(sessionId, writeResult) {
    const launch = prepare(sessionId);
    const directory = path.dirname(launch.resultPath);
    writeResult(launch.resultPath, launch);
    assert.equal(launch.finish(), null);
    assert.equal(fs.existsSync(directory), false);
  }

  try {
    const valid = prepare("valid-result");
    const validDirectory = path.dirname(valid.resultPath);
    writeAtomicJson(
      valid.resultPath,
      validCanonicalResult(valid, {
        api_key: "drop-me",
        headers: { Authorization: "drop-me" },
        playback_results: [
          {
            index: 0,
            id: "episode-2",
            position_ms: 20_000,
            duration_ms: 48_000,
            completed: false,
            headers: { Cookie: "drop-me" },
          },
        ],
      }),
    );
    const normalized = valid.finish();
    assert.deepEqual(Object.keys(normalized), [
      "schema",
      "end_by",
      "url",
      "position",
      "duration",
      "playlist_index",
      "playback_results",
    ]);
    assert.equal(normalized.api_key, undefined);
    assert.equal(normalized.headers, undefined);
    assert.equal(normalized.playback_results.length, 1);
    assert.equal(normalized.playback_results[0].position, 20_000);
    assert.equal(normalized.playback_results[0].headers, undefined);
    assert.equal(valid.finish(), null);
    assert.equal(fs.existsSync(validDirectory), false);

    const replaced = prepare("replaced-result");
    writeAtomicJson(
      replaced.resultPath,
      validCanonicalResult(replaced, { status: "replaced" }),
    );
    assert.equal(replaced.finish().end_by, "replaced");

    verifyRejected("missing-result", () => {});
    verifyRejected("malformed-result", (filePath) => {
      fs.writeFileSync(filePath, "{not-json");
    });
    verifyRejected("wrong-schema", (filePath, launch) => {
      writeAtomicJson(
        filePath,
        validCanonicalResult(launch, { schema: "wrong" }),
      );
    });
    verifyRejected("wrong-correlation", (filePath, launch) => {
      writeAtomicJson(
        filePath,
        validCanonicalResult(launch, { request_id: crypto.randomUUID() }),
      );
    });
    verifyRejected("negative-result", (filePath, launch) => {
      writeAtomicJson(
        filePath,
        validCanonicalResult(launch, {
          playback_results: [
            {
              index: 0,
              id: "episode-2",
              position_ms: -1,
              duration_ms: 48_000,
              completed: false,
            },
          ],
        }),
      );
    });
    verifyRejected("bad-index", (filePath, launch) => {
      writeAtomicJson(
        filePath,
        validCanonicalResult(launch, { current_index: 1 }),
      );
    });
    verifyRejected("oversized-result", (filePath) => {
      fs.writeFileSync(filePath, Buffer.alloc(MAX_RESULT_BYTES + 1, 0x20));
    });
  } finally {
    bridge.cleanupAll();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function verifyPluginContract() {
  const listeners = new Map();
  const sentEvents = [];
  const preparedSessions = [];
  let resultSubscription;
  let sessionProvider;
  let selectedPlayerPath = "C:\\Program Files\\UA Player\\UAPlayer.exe";
  const playerListener = {
    follow(eventName, callback) {
      listeners.set(eventName, callback);
    },
    send(eventName, value) {
      sentEvents.push({ eventName, value });
    },
  };
  const Lampa = {
    Player: { listener: playerListener },
    Storage: {
      field(key) {
        if (key === "player_nw_path") return selectedPlayerPath;
        if (key === "video_quality_default") return "1080";
        return undefined;
      },
      get(key) {
        return this.field(key);
      },
    },
    Torserver: {
      toPlayUrl(url) {
        return `http://localhost:8090/play/${encodeURIComponent(url)}`;
      },
    },
  };
  const electronPlayer = {
    createUaPlayerSessionId() {
      return "11111111-1111-4111-8111-111111111111";
    },
    onUaPlayerResult(callback) {
      resultSubscription = callback;
      return () => {};
    },
    setUaPlayerSessionProvider(provider) {
      sessionProvider = provider;
      return true;
    },
  };
  const window = {
    Lampa,
    electronAPI: { player: electronPlayer },
    plugin_app_ready: true,
  };
  window.window = window;
  const context = {
    Lampa,
    clearTimeout() {},
    console: { error() {}, log() {}, warn() {} },
    encodeURIComponent,
    queueMicrotask() {},
    setTimeout: () => 0,
    window,
  };

  const pluginPath = path.join(projectRoot, "src", "plugin.js");
  vm.runInNewContext(fs.readFileSync(pluginPath, "utf8"), context, {
    filename: pluginPath,
  });

  assert.equal(typeof listeners.get("create"), "function");
  assert.equal(typeof resultSubscription, "function");

  let firstTimelineArgs;
  let currentTimelineArgs;
  const data = {
    url: "https://origin.example.test/episode-2.m3u8",
    title: "Серія 2",
    poster: "https://images.example.test/season.jpg",
    headers: { Authorization: "Bearer playback" },
    timeline: {
      hash: "timeline-hash",
      time: 12,
      handler(...args) {
        currentTimelineArgs = args;
      },
    },
    playlist_index: 1,
    playlist: [
      {
        url: "https://origin.example.test/episode-1.m3u8",
        title: "Серія 1",
        episode: 1,
        timeline: {
          handler(...args) {
            firstTimelineArgs = args;
          },
        },
      },
      {
        url: "https://origin.example.test/episode-2.m3u8",
        title: "Серія 2",
        episode: 2,
      },
    ],
    season: 1,
    episode: 2,
    card: {
      id: 125988,
      name: "Бункер",
      original_name: "Silo",
      media_type: "tv",
      first_air_date: "2023-05-04",
    },
    quality: {},
    subtitles: [],
    segments: [],
    stream: {
      quality: {
        "1080p": "https://origin.example.test/episode-2-1080.m3u8",
        "720p": "https://origin.example.test/episode-2-720.m3u8",
      },
      subtitles: [
        {
          url: "https://subtitles.example.test/episode-2.vtt",
          label: "Українська",
          language: "uk",
        },
      ],
      segments: [{ start: 10, end: 20, kind: "intro" }],
    },
  };

  listeners.get("create")({ data, abort() {} });
  assert.equal(preparedSessions.length, 0);
  // Lampa chooses its final URL after create and before the external event.
  data.url = data.stream.quality["1080p"];
  listeners.get("external")(data);
  preparedSessions.push(
    sessionProvider([encodeURI(Lampa.Torserver.toPlayUrl(data.url))]),
  );
  assert.equal(preparedSessions.length, 1);
  const prepared = preparedSessions[0];
  assert.equal(prepared.sessionId, "11111111-1111-4111-8111-111111111111");
  assert.equal(prepared.payload.schema, "lampaua-player-session-v1");
  assert.equal(prepared.payload.playlist_index, 1);
  assert.equal(prepared.payload.items.length, 2);
  assert.equal(prepared.payload.items[0].tmdb_id, 125988);
  assert.equal(prepared.payload.items[1].tmdb_id, 125988);
  assert.equal(prepared.payload.items[1].original_title, "Silo");
  assert.equal(prepared.payload.items[1].media_type, "tv");
  assert.equal(prepared.payload.items[1].year, 2023);
  assert.equal(
    prepared.payload.items[1].url,
    "http://localhost:8090/play/https%3A%2F%2Forigin.example.test%2Fepisode-2-1080.m3u8",
  );
  assert.equal(prepared.positionalUrl, prepared.payload.items[1].url);
  assert.equal(prepared.payload.items[1].position_ms, 12_000);
  assert.deepEqual(Object.keys(prepared.payload.items[0].quality), []);
  assert.equal(prepared.payload.items[0].subtitles.length, 0);
  assert.equal(
    prepared.payload.items[1].quality["1080p"],
    "http://localhost:8090/play/https%3A%2F%2Forigin.example.test%2Fepisode-2-1080.m3u8",
  );
  assert.equal(
    prepared.payload.items[1].subtitles[0].url,
    "https://subtitles.example.test/episode-2.vtt",
  );
  assert.equal(
    prepared.payload.items[1].headers.Authorization,
    "Bearer playback",
  );
  assert.equal(JSON.stringify(prepared).includes("handler"), false);
  assert.equal(JSON.stringify(prepared).includes("timeline-hash"), false);

  resultSubscription({
    sessionId: "unknown-session",
    result: validResult(),
  });
  assert.equal(firstTimelineArgs, undefined);
  assert.equal(currentTimelineArgs, undefined);

  const result = validResult({
    url: "https://origin.example.test/episode-2.m3u8",
    position: 30_000,
    duration: 60_000,
    playlist_index: 1,
    playback_results: [
      {
        end_by: "playing",
        url: "https://origin.example.test/episode-1.m3u8",
        position: 10_000,
        duration: 40_000,
        playlist_index: 0,
      },
      {
        end_by: "playing",
        url: "https://origin.example.test/episode-2.m3u8",
        position: 20_000,
        duration: 60_000,
        playlist_index: 1,
      },
    ],
  });
  resultSubscription({ sessionId: prepared.sessionId, result });
  assert.deepEqual(firstTimelineArgs, [25, 10, 40]);
  assert.deepEqual(currentTimelineArgs, [(20 / 60) * 100, 20, 60]);
  assert.equal(sentEvents.at(-1).eventName, "ua_player_result");
  assert.equal(sentEvents.at(-1).value, result);

  Lampa.Torserver = {};
  const torrentData = {
    url: "http://localhost:8090/stream?link=magnet&preload",
    title: "Торрент",
    timeline: { handler() {} },
  };
  listeners.get("create")({ data: torrentData });
  listeners.get("external")(torrentData);
  preparedSessions.push(
    sessionProvider([torrentData.url.replace("&preload", "&play")]),
  );
  assert.equal(
    preparedSessions.at(-1).payload.items[0].url,
    "http://localhost:8090/stream?link=magnet&play",
  );

  selectedPlayerPath = "C:\\Tools\\VLC\\vlc.exe";
  listeners.get("create")({
    data: { url: "https://origin.example.test/not-ua.m3u8" },
  });
  listeners.get("external")({ url: "https://origin.example.test/not-ua.m3u8" });
  assert.equal(
    sessionProvider(["https://origin.example.test/not-ua.m3u8"]),
    null,
  );
  assert.equal(preparedSessions.length, 2);
}

function main() {
  const { createUaPlayerSessionBridge } = require(bridgeModulePath);
  verifySessionCreation(createUaPlayerSessionBridge);
  verifyResultValidation(createUaPlayerSessionBridge);
  verifyPluginContract();
  console.log("UA Player session exchange contract verified");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
