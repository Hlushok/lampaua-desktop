const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SESSION_SCHEMA = "lampaua-player-session-v1";
const RESULT_SCHEMA = "lampaua-player-result-v1";
const MAX_SESSION_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_ITEMS = 256;
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
const ALLOWED_END_REASONS = new Set([
  "ended",
  "failed",
  "playing",
  "stopped",
  "user",
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

function normalizedUrl(value, fieldName, required = false) {
  const text = boundedText(value, MAX_URL_CHARS);
  if (!text) {
    if (required) throw new Error(`${fieldName} URL is required`);
    return undefined;
  }

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${fieldName} URL is invalid`);
  }

  if (
    !ALLOWED_URL_PROTOCOLS.has(parsed.protocol.toLowerCase()) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(`${fieldName} URL is not allowed`);
  }
  if (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    !parsed.hostname
  ) {
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
        ownValue(value, "label", "name"),
        ownValue(value, "url", "src"),
      ]);
    }
  } else if (isObject(raw)) {
    for (const [label, value] of Object.entries(raw)) {
      entries.push([
        label,
        isObject(value) ? ownValue(value, "url", "src") : value,
      ]);
    }
  }

  for (const [rawLabel, rawUrl] of entries.slice(0, MAX_QUALITIES)) {
    const label = boundedText(rawLabel, 128);
    if (!label) continue;
    const url = normalizedUrl(rawUrl, `quality ${label}`);
    if (url) result[label] = url;
  }
  return result;
}

function normalizeSubtitles(value) {
  if (!Array.isArray(value)) return [];
  const result = [];

  for (const raw of value.slice(0, MAX_SUBTITLES)) {
    if (!isObject(raw)) continue;
    const url = normalizedUrl(ownValue(raw, "url", "file"), "subtitle");
    if (!url) continue;
    const subtitle = { url };
    const label = boundedText(ownValue(raw, "label", "title", "name"), 256);
    const language = boundedText(ownValue(raw, "language", "lang"), 32);
    if (label) subtitle.label = label;
    if (language) subtitle.language = language.toLowerCase();
    if (ownValue(raw, "default") === true) subtitle.default = true;
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

function normalizeSegments(item) {
  const raw = ownValue(item, "_session_segments", "segments");
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
    const kind = boundedText(ownValue(segment, "kind", "type"), 32);
    const source = boundedText(ownValue(segment, "source"), 128);
    if (kind) normalized.kind = kind;
    if (source) normalized.source = source;
    if (ownValue(segment, "whole_content_ad") === true) {
      normalized.whole_content_ad = true;
    }
    result.push(normalized);
  }
  return result;
}

function copyTextFields(source, target) {
  const fields = [
    ["id", ["id"]],
    ["title", ["title", "name"]],
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
  );
  if (url) item.url = url;
  if (resolverUrl) item.resolver_url = resolverUrl;
  if (thumbnail) item.thumbnail = thumbnail;
  copyTextFields(rawItem, item);
  copyIntegerFields(rawItem, item);
  if (ownValue(rawItem, "is_anime", "anime") === true) item.is_anime = true;
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

function normalizeResultEntry(raw, itemCount, includeSchema) {
  if (!isObject(raw)) throw new Error("Result entry is invalid");
  const endBy = boundedText(ownValue(raw, "end_by"), 32);
  if (!endBy || !ALLOWED_END_REASONS.has(endBy)) {
    throw new Error("Result end_by is invalid");
  }
  const url = normalizedUrl(ownValue(raw, "url"), "result", true);
  const position = validateResultNumber(ownValue(raw, "position"), "position");
  const duration = validateResultNumber(ownValue(raw, "duration"), "duration");
  if (position > duration) throw new Error("Result position exceeds duration");
  const playlistIndex = validateResultNumber(
    ownValue(raw, "playlist_index"),
    "playlist_index",
  );
  if (playlistIndex >= itemCount) {
    throw new Error("Result playlist_index is out of range");
  }

  const result = {};
  if (includeSchema) result.schema = RESULT_SCHEMA;
  result.end_by = endBy;
  result.url = url;
  result.position = position;
  result.duration = duration;
  result.playlist_index = playlistIndex;
  return result;
}

function normalizeResult(raw, itemCount) {
  if (!isObject(raw) || ownValue(raw, "schema") !== RESULT_SCHEMA) {
    throw new Error(`Result schema must be ${RESULT_SCHEMA}`);
  }
  const result = normalizeResultEntry(raw, itemCount, true);
  const rawPlaybackResults = ownValue(raw, "playback_results");
  if (rawPlaybackResults !== undefined && !Array.isArray(rawPlaybackResults)) {
    throw new Error("Result playback_results is invalid");
  }
  if ((rawPlaybackResults?.length || 0) > MAX_ITEMS) {
    throw new Error(`Result playback_results exceeds ${MAX_ITEMS} items`);
  }

  const byIndex = new Map();
  for (const rawEntry of rawPlaybackResults || []) {
    const entry = normalizeResultEntry(rawEntry, itemCount, false);
    byIndex.set(entry.playlist_index, entry);
  }
  result.playback_results = Array.from(byIndex.values()).sort(
    (left, right) => left.playlist_index - right.playlist_index,
  );
  return result;
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

function createUaPlayerSessionBridge({ tempRoot } = {}) {
  if (typeof tempRoot !== "string" || !path.isAbsolute(tempRoot)) {
    throw new Error("UA Player session temp root must be absolute");
  }
  const active = new Set();

  function cleanupState(state) {
    if (state.cleaned) return;
    state.cleaned = true;
    active.delete(state);
    fs.rmSync(state.directory, { recursive: true, force: true });
  }

  function prepareLaunch({ sessionId, payload, positionalUrl, owner } = {}) {
    if (payload === undefined || payload === null) {
      return {
        args: positionalUrl ? [positionalUrl] : [],
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
      throw new Error("UA Player session exceeds 4 MiB");
    }

    fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
    const directory = fs.mkdtempSync(path.join(tempRoot, "lampaua-player-"));
    fs.chmodSync(directory, 0o700);
    const state = {
      cleaned: false,
      directory,
      finished: false,
      itemCount: normalized.items.length,
      owner,
    };
    active.add(state);

    try {
      const sessionPath = path.join(directory, "session.json");
      const resultPath = path.join(directory, "result.json");
      writeAtomicFile(sessionPath, bytes);
      return {
        args: ["--session-json", sessionPath, "--result-file", resultPath],
        cleanup() {
          cleanupState(state);
        },
        finish() {
          if (state.finished) return null;
          state.finished = true;
          try {
            const rawResult = readBoundedJson(resultPath);
            return rawResult
              ? normalizeResult(rawResult, state.itemCount)
              : null;
          } catch {
            return null;
          } finally {
            cleanupState(state);
          }
        },
        sessionId,
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
  cleanupAll: () => getDefaultBridge().cleanupAll(),
  cleanupOwner: (owner) => getDefaultBridge().cleanupOwner(owner),
  createUaPlayerSessionBridge,
  prepareLaunch: (options) => getDefaultBridge().prepareLaunch(options),
};
