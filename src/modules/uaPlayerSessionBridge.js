const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SESSION_SCHEMA = "lampaua-player-session-v1";
const RESULT_SCHEMA = "lampaua-player-result-v1";
const CANONICAL_RESULT_SCHEMA = "lampaua.player.playback-result";
const STAGE_RESULT_SCHEMA = "lampaua.player.stage-result";
const STAGE_COMMAND = "--stage-lampaua-session";
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_ITEMS = 20_000;
const MAX_HEADERS = 64;
const MAX_QUALITIES = 32;
const MAX_SUBTITLES = 64;
const MAX_SEGMENTS = 128;
const MAX_URL_CHARS = 32 * 1024;
const ALLOWED_URL_PROTOCOLS = new Set([
  "file:",
  "http:",
  "https:",
  "rtmp:",
  "rtsp:",
  "tcp:",
  "udp:",
]);
const ALLOWED_CANONICAL_STATUSES = new Set([
  "completed",
  "failed",
  "replaced",
  "stopped",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownValue(object, ...keys) {
  if (!isObject(object)) return undefined;
  for (const key of keys) {
    if (Object.hasOwn(object, key)) {
      return object[key];
    }
  }
  return undefined;
}

function boundedText(value, maxChars = 4096) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.slice(0, maxChars);
}

function integerValue(value, fallback = undefined) {
  if (!Number.isSafeInteger(value)) return fallback;
  return value;
}

function normalizedUrl(value, fieldName, required = false, strict = true) {
  const text = boundedText(value, MAX_URL_CHARS);
  if (!text) {
    if (required) throw new Error(`${fieldName} URL is required`);
    return undefined;
  }

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    if (!required && !strict) return undefined;
    throw new Error(`${fieldName} URL is invalid`);
  }

  if (
    !ALLOWED_URL_PROTOCOLS.has(parsed.protocol.toLowerCase()) ||
    parsed.username ||
    parsed.password
  ) {
    if (!required && !strict) return undefined;
    throw new Error(`${fieldName} URL is not allowed`);
  }
  if (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    !parsed.hostname
  ) {
    if (!required && !strict) return undefined;
    throw new Error(`${fieldName} URL is invalid`);
  }
  return text;
}

function normalizeHeaders(value) {
  if (!isObject(value)) return {};
  const result = {};
  let count = 0;

  for (const [rawName, rawValue] of Object.entries(value)) {
    if (count >= MAX_HEADERS) break;
    if (typeof rawValue !== "string") continue;
    const name = boundedText(rawName, 256);
    if (!name) continue;
    const lowerName = name.toLowerCase();
    if (
      lowerName === "cookie" ||
      lowerName === "cookie2" ||
      lowerName === "set-cookie"
    ) {
      continue;
    }
    if (rawValue.length > 64 * 1024) {
      throw new Error(`Header ${name} is too large`);
    }
    result[name] = rawValue;
    count += 1;
  }
  return result;
}

function normalizeQualities(item) {
  const raw = ownValue(item, "quality", "qualities");
  const result = {};
  const entries = [];

  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (!isObject(value)) continue;
      entries.push([
        ownValue(value, "label", "name", "display_name", "id"),
        value,
      ]);
    }
  } else if (isObject(raw)) {
    for (const [label, value] of Object.entries(raw)) {
      entries.push([label, value]);
    }
  }

  for (const [rawLabel, rawValue] of entries.slice(0, MAX_QUALITIES)) {
    const label = boundedText(rawLabel, 128);
    if (!label) continue;
    const rawUrl = isObject(rawValue)
      ? ownValue(rawValue, "url", "uri", "src")
      : rawValue;
    const url = normalizedUrl(rawUrl, `quality ${label}`, false, false);
    if (!url) continue;
    if (!isObject(rawValue)) {
      result[label] = url;
      continue;
    }

    const quality = { url };
    const id = boundedText(ownValue(rawValue, "id"), 128);
    const name = boundedText(
      ownValue(rawValue, "name", "display_name", "label"),
      256,
    );
    const mimeType = boundedText(ownValue(rawValue, "mime_type", "mime"), 256);
    const headers = normalizeHeaders(ownValue(rawValue, "headers"));
    if (id) quality.id = id;
    if (name) quality.name = name;
    if (Object.keys(headers).length > 0) quality.headers = headers;
    if (mimeType) quality.mime_type = mimeType;
    for (const field of ["width", "height", "bitrate"]) {
      const value = integerValue(ownValue(rawValue, field));
      if (value !== undefined && value > 0) quality[field] = value;
    }
    result[label] =
      Object.keys(quality).length === 1 && quality.url === url ? url : quality;
  }
  return result;
}

function normalizeSubtitles(value) {
  if (!Array.isArray(value)) return [];
  const result = [];

  for (const raw of value.slice(0, MAX_SUBTITLES)) {
    if (!isObject(raw)) continue;
    const url = normalizedUrl(
      ownValue(raw, "url", "uri", "src", "file"),
      "subtitle",
      false,
      false,
    );
    const rawPath = boundedText(
      ownValue(raw, "path", "local_path"),
      MAX_URL_CHARS,
    );
    const localPath =
      rawPath && path.isAbsolute(rawPath) ? path.resolve(rawPath) : undefined;
    if ((!url && !localPath) || (url && localPath)) continue;
    const subtitle = url ? { url } : { path: localPath };
    const id = boundedText(ownValue(raw, "id"), 256);
    const label = boundedText(ownValue(raw, "label", "title", "name"), 256);
    const language = boundedText(ownValue(raw, "language", "lang"), 32);
    const format = boundedText(ownValue(raw, "format", "extension"), 32);
    const headers = normalizeHeaders(ownValue(raw, "headers"));
    if (id) subtitle.id = id;
    if (label) subtitle.label = label;
    if (language) subtitle.language = language.toLowerCase();
    if (format) subtitle.format = format.toLowerCase();
    subtitle.headers = headers;
    if (ownValue(raw, "default", "is_default", "enabled") === true) {
      subtitle.default = true;
    }
    if (ownValue(raw, "forced", "is_forced") === true) subtitle.forced = true;
    result.push(subtitle);
  }
  return result;
}

function flattenSegments(value) {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return [];
  const result = [];
  for (const [kind, segments] of Object.entries(value)) {
    if (!Array.isArray(segments)) continue;
    for (const segment of segments) {
      if (isObject(segment)) result.push({ ...segment, kind });
    }
  }
  return result;
}

function hasSegments(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (!isObject(value)) return false;
  return Object.values(value).some(
    (segments) => Array.isArray(segments) && segments.length > 0,
  );
}

function normalizeSegmentValue(raw) {
  const result = [];

  for (const segment of flattenSegments(raw).slice(0, MAX_SEGMENTS)) {
    const usesMilliseconds =
      Object.hasOwn(segment, "start_ms") || Object.hasOwn(segment, "end_ms");
    const multiplier = usesMilliseconds ? 1 : 1000;
    const startValue = ownValue(
      segment,
      usesMilliseconds ? "start_ms" : "start",
    );
    const endValue = ownValue(segment, usesMilliseconds ? "end_ms" : "end");
    if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) continue;
    const startMs = Math.round(startValue * multiplier);
    const endMs = Math.round(endValue * multiplier);
    if (startMs < 0 || endMs <= startMs) continue;
    const normalized = { start_ms: startMs, end_ms: endMs };
    const id = boundedText(ownValue(segment, "id"), 256);
    const type = boundedText(ownValue(segment, "type", "kind"), 32);
    const mode = boundedText(ownValue(segment, "mode"), 32);
    const label = boundedText(ownValue(segment, "label", "title"), 256);
    const source = boundedText(ownValue(segment, "source"), 128);
    if (id) normalized.id = id;
    if (type) normalized.type = type;
    if (mode) normalized.mode = mode;
    if (label) normalized.label = label;
    if (source) normalized.source = source;
    if (ownValue(segment, "whole_content_ad") === true) {
      normalized.whole_content_ad = true;
    }
    result.push(normalized);
  }
  return result;
}

function normalizeSegments(item) {
  const primary = ownValue(item, "segments");
  return normalizeSegmentValue(
    hasSegments(primary) ? primary : ownValue(item, "_session_segments"),
  );
}

function copyTextFields(source, target) {
  const fields = [
    ["id", ["id"]],
    ["title", ["title", "name"]],
    ["filename", ["filename", "file_name"]],
    ["mime_type", ["mime_type", "mimeType", "content_type"]],
    ["group", ["group", "group_title"]],
    ["tvg_id", ["tvg_id", "tvg-id"]],
    ["tvg_name", ["tvg_name", "tvg-name"]],
    ["language", ["language", "lang"]],
    ["catchup", ["catchup"]],
    ["catchup_source", ["catchup_source", "catchup-source"]],
    ["imdb_id", ["imdb_id", "imdbId"]],
    ["media_type", ["media_type", "mediaType"]],
    ["original_title", ["original_title", "originalTitle"]],
  ];

  for (const [outputName, inputNames] of fields) {
    const value = boundedText(ownValue(source, ...inputNames));
    if (value) target[outputName] = value;
  }
}

function copyIntegerFields(source, target) {
  const fields = [
    ["tmdb_id", ["tmdb_id", "tmdbId"], 1],
    ["kp_id", ["kp_id", "kinopoisk_id", "kinopoiskId"], 1],
    ["mal_id", ["mal_id", "malId"], 1],
    ["year", ["year", "release_year"], 1],
    ["season", ["season", "season_number", "seasonNumber"], 1],
    ["episode", ["episode", "episode_number", "episodeNumber"], 1],
    ["position_ms", ["position_ms", "position"], 0],
    ["cache_ttl_ms", ["cache_ttl_ms"], 0],
  ];

  for (const [outputName, inputNames, minimum] of fields) {
    const value = integerValue(ownValue(source, ...inputNames));
    if (value !== undefined && value >= minimum) target[outputName] = value;
  }
}

function normalizeItem(rawItem, index) {
  if (!isObject(rawItem)) {
    if (typeof rawItem === "string") rawItem = { url: rawItem };
    else throw new Error(`Playlist item ${index + 1} is invalid`);
  }

  const item = {};
  const url = normalizedUrl(
    ownValue(rawItem, "url", "media_url", "stream_url"),
    `playlist item ${index + 1}`,
  );
  const resolverUrl = normalizedUrl(
    ownValue(rawItem, "resolver_url", "resolver", "call_url"),
    `playlist resolver ${index + 1}`,
  );
  const thumbnail = normalizedUrl(
    ownValue(rawItem, "thumbnail", "poster", "image"),
    `playlist thumbnail ${index + 1}`,
    false,
    false,
  );
  if (url) item.url = url;
  if (resolverUrl) item.resolver_url = resolverUrl;
  if (thumbnail) item.thumbnail = thumbnail;
  copyTextFields(rawItem, item);
  copyIntegerFields(rawItem, item);
  if (ownValue(rawItem, "is_anime", "anime") === true) item.is_anime = true;
  const isLive = ownValue(rawItem, "is_live", "is_iptv");
  if (typeof isLive === "boolean") item.is_live = isLive;
  item.headers = normalizeHeaders(ownValue(rawItem, "headers"));
  item.resolver_headers = normalizeHeaders(
    ownValue(rawItem, "resolver_headers"),
  );
  item.quality = normalizeQualities(rawItem);
  item.subtitles = normalizeSubtitles(ownValue(rawItem, "subtitles"));
  item._session_segments = normalizeSegments(rawItem);

  if (
    !item.url &&
    !item.resolver_url &&
    Object.keys(item.quality).length === 0
  ) {
    throw new Error(`Playlist item ${index + 1} requires a playable URL`);
  }
  return item;
}

function normalizeSession(sessionId, payload, positionalUrl) {
  if (
    typeof sessionId !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)
  ) {
    throw new Error("Session id is invalid");
  }
  if (!isObject(payload) || ownValue(payload, "schema") !== SESSION_SCHEMA) {
    throw new Error(`Session schema must be ${SESSION_SCHEMA}`);
  }

  let rawItems = ownValue(payload, "items");
  if (!Array.isArray(rawItems)) rawItems = [];
  if (rawItems.length === 0 && positionalUrl)
    rawItems = [{ url: positionalUrl }];
  if (rawItems.length === 0) throw new Error("Session playlist is empty");
  if (rawItems.length > MAX_ITEMS) {
    throw new Error(`Session playlist exceeds ${MAX_ITEMS} items`);
  }

  const items = rawItems.map(normalizeItem);
  const rawIndex = integerValue(ownValue(payload, "playlist_index"), 0);
  const playlistIndex = Math.max(0, Math.min(rawIndex, items.length - 1));
  const title = boundedText(ownValue(payload, "title", "name"), 4096);
  const session = {
    schema: SESSION_SCHEMA,
    session_id: sessionId,
    playlist_index: playlistIndex,
    auto_next: ownValue(payload, "auto_next") !== false,
    items,
  };
  if (title) session.title = title;
  return session;
}

function validateResultNumber(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Result ${fieldName} is invalid`);
  }
  return value;
}

function sourceUrl(item) {
  if (typeof item?.url === "string") return item.url;
  if (typeof item?.resolver_url === "string") return item.resolver_url;
  const quality = isObject(item?.quality) ? Object.values(item.quality) : [];
  for (const value of quality) {
    if (typeof value === "string") return value;
    const url = isObject(value)
      ? ownValue(value, "url", "uri", "src")
      : undefined;
    if (typeof url === "string") return url;
  }
  return "";
}

function mapCanonicalEndReason(status, completed, isCurrent) {
  if (completed) return "ended";
  if (!isCurrent) return "playing";
  return {
    completed: "ended",
    failed: "failed",
    replaced: "replaced",
    stopped: "user",
  }[status];
}

function normalizeCanonicalResult(raw, state) {
  if (
    !isObject(raw) ||
    ownValue(raw, "schema") !== CANONICAL_RESULT_SCHEMA ||
    ownValue(raw, "version") !== 1 ||
    ownValue(raw, "request_id") !== state.requestId ||
    ownValue(raw, "nonce") !== state.nonce
  ) {
    throw new Error("Canonical result correlation is invalid");
  }
  const status = boundedText(ownValue(raw, "status"), 32);
  if (!status || !ALLOWED_CANONICAL_STATUSES.has(status)) {
    throw new Error("Canonical result status is invalid");
  }
  const currentIndex = validateResultNumber(
    ownValue(raw, "current_index"),
    "current_index",
  );
  if (currentIndex >= state.items.length) {
    throw new Error("Canonical result current_index is out of range");
  }
  const rawItems = ownValue(raw, "playback_results");
  if (!Array.isArray(rawItems) || rawItems.length > state.items.length) {
    throw new Error("Canonical playback_results is invalid");
  }

  const byIndex = new Map();
  for (const rawItem of rawItems) {
    if (!isObject(rawItem)) throw new Error("Canonical result item is invalid");
    const index = validateResultNumber(ownValue(rawItem, "index"), "index");
    if (index >= state.items.length || byIndex.has(index)) {
      throw new Error("Canonical result item index is invalid");
    }
    const position = validateResultNumber(
      ownValue(rawItem, "position_ms"),
      "position_ms",
    );
    const durationValue = ownValue(rawItem, "duration_ms");
    const duration =
      durationValue === null || durationValue === undefined
        ? 0
        : validateResultNumber(durationValue, "duration_ms");
    if (duration > 0 && position > duration) {
      throw new Error("Canonical result position exceeds duration");
    }
    if (
      typeof ownValue(rawItem, "completed") !== "boolean" ||
      (typeof rawItem.id === "string" &&
        typeof state.items[index].id === "string" &&
        rawItem.id !== state.items[index].id)
    ) {
      throw new Error("Canonical result item identity is invalid");
    }

    byIndex.set(index, {
      end_by: mapCanonicalEndReason(
        status,
        rawItem.completed,
        index === currentIndex,
      ),
      url: sourceUrl(state.items[index]),
      position,
      duration,
      playlist_index: index,
    });
  }
  const current = byIndex.get(currentIndex);
  if (!current) throw new Error("Canonical current result item is missing");
  return {
    schema: RESULT_SCHEMA,
    ...current,
    playback_results: Array.from(byIndex.values()).sort(
      (left, right) => left.playlist_index - right.playlist_index,
    ),
  };
}

function canonicalUuidV4(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function canonicalNonce(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(value)) {
    return false;
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === 16 && bytes.toString("base64url") === value;
  } catch {
    return false;
  }
}

function normalizedAbsolutePath(value, fieldName) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${fieldName} path is invalid`);
  }
  return path.resolve(value);
}

function equalPath(left, right) {
  const leftValue = path.resolve(left);
  const rightValue = path.resolve(right);
  return process.platform === "win32"
    ? leftValue.toLowerCase() === rightValue.toLowerCase()
    : leftValue === rightValue;
}

function validateBridgeRoot(value, protectedRoot) {
  const returnedRoot = normalizedAbsolutePath(value, "bridge root");
  const expectedRoot = normalizedAbsolutePath(protectedRoot, "bridge root");
  if (equalPath(returnedRoot, expectedRoot)) return returnedRoot;

  const localApplicationData = process.env.LOCALAPPDATA;
  if (process.platform !== "win32" || !localApplicationData) {
    throw new Error("UA Player staging bridge root is invalid");
  }
  const packagesRoot = path.join(
    path.resolve(localApplicationData),
    "Packages",
  );
  const relative = path.relative(packagesRoot, returnedRoot);
  const segments = relative.split(path.sep).filter(Boolean);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    segments.includes("..") ||
    segments.length !== 6 ||
    !/^[A-Za-z0-9._-]{1,255}$/.test(segments[0]) ||
    segments[1] !== "LocalCache" ||
    segments[2] !== "Local" ||
    segments[3] !== "LampaUA" ||
    segments[4] !== "PlayerBridge" ||
    segments[5] !== "v1"
  ) {
    throw new Error("UA Player staging bridge root is invalid");
  }
  return returnedRoot;
}

function validateStageResult(raw, sessionId, protectedRoot) {
  if (
    !isObject(raw) ||
    raw.schema !== STAGE_RESULT_SCHEMA ||
    raw.version !== 1 ||
    raw.session_id !== sessionId ||
    !canonicalUuidV4(raw.request_id) ||
    !canonicalNonce(raw.nonce)
  ) {
    throw new Error("UA Player staging result is invalid");
  }
  const root = validateBridgeRoot(raw.bridge_root, protectedRoot);
  const sessionDirectory = path.join(root, raw.request_id);
  const requestPath = normalizedAbsolutePath(raw.request_path, "request");
  const resultPath = normalizedAbsolutePath(raw.result_path, "result");
  if (
    !equalPath(requestPath, path.join(sessionDirectory, "request.json")) ||
    !equalPath(resultPath, path.join(sessionDirectory, "result.json")) ||
    !fs.existsSync(requestPath) ||
    fs.lstatSync(requestPath).isSymbolicLink()
  ) {
    throw new Error("UA Player staging paths are invalid");
  }
  return {
    nonce: raw.nonce,
    requestId: raw.request_id,
    requestPath,
    resultPath,
    root,
    sessionDirectory,
  };
}

function stageWithUaPlayer(executablePath, sessionPath) {
  if (typeof executablePath !== "string" || !path.isAbsolute(executablePath)) {
    throw new Error("UA Player executable path is invalid");
  }
  const outcome = spawnSync(executablePath, [STAGE_COMMAND, sessionPath], {
    encoding: "utf8",
    maxBuffer: MAX_RESULT_BYTES,
    shell: false,
    timeout: 15_000,
    windowsHide: true,
  });
  if (
    outcome.error ||
    outcome.signal ||
    outcome.status !== 0 ||
    typeof outcome.stdout !== "string" ||
    Buffer.byteLength(outcome.stdout) > MAX_RESULT_BYTES
  ) {
    throw new Error("UA Player staging process failed");
  }
  return JSON.parse(outcome.stdout);
}

function writeAtomicFile(filePath, bytes) {
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function readBoundedJson(filePath) {
  let descriptor;
  try {
    const linkInfo = fs.lstatSync(filePath);
    if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) return null;
    descriptor = fs.openSync(filePath, "r");
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_RESULT_BYTES) {
      return null;
    }
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count <= 0) return null;
      offset += count;
    }
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function createUaPlayerSessionBridge({
  tempRoot,
  protectedRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "LampaUA", "PlayerBridge", "v1")
    : undefined,
  stageProcess = stageWithUaPlayer,
} = {}) {
  if (typeof tempRoot !== "string" || !path.isAbsolute(tempRoot)) {
    throw new Error("UA Player session temp root must be absolute");
  }
  if (typeof protectedRoot !== "string" || !path.isAbsolute(protectedRoot)) {
    throw new Error("UA Player protected bridge root must be absolute");
  }
  if (typeof stageProcess !== "function") {
    throw new Error("UA Player staging process must be callable");
  }
  const active = new Set();

  function cleanupState(state) {
    if (state.cleaned) return;
    state.cleaned = true;
    active.delete(state);
    fs.rmSync(state.directory, { recursive: true, force: true });
    if (state.protectedSessionDirectory) {
      try {
        const expected = path.join(state.bridgeRoot, state.requestId);
        if (equalPath(state.protectedSessionDirectory, expected)) {
          fs.rmSync(state.protectedSessionDirectory, {
            recursive: true,
            force: true,
          });
          fs.rmSync(path.join(state.bridgeRoot, `.lease-${state.requestId}`), {
            force: true,
          });
        }
      } catch {
        // The player janitor owns any session still locked during renderer teardown.
      }
    }
  }

  function prepareLaunch({
    executablePath,
    sessionId,
    payload,
    positionalUrl,
    owner,
  } = {}) {
    if (payload === undefined || payload === null) {
      return {
        args: positionalUrl ? ["--url", positionalUrl] : [],
        cleanup() {},
        finish() {
          return null;
        },
        sessionId,
        usesSession: false,
      };
    }

    const normalized = normalizeSession(sessionId, payload, positionalUrl);
    const bytes = Buffer.from(JSON.stringify(normalized));
    if (bytes.length > MAX_SESSION_BYTES) {
      throw new Error("UA Player session exceeds 16 MiB");
    }

    fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
    const directory = fs.mkdtempSync(path.join(tempRoot, "lampaua-player-"));
    fs.chmodSync(directory, 0o700);
    const state = {
      cleaned: false,
      directory,
      finished: false,
      itemCount: normalized.items.length,
      items: normalized.items,
      owner,
      bridgeRoot: null,
      protectedSessionDirectory: null,
      requestId: null,
      nonce: null,
    };
    active.add(state);

    try {
      const sessionPath = path.join(directory, "session.json");
      writeAtomicFile(sessionPath, bytes);
      const staged = validateStageResult(
        stageProcess(executablePath, sessionPath),
        sessionId,
        protectedRoot,
      );
      state.bridgeRoot = staged.root;
      state.protectedSessionDirectory = staged.sessionDirectory;
      state.requestId = staged.requestId;
      state.nonce = staged.nonce;
      fs.rmSync(directory, { recursive: true, force: true });
      return {
        args: ["--payload-file", staged.requestPath],
        cleanup() {
          cleanupState(state);
        },
        finish() {
          if (state.finished) return null;
          state.finished = true;
          try {
            const rawResult = readBoundedJson(staged.resultPath);
            return rawResult
              ? normalizeCanonicalResult(rawResult, state)
              : null;
          } catch {
            return null;
          } finally {
            cleanupState(state);
          }
        },
        sessionId,
        requestId: staged.requestId,
        nonce: staged.nonce,
        requestPath: staged.requestPath,
        resultPath: staged.resultPath,
        usesSession: true,
      };
    } catch (error) {
      cleanupState(state);
      throw error;
    }
  }

  return {
    cleanupAll() {
      for (const state of [...active]) cleanupState(state);
    },
    cleanupOwner(owner) {
      for (const state of [...active]) {
        if (state.owner === owner) cleanupState(state);
      }
    },
    prepareLaunch,
  };
}

let defaultBridge;

function getDefaultBridge() {
  if (!defaultBridge) {
    const { app } = require("electron");
    defaultBridge = createUaPlayerSessionBridge({
      tempRoot: app.getPath("temp"),
    });
  }
  return defaultBridge;
}

module.exports = {
  cleanupAll: () => defaultBridge?.cleanupAll(),
  cleanupOwner: (owner) => defaultBridge?.cleanupOwner(owner),
  createUaPlayerSessionBridge,
  prepareLaunch: (options) => getDefaultBridge().prepareLaunch(options),
};
