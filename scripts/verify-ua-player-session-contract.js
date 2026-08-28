const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

function resultPathFor(launch) {
  const index = launch.args.indexOf("--result-file");
  assert.notEqual(index, -1);
  return launch.args[index + 1];
}

function sessionPathFor(launch) {
  const index = launch.args.indexOf("--session-json");
  assert.notEqual(index, -1);
  return launch.args[index + 1];
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

function verifySessionCreation(createUaPlayerSessionBridge) {
  const temporaryRoot = createTemporaryRoot();
  const owner = {};
  const bridge = createUaPlayerSessionBridge({ tempRoot: temporaryRoot });

  try {
    const fallback = bridge.prepareLaunch({
      sessionId: "fallback",
      positionalUrl: "https://stream.example.test/plain.m3u8",
      owner,
    });
    assert.deepEqual(fallback.args, ["https://stream.example.test/plain.m3u8"]);
    assert.equal(fallback.finish(), null);

    const first = bridge.prepareLaunch({
      sessionId: "session-a",
      payload: validPayload(),
      positionalUrl: "https://stream.example.test/plain.m3u8",
      owner,
    });
    const second = bridge.prepareLaunch({
      sessionId: "session-b",
      payload: validPayload(),
      owner,
    });
    const firstSessionPath = sessionPathFor(first);
    const secondSessionPath = sessionPathFor(second);
    assert.notEqual(firstSessionPath, secondSessionPath);
    assert.equal(
      path.dirname(firstSessionPath).startsWith(temporaryRoot),
      true,
    );
    assert.deepEqual(first.args.slice(0, 2), [
      "--session-json",
      firstSessionPath,
    ]);
    assert.equal(first.args[2], "--result-file");

    const written = JSON.parse(fs.readFileSync(firstSessionPath, "utf8"));
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
    assert.equal(fs.existsSync(path.dirname(firstSessionPath)), false);
    bridge.cleanupOwner(owner);
    assert.equal(fs.existsSync(path.dirname(secondSessionPath)), false);

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
  const bridge = createUaPlayerSessionBridge({ tempRoot: temporaryRoot });
  const owner = {};

  function prepare(sessionId) {
    return bridge.prepareLaunch({
      sessionId,
      payload: validPayload(),
      owner,
    });
  }

  function verifyRejected(sessionId, writeResult) {
    const launch = prepare(sessionId);
    const directory = path.dirname(sessionPathFor(launch));
    writeResult(resultPathFor(launch));
    assert.equal(launch.finish(), null);
    assert.equal(fs.existsSync(directory), false);
  }

  try {
    const valid = prepare("valid-result");
    const validDirectory = path.dirname(sessionPathFor(valid));
    writeAtomicJson(
      resultPathFor(valid),
      validResult({
        api_key: "drop-me",
        headers: { Authorization: "drop-me" },
        playback_results: [
          {
            end_by: "playing",
            url: "https://stream.example.test/second.m3u8",
            position: 10_000,
            duration: 48_000,
            playlist_index: 0,
          },
          {
            end_by: "playing",
            url: "https://stream.example.test/video.m3u8",
            position: 20_000,
            duration: 48_000,
            playlist_index: 0,
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

    verifyRejected("missing-result", () => {});
    verifyRejected("malformed-result", (filePath) => {
      fs.writeFileSync(filePath, "{not-json");
    });
    verifyRejected("wrong-schema", (filePath) => {
      writeAtomicJson(filePath, validResult({ schema: "wrong" }));
    });
    verifyRejected("negative-result", (filePath) => {
      writeAtomicJson(filePath, validResult({ position: -1 }));
    });
    verifyRejected("position-over-duration", (filePath) => {
      writeAtomicJson(
        filePath,
        validResult({ position: 49_000, duration: 48_000 }),
      );
    });
    verifyRejected("bad-index", (filePath) => {
      writeAtomicJson(filePath, validResult({ playlist_index: 1 }));
    });
    verifyRejected("bad-result-url", (filePath) => {
      writeAtomicJson(filePath, validResult({ url: "data:text/plain,no" }));
    });
    verifyRejected("oversized-result", (filePath) => {
      fs.writeFileSync(filePath, Buffer.alloc(MAX_RESULT_BYTES + 1, 0x20));
    });
  } finally {
    bridge.cleanupAll();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function main() {
  const { createUaPlayerSessionBridge } = require(bridgeModulePath);
  verifySessionCreation(createUaPlayerSessionBridge);
  verifyResultValidation(createUaPlayerSessionBridge);
  console.log("UA Player session exchange contract verified");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
