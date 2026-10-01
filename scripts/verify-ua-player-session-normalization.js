const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createUaPlayerSessionBridge } = require(
  path.resolve(__dirname, "..", "src", "modules", "uaPlayerSessionBridge.js"),
);

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
      calls.push({ executablePath, legacy });
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

function verifyRichMetadataNormalization() {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "lampaua-session-normalization-"),
  );
  const protectedRoot = path.join(temporaryRoot, "protected");
  const localSubtitlePath = path.join(temporaryRoot, "uk.ass");
  const stage = createStageHarness(protectedRoot);
  const bridge = createUaPlayerSessionBridge({
    tempRoot: path.join(temporaryRoot, "temporary"),
    protectedRoot,
    stageProcess: stage.stageProcess,
  });

  try {
    bridge.prepareLaunch({
      executablePath: path.join(temporaryRoot, "UAPlayer.exe"),
      sessionId: "rich-metadata",
      payload: {
        schema: "lampaua-player-session-v1",
        return_result: true,
        callback() {},
        items: [
          {
            url: "https://stream.example.test/live.m3u8",
            url_reserve: "https://proxy.example.test/live.m3u8?token=protected",
            is_iptv: true,
            return_result: true,
            quality: {
              "1080p": {
                id: "full-hd",
                name: "Full HD",
                url: "https://stream.example.test/live-1080.m3u8",
                headers: {
                  Authorization: "Bearer quality-token",
                  Cookie: "must-not-cross",
                },
                mime_type: "application/vnd.apple.mpegurl",
                width: 1920,
                height: 1080,
                bitrate: 8_000_000,
                callback() {},
              },
            },
            subtitles: [
              {
                id: "uk-network",
                label: "Українська",
                language: "uk",
                format: "vtt",
                url: "https://subtitles.example.test/uk.vtt",
                headers: {
                  Authorization: "Bearer subtitle-token",
                  Cookie: "must-not-cross",
                },
                default: true,
                forced: true,
                callback() {},
              },
              {
                id: "uk-local",
                label: "Українська ASS",
                language: "uk",
                format: "ass",
                path: localSubtitlePath,
              },
            ],
            segments: [],
            _session_segments: [
              {
                id: "intro-1",
                type: "intro",
                start_ms: 1_000,
                end_ms: 5_000,
                mode: "automatic",
                label: "Вступ",
                callback() {},
              },
            ],
            unknown_object: { capability: "must-not-cross" },
          },
          {
            url: "https://stream.example.test/episode-2.m3u8",
            segments: [
              {
                id: "credits-1",
                type: "credits",
                start_ms: 10_000,
                end_ms: 20_000,
                mode: "full",
                label: "Титри",
              },
            ],
            _session_segments: [
              {
                id: "fallback-must-not-win",
                type: "intro",
                start_ms: 2_000,
                end_ms: 6_000,
              },
            ],
          },
        ],
      },
      owner: {},
    });

    assert.equal(stage.calls.length, 1);
    const [live, explicitSegments] = stage.calls[0].legacy.items;
    assert.equal(live.is_live, true);
    assert.equal(
      live.url_reserve,
      "https://proxy.example.test/live.m3u8?token=protected",
    );
    assert.deepEqual(live.quality["1080p"], {
      id: "full-hd",
      name: "Full HD",
      url: "https://stream.example.test/live-1080.m3u8",
      headers: { Authorization: "Bearer quality-token" },
      mime_type: "application/vnd.apple.mpegurl",
      width: 1920,
      height: 1080,
      bitrate: 8_000_000,
    });
    assert.deepEqual(live.subtitles, [
      {
        id: "uk-network",
        label: "Українська",
        language: "uk",
        format: "vtt",
        url: "https://subtitles.example.test/uk.vtt",
        headers: { Authorization: "Bearer subtitle-token" },
        default: true,
        forced: true,
      },
      {
        id: "uk-local",
        label: "Українська ASS",
        language: "uk",
        format: "ass",
        path: localSubtitlePath,
        headers: {},
      },
    ]);
    assert.deepEqual(live._session_segments, [
      {
        start_ms: 1_000,
        end_ms: 5_000,
        id: "intro-1",
        type: "intro",
        mode: "automatic",
        label: "Вступ",
      },
    ]);
    assert.deepEqual(explicitSegments._session_segments, [
      {
        start_ms: 10_000,
        end_ms: 20_000,
        id: "credits-1",
        type: "credits",
        mode: "full",
        label: "Титри",
      },
    ]);
    assert.equal(live.unknown_object, undefined);
    assert.equal(live.return_result, undefined);
    assert.equal(stage.calls[0].legacy.return_result, undefined);
    assert.equal(
      JSON.stringify(stage.calls[0].legacy).includes("callback"),
      false,
    );
    assert.equal(
      JSON.stringify(stage.calls[0].legacy).includes("must-not-cross"),
      false,
    );
    for (const [index, urlReserve] of [
      "file:///C:/private.mp4",
      "rtsp://proxy.example.test/live",
      "https://user:password@proxy.example.test/live.m3u8",
    ].entries()) {
      assert.throws(
        () =>
          bridge.prepareLaunch({
            executablePath: path.join(temporaryRoot, "UAPlayer.exe"),
            sessionId: `invalid-reserve-${index}`,
            payload: {
              schema: "lampaua-player-session-v1",
              items: [
                {
                  url: "https://stream.example.test/live.m3u8",
                  url_reserve: urlReserve,
                },
              ],
            },
            owner: {},
          }),
        /reserve|not allowed/i,
      );
    }
  } finally {
    bridge.cleanupAll();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  verifyRichMetadataNormalization();
  console.log("UA Player session metadata normalization verified");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
