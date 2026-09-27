(function () {
  "use strict";

  var icon_quit =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 4h3a2 2 0 0 1 2 2v1m-5 13h3a2 2 0 0 0 2-2v-1M4.425 19.428l6 1.8A2 2 0 0 0 13 19.312V4.688a2 2 0 0 0-2.575-1.916l-6 1.8A2 2 0 0 0 3 6.488v11.024a2 2 0 0 0 1.425 1.916M16.001 12h5m0 0l-2-2m2 2l-2 2"/></svg>';
  const DEFAULT_LAMPA_URL = "https://kinohub.uk/";
  const LEGACY_LAMPA_URL = "http://lampaua.mooo.com/";
  const LAMPA_URL_OPTIONS = {
    [DEFAULT_LAMPA_URL]: "https://kinohub.uk/",
    [LEGACY_LAMPA_URL]: "http://lampaua.mooo.com/",
  };
  const UA_PLAYER_SESSION_SCHEMA = "lampaua-player-session-v1";
  const UA_PLAYER_RESULT_SCHEMA = "lampaua-player-result-v1";
  const UA_PLAYER_MAX_ITEMS = 20_000;
  const UA_PLAYER_MAX_PENDING_SESSIONS = 32;
  const UA_PLAYER_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

  function ownValue(object, ...keys) {
    if (!object || typeof object !== "object" || Array.isArray(object)) {
      return undefined;
    }
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        return object[key];
      }
    }
    return undefined;
  }

  function textValue(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  function storageField(name) {
    try {
      if (typeof Lampa.Storage.field === "function") {
        return Lampa.Storage.field(name);
      }
      return Lampa.Storage.get(name);
    } catch {
      return undefined;
    }
  }

  function applyTrustedPlayerSelection(playerPath) {
    const selectedPath = textValue(playerPath);
    if (!selectedPath) return false;

    if (window.Lampa?.Storage?.set) {
      window.Lampa.Storage.set("player_nw_path", selectedPath);
      window.Lampa.Storage.set("player_torrent", "other");
    } else {
      window.localStorage.setItem("player_nw_path", selectedPath);
      window.localStorage.setItem("player_torrent", "other");
    }

    const pathField = $('div[data-name="player_nw_path"]');
    if (pathField.length) {
      if (window.Lampa?.Params?.update) {
        window.Lampa.Params.update(pathField);
      } else {
        pathField.find(".settings-param__value").text(selectedPath);
      }
    }

    return true;
  }

  function selectedPlayerIsUaPlayer() {
    const selectedPath = textValue(storageField("player_nw_path"));
    if (!selectedPath) return false;
    return (
      selectedPath.replace(/\//g, "\\").split("\\").at(-1).toLowerCase() ===
      "uaplayer.exe"
    );
  }

  function toLampaPlayUrl(value) {
    const url = textValue(value);
    if (!url) return undefined;
    try {
      const converted = Lampa.Torserver?.toPlayUrl?.(url);
      return (textValue(converted) || url).replace("&preload", "&play");
    } catch {
      return url.replace("&preload", "&play");
    }
  }

  function copyStringMap(value) {
    const result = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return result;
    }
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && key.trim()) result[key] = item;
    }
    return result;
  }

  function copyQualities(value) {
    const result = {};
    if (!value || typeof value !== "object") {
      return result;
    }
    const entries = Array.isArray(value)
      ? value.map((item) => [
          textValue(ownValue(item, "label", "name", "display_name", "id")),
          item,
        ])
      : Object.entries(value);
    for (const [label, item] of entries) {
      const rawUrl =
        typeof item === "string" ? item : ownValue(item, "url", "uri", "src");
      const url = toLampaPlayUrl(rawUrl);
      if (!label || !label.trim() || !url) continue;
      if (typeof item === "string") {
        result[label] = url;
        continue;
      }
      const quality = {
        url,
        headers: copyStringMap(ownValue(item, "headers")),
      };
      for (const [field, aliases] of [
        ["id", ["id"]],
        ["name", ["name", "label", "title"]],
        ["mime_type", ["mime_type", "mimeType", "content_type"]],
      ]) {
        const value = textValue(ownValue(item, ...aliases));
        if (value) quality[field] = value;
      }
      for (const field of ["width", "height", "bitrate"]) {
        const value = positiveIntegerValue(ownValue(item, field));
        if (value) quality[field] = value;
      }
      result[label] = quality;
    }
    return result;
  }

  function copySubtitles(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => {
        if (typeof item === "string") return { url: item };
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return null;
        }
        const url = textValue(ownValue(item, "url", "uri", "src", "file"));
        const path = textValue(ownValue(item, "path", "local_path"));
        if (!url && !path) return null;
        const subtitle = { headers: copyStringMap(ownValue(item, "headers")) };
        if (url) subtitle.url = url;
        if (!url && path) subtitle.path = path;
        const label = textValue(ownValue(item, "label", "title", "name"));
        const language = textValue(ownValue(item, "language", "lang"));
        if (label) subtitle.label = label;
        if (language) subtitle.language = language;
        for (const [field, aliases] of [
          ["id", ["id"]],
          ["format", ["format", "extension"]],
        ]) {
          const value = textValue(ownValue(item, ...aliases));
          if (value) subtitle[field] = value;
        }
        if (ownValue(item, "default", "is_default", "enabled") === true)
          subtitle.default = true;
        if (ownValue(item, "forced", "is_forced") === true)
          subtitle.forced = true;
        return subtitle;
      })
      .filter(Boolean);
  }

  function copySegment(segment) {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
      return null;
    }
    const result = {};
    for (const field of ["start", "end", "start_ms", "end_ms"]) {
      const value = ownValue(segment, field);
      if (Number.isFinite(value)) result[field] = value;
    }
    for (const field of ["id", "kind", "type", "source", "label", "mode"]) {
      const value = textValue(ownValue(segment, field));
      if (value) result[field] = value;
    }
    if (ownValue(segment, "whole_content_ad") === true) {
      result.whole_content_ad = true;
    }
    return Object.keys(result).length ? result : null;
  }

  function copySegments(value) {
    if (Array.isArray(value)) return value.map(copySegment).filter(Boolean);
    if (!value || typeof value !== "object") return [];
    const result = {};
    for (const [kind, items] of Object.entries(value)) {
      if (!Array.isArray(items)) continue;
      result[kind] = items.map(copySegment).filter(Boolean);
    }
    return result;
  }

  function firstCopiedValue(sources, keys, copy, hasValue) {
    for (const source of sources) {
      for (const key of keys) {
        const copied = copy(ownValue(source, key));
        if (hasValue(copied)) return copied;
      }
    }
    return copy(undefined);
  }

  function hasCopiedSegments(value) {
    if (Array.isArray(value)) return value.length > 0;
    if (!value || typeof value !== "object") return false;
    return Object.values(value).some(
      (items) => Array.isArray(items) && items.length > 0,
    );
  }

  function appendPlaybackSource(target, value) {
    if (Array.isArray(value)) {
      const first = value.find(
        (item) => item && typeof item === "object" && !Array.isArray(item),
      );
      if (first) target.push(first);
      return;
    }
    if (value && typeof value === "object") target.push(value);
  }

  function itemPlaybackSources(primary, fallback) {
    const result = [];
    for (const source of [primary, fallback]) {
      appendPlaybackSource(result, source);
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        continue;
      }
      for (const key of [
        "stream",
        "source",
        "video",
        "media",
        "data",
        "result",
      ]) {
        appendPlaybackSource(result, ownValue(source, key));
      }
    }
    return result;
  }

  function itemSources(primary, fallback) {
    return [
      ...itemPlaybackSources(primary, fallback),
      primary?.card,
      fallback?.card,
      primary?.movie,
      fallback?.movie,
    ].filter((value) => value && typeof value === "object");
  }

  function itemMetadataSources(primary, fallback) {
    return [
      primary?.card,
      fallback?.card,
      primary?.movie,
      fallback?.movie,
    ].filter((value) => value && typeof value === "object");
  }

  function positiveIntegerValue(value) {
    if (Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value !== "string" || !/^\d{1,15}$/.test(value.trim())) {
      return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }

  function firstItemValue(sources, ...keys) {
    for (const source of sources) {
      const value = ownValue(source, ...keys);
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  }

  function buildUaPlayerItem(primary, fallback, positionMs, fullPlaybackData) {
    const sources = itemSources(primary, fallback);
    const metadataSources = itemMetadataSources(primary, fallback);
    const streamSources = itemPlaybackSources(
      primary,
      fullPlaybackData ? fallback : null,
    );
    const item = {};
    const url = toLampaPlayUrl(
      firstItemValue(streamSources, "url", "media_url", "stream_url"),
    );
    const resolverUrl = textValue(
      firstItemValue(streamSources, "resolver_url", "resolver", "call_url"),
    );
    const thumbnail = textValue(
      firstItemValue(sources, "thumbnail", "poster", "image", "logo"),
    );
    if (url) item.url = url;
    if (resolverUrl) item.resolver_url = resolverUrl;
    if (thumbnail) item.thumbnail = thumbnail;

    const textFields = [
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
      [
        "original_title",
        ["original_title", "originalTitle", "original_name", "originalName"],
      ],
    ];
    for (const [outputName, inputNames] of textFields) {
      const value = textValue(firstItemValue(sources, ...inputNames));
      if (value) item[outputName] = value;
    }

    const integerFields = [
      ["tmdb_id", ["tmdb_id", "tmdbId"]],
      ["kp_id", ["kp_id", "kinopoisk_id", "kinopoiskId"]],
      ["mal_id", ["mal_id", "malId"]],
      ["year", ["year", "release_year"]],
      ["season", ["season", "season_number", "seasonNumber"]],
      ["episode", ["episode", "episode_number", "episodeNumber"]],
    ];
    for (const [outputName, inputNames] of integerFields) {
      const value = firstItemValue(sources, ...inputNames);
      if (Number.isSafeInteger(value) && value > 0) item[outputName] = value;
    }
    if (!item.tmdb_id) {
      const metadataId = positiveIntegerValue(
        firstItemValue(metadataSources, "tmdb_id", "tmdbId", "id"),
      );
      if (metadataId) item.tmdb_id = metadataId;
    }
    if (!item.year) {
      const releaseDate = textValue(
        firstItemValue(
          metadataSources,
          "first_air_date",
          "release_date",
          "firstAirDate",
          "releaseDate",
        ),
      );
      const releaseYear = releaseDate?.match(/^(\d{4})(?:-|$)/)?.[1];
      const parsedYear = positiveIntegerValue(releaseYear);
      if (parsedYear) item.year = parsedYear;
    }
    if (firstItemValue(sources, "is_anime", "anime") === true) {
      item.is_anime = true;
    }
    if (sources.some(isLiveSource)) item.is_live = true;
    if (Number.isSafeInteger(positionMs) && positionMs >= 0) {
      item.position_ms = positionMs;
    }

    item.headers = copyStringMap(firstItemValue(sources, "headers"));
    item.resolver_headers = copyStringMap(
      firstItemValue(sources, "resolver_headers"),
    );
    const playbackSources = itemPlaybackSources(
      primary,
      fullPlaybackData ? fallback : null,
    );
    item.quality = firstCopiedValue(
      playbackSources,
      ["quality", "qualities"],
      copyQualities,
      (value) => Object.keys(value).length > 0,
    );
    item.subtitles = firstCopiedValue(
      playbackSources,
      ["subtitles"],
      copySubtitles,
      (value) => value.length > 0,
    );
    item.segments = firstCopiedValue(
      playbackSources,
      ["segments", "_session_segments"],
      copySegments,
      hasCopiedSegments,
    );
    return item;
  }

  function currentTimelinePositionMs(data) {
    let seconds = ownValue(data?.timeline, "time");
    try {
      const hash = ownValue(data?.timeline, "hash");
      const current = hash && Lampa.Timeline?.view?.(hash);
      if (Number.isFinite(current?.time)) seconds = current.time;
    } catch {
      // A provider without Timeline.view still has its original resume time.
    }
    return Number.isFinite(seconds) && seconds > 0
      ? Math.round(seconds * 1000)
      : 0;
  }

  function timelineHandler(data) {
    return typeof data?.timeline?.handler === "function"
      ? data.timeline.handler
      : null;
  }

  function isLiveSource(data) {
    return ["is_live", "is_iptv", "iptv", "iptv_player", "tv"].some(
      (key) => ownValue(data, key) === true,
    );
  }

  function buildUaPlayerSession(data, originalUrl) {
    if (!data || typeof data !== "object") return null;
    const rawPlaylist = Array.isArray(data.playlist) ? data.playlist : [];
    const currentPositionMs = currentTimelinePositionMs(data);
    const originalCurrentUrl = toLampaPlayUrl(originalUrl || data.url);
    const selectedData = Object.assign({}, data);
    const currentItem = buildUaPlayerItem(
      selectedData,
      null,
      currentPositionMs,
      true,
    );
    if (!currentItem.url && !currentItem.resolver_url) return null;

    const playlistEntries = rawPlaylist
      .map((entry, rawIndex) => ({
        item: buildUaPlayerItem(entry, data, 0, false),
        raw: entry,
        rawIndex,
        timelineHandler: timelineHandler(entry),
      }))
      .filter((entry) => entry.item.url || entry.item.resolver_url);
    let rawPlaylistIndex = ownValue(
      data,
      "playlist_index",
      "current_index",
      "index",
    );
    if (
      !Number.isSafeInteger(rawPlaylistIndex) ||
      rawPlaylistIndex < 0 ||
      rawPlaylistIndex >= rawPlaylist.length
    ) {
      rawPlaylistIndex = -1;
    }
    let playlistIndex = playlistEntries.findIndex(
      (entry) => entry.rawIndex === rawPlaylistIndex,
    );
    if (playlistIndex < 0) {
      playlistIndex = playlistEntries.findIndex(
        (entry) =>
          entry.item.url &&
          (entry.item.url === currentItem.url ||
            entry.item.url === originalCurrentUrl),
      );
    }
    let sessionEntries = playlistEntries;

    if (playlistIndex >= 0 && playlistIndex < sessionEntries.length) {
      const selectedSource = Object.assign(
        {},
        playlistEntries[playlistIndex].raw || {},
        selectedData,
      );
      selectedSource.url = selectedData.url || selectedSource.url;
      sessionEntries[playlistIndex] = {
        ...sessionEntries[playlistIndex],
        item: buildUaPlayerItem(selectedSource, data, currentPositionMs, true),
        timelineHandler:
          timelineHandler(data) ||
          sessionEntries[playlistIndex].timelineHandler,
      };
    } else {
      sessionEntries.unshift({
        item: currentItem,
        raw: data,
        rawIndex: -1,
        timelineHandler: timelineHandler(data),
      });
      playlistIndex = 0;
    }

    if (!sessionEntries.length) return null;
    playlistIndex = Math.max(
      0,
      Math.min(playlistIndex, sessionEntries.length - 1),
    );
    if (sessionEntries.length > UA_PLAYER_MAX_ITEMS) {
      const start = Math.max(
        0,
        Math.min(
          playlistIndex - Math.floor(UA_PLAYER_MAX_ITEMS / 2),
          sessionEntries.length - UA_PLAYER_MAX_ITEMS,
        ),
      );
      sessionEntries = sessionEntries.slice(start, start + UA_PLAYER_MAX_ITEMS);
      playlistIndex -= start;
    }
    const items = sessionEntries.map((entry) => entry.item);
    const payload = {
      schema: UA_PLAYER_SESSION_SCHEMA,
      playlist_index: playlistIndex,
      auto_next: ownValue(data, "auto_next") !== false,
      items,
    };
    const title = textValue(
      ownValue(data, "playlist_title", "playlist_name", "title"),
    );
    if (title) payload.title = title;
    return {
      payload,
      timelineHandlers: sessionEntries.map((entry) => entry.timelineHandler),
    };
  }

  function createUaPlayerSessionId(playerApi) {
    try {
      const value = playerApi.createUaPlayerSessionId?.();
      if (typeof value === "string" && value) return value;
    } catch {
      // Fall through to a renderer-local collision-resistant id.
    }
    if (typeof window.crypto?.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `ua-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function initUaPlayerSessionIntegration() {
    if (window.uaPlayerSessionIntegrationReady) return;
    const playerApi = window.electronAPI?.player;
    if (
      !playerApi ||
      typeof playerApi.setUaPlayerSessionProvider !== "function" ||
      typeof playerApi.onUaPlayerResult !== "function" ||
      !Lampa.Player?.listener
    ) {
      return;
    }
    window.uaPlayerSessionIntegrationReady = true;
    const pendingSessions = new Map();
    const launchRecords = [];
    const pendingLaunches = new WeakMap();
    let collectingLaunch = null;

    function newLaunchRecord(data) {
      let card = data.card || data.movie;
      if (!card && !isLiveSource(data)) {
        const activity = Lampa.Activity?.active?.();
        card = activity?.card || activity?.movie;
      }
      return {
        data,
        card,
        originalUrl: data.url,
        expiresAt: Date.now() + 30_000,
      };
    }

    function collectSynchronousMetadata(record) {
      collectingLaunch = record;
      queueMicrotask(() => {
        if (collectingLaunch === record) collectingLaunch = null;
      });
    }

    function forgetSession(sessionId) {
      const pending = pendingSessions.get(sessionId);
      if (!pending) return null;
      pendingSessions.delete(sessionId);
      if (pending.timeout) clearTimeout(pending.timeout);
      return pending;
    }

    function rememberSession(sessionId, timelineHandlers) {
      while (pendingSessions.size >= UA_PLAYER_MAX_PENDING_SESSIONS) {
        const oldest = pendingSessions.keys().next().value;
        forgetSession(oldest);
      }
      const timeout = setTimeout(
        () => forgetSession(sessionId),
        UA_PLAYER_PENDING_TTL_MS,
      );
      pendingSessions.set(sessionId, {
        timelineHandlers,
        timeout,
        sequence: 0,
        rowSequences: new Map(),
      });
    }

    function applyTimelineResult(handler, result, allowZero = false) {
      if (typeof handler !== "function" || !result) return false;
      const position = Number.isFinite(result.position)
        ? Math.max(0, result.position)
        : 0;
      const duration = Number.isFinite(result.duration)
        ? Math.max(0, result.duration)
        : 0;
      const boundedPosition = duration > 0 ? Math.min(position, duration) : 0;
      if (duration <= 0 || (!allowZero && boundedPosition <= 0)) return false;
      const percent = Math.max(
        0,
        Math.min(100, (boundedPosition / duration) * 100),
      );
      try {
        handler(percent, boundedPosition / 1000, duration / 1000);
        return true;
      } catch (error) {
        console.error("UA Player: не вдалося зберегти timeline", error);
        return false;
      }
    }

    Lampa.Player.listener.follow("create", (event) => {
      collectingLaunch = null;
      if (
        selectedPlayerIsUaPlayer() &&
        event?.data &&
        typeof event.data === "object"
      ) {
        const record = newLaunchRecord(event.data);
        pendingLaunches.set(event.data, record);
        collectSynchronousMetadata(record);
      }
    });

    Lampa.Player.listener.follow("external", (data) => {
      collectingLaunch = null;
      if (!selectedPlayerIsUaPlayer() || !data || typeof data !== "object")
        return;
      const record = pendingLaunches.get(data) || newLaunchRecord(data);
      pendingLaunches.delete(data);
      record.expiresAt = Date.now() + 30_000;
      launchRecords.push(record);
      while (launchRecords.length > UA_PLAYER_MAX_PENDING_SESSIONS)
        launchRecords.shift();
      collectSynchronousMetadata(record);
      setTimeout(() => {
        const index = launchRecords.indexOf(record);
        if (index >= 0) launchRecords.splice(index, 1);
      }, 0);
    });

    // Preserve the native calls and their return values. Only calls in this
    // launch turn can be correlated; an untagged later response might belong
    // to a previous film and must not be attached to a new session.
    for (const method of ["playlist", "subtitles"]) {
      const original = Lampa.Player[method];
      if (typeof original !== "function") continue;
      Lampa.Player[method] = function (value) {
        if (collectingLaunch && Array.isArray(value))
          collectingLaunch[method] = value;
        return original.apply(this, arguments);
      };
    }

    playerApi.setUaPlayerSessionProvider((args) => {
      if (
        !Array.isArray(args) ||
        args.length !== 1 ||
        typeof args[0] !== "string"
      )
        return null;
      const index = launchRecords.findIndex((record) => {
        const url = toLampaPlayUrl(record.data.url);
        return (
          record.expiresAt >= Date.now() &&
          url &&
          (args[0] === url || args[0] === encodeURI(url))
        );
      });
      if (index < 0) return null;
      const record = launchRecords.splice(index, 1)[0];
      const data = {
        ...record.data,
        card: record.data.card || record.data.movie || record.card,
      };
      for (const method of ["playlist", "subtitles"]) {
        if (record[method]) data[method] = record[method];
      }
      const session = buildUaPlayerSession(data, record.originalUrl);
      if (!session) return null;
      const { payload, timelineHandlers } = session;
      const sessionId = createUaPlayerSessionId(playerApi);
      const positionalUrl = payload.items[payload.playlist_index]?.url;
      rememberSession(sessionId, timelineHandlers);
      return { sessionId, payload, positionalUrl };
    });

    playerApi.onUaPlayerProgress?.((message) => {
      const pending = pendingSessions.get(message?.sessionId);
      if (
        !pending ||
        !Number.isSafeInteger(message.sequence) ||
        message.sequence <= pending.sequence ||
        !Array.isArray(message.playback_results)
      )
        return;
      pending.sequence = message.sequence;
      for (const row of message.playback_results) {
        const index = row?.playlist_index;
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= pending.timelineHandlers.length ||
          !Number.isSafeInteger(row.sequence) ||
          row.sequence <= (pending.rowSequences.get(index) || 0) ||
          row.sequence > message.sequence ||
          !Number.isSafeInteger(row.position) ||
          row.position < 0 ||
          !Number.isSafeInteger(row.duration) ||
          row.duration <= 0 ||
          row.position > row.duration
        )
          continue;
        if (applyTimelineResult(pending.timelineHandlers[index], row, true))
          pending.rowSequences.set(index, row.sequence);
      }
    });

    playerApi.onUaPlayerResult((message) => {
      if (!message || typeof message !== "object") return;
      const sessionId = message.sessionId;
      const result = message.result;
      if (
        typeof sessionId !== "string" ||
        !result ||
        result.schema !== UA_PLAYER_RESULT_SCHEMA ||
        !pendingSessions.has(sessionId)
      ) {
        return;
      }

      const pending = forgetSession(sessionId);
      const appliedIndexes = new Set();
      for (const entry of Array.isArray(result.playback_results)
        ? result.playback_results
        : []) {
        const index = entry?.playlist_index;
        if (!Number.isSafeInteger(index) || index < 0) continue;
        if (applyTimelineResult(pending?.timelineHandlers?.[index], entry)) {
          appliedIndexes.add(index);
        }
      }
      if (!appliedIndexes.has(result.playlist_index)) {
        applyTimelineResult(
          pending?.timelineHandlers?.[result.playlist_index],
          result,
        );
      }
      Lampa.Player.listener.send("ua_player_result", result);
    });
  }

  function addQuitButton() {
    const container = Lampa.Head.render().find(".head__actions");

    // Добавляем кнопку выхода
    const icon = $(`<div class="head__action selector">${icon_quit}</div>`);
    container.append(icon);
    icon.on("hover:enter", () => {
      window.electronAPI.closeApp();
    });
  }

  var settings_app_icon =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M7.5 13.75v.5q0 .325.213.538T8.25 15t.538-.213T9 14.25v-2.5q0-.325-.213-.537T8.25 11t-.537.213t-.213.537v.5h-.75q-.325 0-.537.213T6 13t.213.538t.537.212zm3.25 0h6.5q.325 0 .538-.213T18 13t-.213-.537t-.537-.213h-6.5q-.325 0-.537.213T10 13t.213.538t.537.212m5.75-4h.75q.325 0 .538-.213T18 9t-.213-.537t-.537-.213h-.75v-.5q0-.325-.213-.537T15.75 7t-.537.213T15 7.75v2.5q0 .325.213.538t.537.212t.538-.213t.212-.537zm-9.75 0h6.5q.325 0 .538-.213T14 9t-.213-.537t-.537-.213h-6.5q-.325 0-.537.213T6 9t.213.538t.537.212M4 19q-.825 0-1.412-.587T2 17V5q0-.825.588-1.412T4 3h16q.825 0 1.413.588T22 5v12q0 .825-.587 1.413T20 19h-4v1q0 .425-.288.713T15 21H9q-.425 0-.712-.288T8 20v-1zm0-2h16V5H4zm0 0V5z"/></svg>';

  class SettingsManager {
    constructor(componentName) {
      this.queue = [];
      this.componentName = componentName;
    }

    addToQueue(paramConfig) {
      this.queue.push({
        ...paramConfig,
        order: paramConfig.order || this.queue.length + 1,
      });
      return this;
    }

    async loadAsyncSetting(key, paramConfig) {
      try {
        const value = await window.electronAPI.store.get(key);
        localStorage.setItem(`${this.componentName}_${key}`, value);

        this.addToQueue({
          ...paramConfig,
          param: {
            ...paramConfig.param,
            default: value,
          },
        });
      } catch (error) {
        console.error(`APP Failed to load ${key}:`, error);
      }
    }

    apply() {
      this.queue.sort((a, b) => (a.order || 999) - (b.order || 999));

      this.queue.forEach((item) => {
        Lampa.SettingsApi.addParam({
          component: this.componentName,
          param: item.param,
          field: item.field,
          onChange: item.onChange,
        });
      });

      this.queue = [];
    }
  }

  function forceUkrainianTranslations(translations) {
    Object.values(translations).forEach((translation) => {
      if (translation && typeof translation === "object" && translation.uk) {
        translation.ru = translation.uk;
      }
    });
  }

  function normalizeKeyboardType(value, fallback) {
    return value === "integrate" || value === "lampa" ? value : fallback;
  }

  function addAppSettings() {
    const translations = {
      // Основные настройки
      app_settings: {
        ru: "Приложение",
        en: "App",
        uk: "Додаток",
      },
      // Настройки полноэкранного режима
      app_settings_fullscreen_mode_name: {
        ru: "Режим полного экрана",
        en: "Fullscreen mode",
        uk: "Режим повного екрану",
      },
      app_settings_fullscreen_mode_description: {
        ru: "Выберите как будет запускаться приложение",
        en: "Choose how the application will start",
        uk: "Виберіть як буде запускатися додаток",
      },
      fullscreen_mode_always: {
        ru: "Всегда полноэкранный",
        en: "Always fullscreen",
        uk: "Завжди повноекранний",
      },
      fullscreen_mode_never: {
        ru: "Не запускать в полном экране",
        en: "Never start fullscreen",
        uk: "Не запускати в повному екрані",
      },
      fullscreen_mode_last: {
        ru: "Последнее состояние",
        en: "Last state",
        uk: "Останній стан",
      },
      app_settings_autoupdate_field_name: {
        ru: "Автоматическое обновление",
        en: "Automatic update",
        uk: "Автоматичне оновлення",
      },
      app_settings_lampa_url_placeholder: {
        ru: "Введите адрес LampaUa, начиная с http...",
        en: "Enter LampaUa URL starting with http...",
        uk: "Введіть адресу LampaUa, починаючи з http...",
      },
      app_settings_lampa_url_name: {
        ru: "Адрес LampaUa",
        en: "LampaUa URL",
        uk: "Адреса LampaUa",
      },
      app_settings_lampa_url_description: {
        ru: "По умолчанию: https://kinohub.uk/",
        en: "Default: https://kinohub.uk/",
        uk: "За замовчуванням: https://kinohub.uk/",
      },
      app_settings_lampa_url_ok: {
        ru: "Сохранено, ожидайте перехода...",
        en: "Saved, waiting for redirect...",
        uk: "Збережено, очікуйте переходу...",
      },
      app_settings_lampa_url_error: {
        ru: "Невірний URL",
        en: "Invalid URL",
        uk: "Невірний URL",
      },
      app_settings_about_field_name: {
        ru: "О приложении",
        en: "About the app",
        uk: "Про додаток",
      },
      app_settings_about_field_description: {
        ru: "Узнать версию и др. информацию о приложении",
        en: "Check version and other app information",
        uk: "Дізнатися версію та іншу інформацію про додаток",
      },

      // TorrServer
      app_settings_ts_field_name: {
        ru: "TorrServer",
        en: "TorrServer",
        uk: "TorrServer",
      },
      app_settings_ts_field_description: {
        ru: "Управление TorrServer",
        en: "Control TorrServer",
        uk: "Керування TorrServer",
      },
      app_settings_ts_autostart_field_name: {
        ru: "Автозапуск при старте Lampa",
        en: "Autostart on Lampa launch",
        uk: "Автозапуск під час старту Lampa",
      },
      app_settings_ts_port_name: {
        ru: "Порт на котором запускать TS",
        en: "Port to run TS on",
        uk: "Порт на якому запускати TS",
      },
      app_settings_ts_port_description: {
        ru: "Если не знаете зачем это, оставьте 8090",
        en: "If you don't know why you need this, leave 8090",
        uk: "Якщо не знаєте навіщо це, залиште 8090",
      },
      app_settings_ts_port_ok: {
        ru: "Успешно изменено, перезапустите TorrServer",
        en: "Successfully changed, restart TorrServer",
        uk: "Успішно змінено, перезапустіть TorrServer",
      },
      app_settings_ts_status_name: {
        ru: "Статус",
        en: "Status",
        uk: "Статус",
      },
      app_settings_ts_version_name: {
        ru: "Версия",
        en: "Version",
        uk: "Версія",
      },
      app_settings_ts_status_installed_running: {
        ru: "✅ Запущен",
        en: "✅ Running",
        uk: "✅ Запущено",
      },
      app_settings_ts_status_installed_stopped: {
        ru: "❌ Остановлен",
        en: "❌ Stopped",
        uk: "❌ Зупинено",
      },
      app_settings_ts_status_not_installed: {
        ru: "🚫 Не установлен",
        en: "🚫 Not installed",
        uk: "🚫 Не встановлено",
      },
      app_settings_ts_status_install_prompt: {
        ru: "Установите TorrServer, нажав кнопку запуска",
        en: "Install TorrServer by clicking the start button",
        uk: "Встановіть TorrServer, натиснувши кнопку запуску",
      },

      // Кнопки управления TorrServer
      app_settings_ts_start_name: {
        ru: "▶️ Запуск TorrServer",
        en: "▶️ Start TorrServer",
        uk: "▶️ Запуск TorrServer",
      },
      app_settings_ts_stop_name: {
        ru: "🛑 Остановка TorrServer",
        en: "🛑 Stop TorrServer",
        uk: "🛑 Зупинка TorrServer",
      },
      app_settings_ts_restart_name: {
        ru: "🔁 Перезапуск TorrServer",
        en: "🔁 Restart TorrServer",
        uk: "🔁 Перезапуск TorrServer",
      },
      app_settings_ts_check_update_name: {
        ru: "🔍 Проверка обновлений TorrServer",
        en: "🔍 Check TorrServer updates",
        uk: "🔍 Перевірка оновлень TorrServer",
      },
      app_settings_ts_open_path_name: {
        ru: "📂 Открыть папку TorrServer",
        en: "📂 Open TorrServer folder",
        uk: "📂 Відкрити папку TorrServer",
      },
      app_settings_ts_open_web_name: {
        ru: "🌐 Открыть веб TorrServer",
        en: "🌐 Open TorrServer web",
        uk: "🌐 Відкрити веб TorrServer",
      },
      app_settings_ts_uninstall_name: {
        ru: "🗑️ Удалить TorrServer (полностью)",
        en: "🗑️ Uninstall TorrServer (completely)",
        uk: "🗑️ Видалити TorrServer (повністю)",
      },
      app_settings_ts_uninstall_keep_data_name: {
        ru: "💾 Удалить TorrServer (сохранить данные)",
        en: "💾 Uninstall TorrServer (keep data)",
        uk: "💾 Видалити TorrServer (зберегти дані)",
      },
      app_settings_ts_reinstall_name: {
        ru: "🔄 Переустановить TorrServer",
        en: "🔄 Reinstall TorrServer",
        uk: "🔄 Перевстановити TorrServer",
      },
      app_settings_ts_reinstall_loading: {
        ru: "Переустановка TorrServer...",
        en: "Reinstalling TorrServer...",
        uk: "Перевстановлення TorrServer...",
      },

      // Статусы загрузки TorrServer
      app_settings_ts_start_loading: {
        ru: "Выполняется запуск TorrServer",
        en: "Starting TorrServer",
        uk: "Виконується запуск TorrServer",
      },
      app_settings_ts_download_loading: {
        ru: "Выполняется скачивание и запуск TorrServer",
        en: "Downloading and starting TorrServer",
        uk: "Виконується завантаження та запуск TorrServer",
      },
      app_settings_ts_stop_loading: {
        ru: "Остановка TorrServer",
        en: "Stopping TorrServer",
        uk: "Зупинка TorrServer",
      },
      app_settings_ts_restart_loading: {
        ru: "Перезапуск TorrServer",
        en: "Restarting TorrServer",
        uk: "Перезапуск TorrServer",
      },
      app_settings_ts_check_update_loading: {
        ru: "Проверка обновлений TorrServer",
        en: "Checking TorrServer updates",
        uk: "Перевірка оновлень TorrServer",
      },
      app_settings_ts_update_loading: {
        ru: "Обновление TorrServer",
        en: "Updating TorrServer",
        uk: "Оновлення TorrServer",
      },
      app_settings_ts_uninstall_loading: {
        ru: "Выполняется ПОЛНОЕ удаление TorrServer...",
        en: "Performing COMPLETE uninstall of TorrServer...",
        uk: "Виконується ПОВНЕ видалення TorrServer...",
      },
      app_settings_ts_uninstall_keep_data_loading: {
        ru: "Выполняется удаление TorrServer...",
        en: "Uninstalling TorrServer...",
        uk: "Виконується видалення TorrServer...",
      },
      app_settings_ts_install_prompt: {
        ru: "Сначала установите TorrServer, нажав на запуск",
        en: "First install TorrServer by clicking start",
        uk: "Спочатку встановіть TorrServer, натиснувши на запуск",
      },

      // Обновления TorrServer
      app_settings_ts_update_found_title: {
        ru: "Найдено обновление TorrServer",
        en: "TorrServer update found",
        uk: "Знайдено оновлення TorrServer",
      },
      app_settings_ts_update_found_message: {
        ru: "Найдено обновление TorrServer.",
        en: "TorrServer update found.",
        uk: "Знайдено оновлення TorrServer.",
      },
      app_settings_ts_update_installed: {
        ru: "Установлена: {current_version}",
        en: "Installed: {current_version}",
        uk: "Встановлена: {current_version}",
      },
      app_settings_ts_update_latest: {
        ru: "Последняя версия: {latest_version}",
        en: "Latest version: {latest_version}",
        uk: "Остання версія: {latest_version}",
      },
      app_settings_ts_update_button: {
        ru: "Обновить",
        en: "Update",
        uk: "Оновити",
      },
      app_settings_ts_update_success: {
        ru: "Успешно обновлено",
        en: "Successfully updated",
        uk: "Успішно оновлено",
      },
      app_settings_ts_update_no_updates: {
        ru: "Обновлений нет, у вас последняя версия",
        en: "No updates, you have the latest version",
        uk: "Оновлень немає, у вас остання версія",
      },

      // Настройки GStreamer
      app_settings_ts_gst_field_name: {
        ru: "Поддержка транскодирования (GStreamer)",
        en: "Transcoding support (GStreamer)",
        uk: "Підтримка транскодування (GStreamer)",
      },
      app_settings_ts_gst_field_description: {
        ru: "Включите для поддержки транскодирования. Требуется переустановка TorrServer.",
        en: "Enable for transcoding support. Requires TorrServer reinstall.",
        uk: "Увімкніть для підтримки транскодування. Потребує перевстановлення TorrServer.",
      },
      app_settings_ts_gst_changed_notify: {
        ru: "Настройка GStreamer изменена. Требуется переустановка TorrServer.",
        en: "GStreamer setting changed. TorrServer reinstall required.",
        uk: "Налаштування GStreamer змінено. Потрібне перевстановлення TorrServer.",
      },
      app_settings_ts_gst_enabled: {
        ru: "✅ Поддержка GStreamer включена",
        en: "✅ GStreamer support enabled",
        uk: "✅ Підтримка GStreamer увімкнена",
      },
      app_settings_ts_gst_disabled: {
        ru: "❌ Поддержка GStreamer отключена",
        en: "❌ GStreamer support disabled",
        uk: "❌ Підтримка GStreamer вимкнена",
      },
      app_settings_ts_gst_unknown: {
        ru: "❓ Неизвестно (сервер не запущен)",
        en: "❓ Unknown (server not running)",
        uk: "❓ Невідомо (сервер не запущено)",
      },
      app_settings_ts_gst_status_name: {
        ru: "Статус GStreamer",
        en: "GStreamer status",
        uk: "Статус GStreamer",
      },
      app_settings_ts_gst_version_name: {
        ru: "Версия GStreamer",
        en: "GStreamer version",
        uk: "Версія GStreamer",
      },
      app_settings_ts_version_with_gst: {
        ru: "{version} (с GStreamer)",
        en: "{version} (with GStreamer)",
        uk: "{version} (з GStreamer)",
      },
      app_settings_ts_version_without_gst: {
        ru: "{version} (без GStreamer)",
        en: "{version} (without GStreamer)",
        uk: "{version} (без GStreamer)",
      },

      app_settings_web_security_field_name: {
        ru: "Проверка CORS",
        en: "CORS check",
        uk: "Перевірка CORS",
      },
      app_settings_web_security_field_description: {
        ru: "Если балансировщики не работают, укажите «Нет» — CORS отключится, но вы действуете на свой риск.",
        en: "If load balancers do not work, set 'No' — CORS will be disabled, but you do so at your own risk.",
        uk: "Якщо балансувальники не працюють, вкажіть «Ні» — CORS вимкнеться, але ви дієте на свій ризик.",
      },
      app_settings_web_security_notify: {
        ru: "Перезапустите приложение, для применения настройки!",
        en: "Restart the application to apply the setting!",
        uk: "Перезапустіть застосунок, щоб застосувати налаштування!",
      },

      // Импорт/Экспорт
      app_settings_ie_field_name: {
        ru: "Резервна копія / перенесення",
        en: "Export/Import settings",
        uk: "Резервна копія / перенесення",
      },
      app_settings_ie_field_description: {
        ru: "Збереження налаштувань або перенесення на інший пристрій",
        en: "Backup data or transfer from another application",
        uk: "Збереження налаштувань або перенесення на інший пристрій",
      },
      app_settings_ie_btn_export_title: {
        ru: "Експорт",
        en: "Export",
        uk: "Експорт",
      },
      app_settings_ie_btn_export_cloud_title: {
        ru: "Створити ID і PIN",
        en: "Create ID and PIN",
        uk: "Створити ID і PIN",
      },
      app_settings_ie_btn_import_cloud_title: {
        ru: "Ввести ID і PIN",
        en: "Enter ID and PIN",
        uk: "Ввести ID і PIN",
      },
      app_settings_ie_btn_export_file_title: {
        ru: "Зберегти файл",
        en: "Save file",
        uk: "Зберегти файл",
      },
      app_settings_ie_btn_import_file_title: {
        ru: "Відновити з файлу",
        en: "Restore from file",
        uk: "Відновити з файлу",
      },
      app_settings_ie_btn_export_subtitle: {
        ru: "Створити файл резервної копії на цьому комп'ютері",
        en: "Save settings to file",
        uk: "Створити файл резервної копії на цьому комп'ютері",
      },
      app_settings_ie_btn_export_cloud_subtitle: {
        ru: "Покаже ID експорту та PIN. Їх треба ввести на іншому пристрої протягом 1 години.",
        en: "Save settings to the cloud. Your data will be encrypted before sending using a PIN code and stored for 1 hour.",
        uk: "Покаже ID експорту та PIN. Їх треба ввести на іншому пристрої протягом 1 години.",
      },
      app_settings_ie_btn_import_title: {
        ru: "Імпорт",
        en: "Import",
        uk: "Імпорт",
      },
      app_settings_ie_btn_import_subtitle: {
        ru: "Вибрати файл резервної копії з комп'ютера",
        en: "Import settings from file",
        uk: "Вибрати файл резервної копії з комп'ютера",
      },
      app_settings_ie_btn_import_cloud_subtitle: {
        ru: "Ввести ID експорту та PIN, які були показані під час експорту.",
        en: "Import settings from cloud",
        uk: "Ввести ID експорту та PIN, які були показані під час експорту.",
      },
      app_settings_noty_waiting: {
        ru: "Зачекайте...",
        en: "Please wait...",
        uk: "Зачекайте...",
      },
      app_settings_ie_import_success: {
        ru: "Імпорт виконано успішно",
        en: "Import completed successfully",
        uk: "Імпорт виконано успішно",
      },
      app_settings_ie_import_error: {
        ru: "Помилка імпорту",
        en: "Import error",
        uk: "Помилка імпорту",
      },
      app_settings_ie_invalid_pin: {
        ru: "Невірний PIN-код",
        en: "Invalid PIN",
        uk: "Невірний PIN-код",
      },

      // Разделители
      app_settings_separator_main_name: {
        ru: "Основные",
        en: "Main",
        uk: "Основні",
      },
      app_settings_separator_other_name: {
        ru: "Остальные",
        en: "Other",
        uk: "Інші",
      },
      app_settings_ts_separator_main_title: {
        ru: "Управление",
        en: "Management",
        uk: "Керування",
      },
      app_settings_ts_separator_settings_title: {
        ru: "Настройки",
        en: "Settings",
        uk: "Налаштування",
      },
      app_settings_ts_separator_danger_title: {
        ru: "Осторожно!",
        en: "Caution!",
        uk: "Обережно!",
      },

      // Облачный импорт/экспорт
      app_settings_ie_separator_cloud_title: {
        ru: "Через ID і PIN",
        en: "Cloud",
        uk: "Через ID і PIN",
      },
      app_settings_ie_separator_local_title: {
        ru: "Через файл",
        en: "Local",
        uk: "Через файл",
      },
      app_settings_ie_modal_import_cloud: {
        ru: "Імпорт через ID і PIN",
        en: "Import settings from cloud",
        uk: "Імпорт через ID і PIN",
      },
      app_settings_ie_modal_enter_id: {
        ru: "Введіть ID експорту (10 цифр)",
        en: "Enter ID",
        uk: "Введіть ID експорту (10 цифр)",
      },
      app_settings_ie_modal_enter_pin_title: {
        ru: "Введіть PIN-код",
        en: "Enter PIN code",
        uk: "Введіть PIN-код",
      },

      // Плееры
      app_settings_player_find: {
        ru: "Поиск и выбор плеера",
        en: "Player search and selection",
        uk: "Пошук і вибір плеєра",
      },
      app_settings_player_find_description: {
        ru: "Нажмите, чтобы выбрать из найденных плееров в вашей системе.",
        en: "Click to select from the found players in your system.",
        uk: "Натисніть, щоб вибрати зі знайдених плеєрів у вашій системі.",
      },
      app_settings_player_not_found: {
        ru: "Медиаплееры не найдены!",
        en: "Media players were not found!",
        uk: "Медіаплеєри не знайдено!",
      },
      app_settings_player_select_title: {
        ru: "Выберите плеер по умолчанию",
        en: "Choose the default player",
        uk: "Виберіть плеєр за замовчуванням",
      },
      app_settings_player_selecting: {
        ru: "Выбор плеера {name}…",
        en: "Selecting {name}…",
        uk: "Вибір плеєра {name}…",
      },
      app_settings_player_selected: {
        ru: "Выбран плеер: {name}",
        en: "Selected player: {name}",
        uk: "Обрано плеєр: {name}",
      },
      app_settings_player_select_error: {
        ru: "Ошибка при выборе плеера",
        en: "Could not select the player",
        uk: "Помилка під час вибору плеєра",
      },
      app_settings_keyboard_section: {
        ru: "Выбор клавиатуры",
        en: "Keyboard selection",
        uk: "Вибір клавіатури",
      },
      app_settings_keyboard_default: {
        ru: "По умолчанию",
        en: "Default",
        uk: "За замовчуванням",
      },
      app_settings_keyboard_gamepad: {
        ru: "С геймпадом",
        en: "With gamepad",
        uk: "З геймпадом",
      },
      app_settings_keyboard_system: {
        ru: "Системная",
        en: "System",
        uk: "Системна",
      },
      app_settings_keyboard_builtin: {
        ru: "Встроенная",
        en: "Built-in",
        uk: "Вбудована",
      },

      // Поддержка
      donate_support: {
        ru: "Поддержать на {amount} грн",
        en: "Support with {amount} UAH",
        uk: "Підтримати на {amount} грн",
      },
      donate_btn_description: {
        ru: "Добровольная поддержка LampaUa",
        en: "Voluntary support for LampaUa",
        uk: "Добровільна підтримка LampaUa",
      },
      donate_btn_title: {
        ru: "Поддержать проект 🫶",
        en: "Support the project🫶",
        uk: "Підтримати проект 🫶",
      },
      donate_modal_title: {
        ru: "Поддержать проект 🫶",
        en: "Support the project 🫶",
        uk: "Підтримати проект 🫶",
      },
      donate_modal_description: {
        ru: "Донат является добровольной поддержкой LampaUa.",
        en: "The donation is voluntary support for LampaUa.",
        uk: "Донат є добровільною підтримкою LampaUa.",
      },

      // О приложении
      app_about_title: {
        ru: "Десктопное приложение-клиент для LampaUa.",
        en: "Desktop client application for LampaUa.",
        uk: "Десктопний застосунок-клієнт для LampaUa.",
      },
      app_about_version_app: {
        ru: "Версия приложения: {current_version}",
        en: "App version: {current_version}",
        uk: "Версія додатку: {current_version}",
      },
      app_about_version_latest: {
        ru: "Последняя версия: {latest_version}",
        en: "Latest version: {latest_version}",
        uk: "Остання версія: {latest_version}",
      },
      app_about_version_lampa: {
        ru: "Версия Lampa: {lampa_version}",
        en: "Lampa version: {lampa_version}",
        uk: "Версія Lampa: {lampa_version}",
      },
      app_about_github: {
        ru: "GitHub",
        en: "GitHub",
        uk: "GitHub",
      },

      // Горячие клавиши
      hotkey_search: {
        ru: "Поиск",
        en: "Search",
        uk: "Пошук",
      },
      hotkey_fullscreen: {
        ru: "Полноэкранный режим",
        en: "Fullscreen mode",
        uk: "Повноекранний режим",
      },
      hotkey_close: {
        ru: "Закрытие приложения",
        en: "Close application",
        uk: "Закриття додатку",
      },
      hotkey_menu: {
        ru: "Открыть/закрыть меню",
        en: "Open/close menu",
        uk: "Відкрити / закрити меню",
      },

      app_error: {
        ru: "Ошибка",
        en: "Error",
        uk: "Помилка",
      },
    };

    forceUkrainianTranslations(translations);
    Lampa.Lang.add(translations);

    Lampa.SettingsApi.addComponent({
      component: "app_settings",
      name: Lampa.Lang.translate("app_settings"),
      icon: settings_app_icon,
      before: "account",
    });

    Lampa.Template.add(
      "settings_app_settings_ts",
      `<div>
        <div class="settings-param" data-static="true" data-name="app_settings_ts_tsStatus">
          <div class="settings-param__name">${Lampa.Lang.translate("app_settings_ts_status_name")}</div>
          <div class="settings-param__descr">🔄</div>
        </div>
        <div class="settings-param" data-static="true" data-name="app_settings_ts_tsVersion">
          <div class="settings-param__name">${Lampa.Lang.translate("app_settings_ts_version_name")}</div>
          <div class="settings-param__descr">🔄</div>
        </div>
        <div class="settings-param" data-static="true" data-name="app_settings_ts_tsGstStatus">
          <div class="settings-param__name">${Lampa.Lang.translate("app_settings_ts_gst_status_name")}</div>
          <div class="settings-param__descr">🔄</div>
        </div>
        <div class="settings-param" data-static="true" data-name="app_settings_ts_tsGstVersion">
          <div class="settings-param__name">${Lampa.Lang.translate("app_settings_ts_gst_version_name")}</div>
          <div class="settings-param__descr">🔄</div>
        </div>
      </div>`,
    );

    const settingsManager = new SettingsManager("app_settings");

    const currentKeyboardType = normalizeKeyboardType(
      Lampa.Storage.get(
        "desktop_keyboard_regular",
        Lampa.Storage.get("keyboard_type", "integrate"),
      ),
      "integrate",
    );
    const gamepadKeyboardType = normalizeKeyboardType(
      Lampa.Storage.get("desktop_keyboard_gamepad", "lampa"),
      "lampa",
    );

    Lampa.Storage.set("desktop_keyboard_regular", currentKeyboardType);
    Lampa.Storage.set("desktop_keyboard_gamepad", gamepadKeyboardType);
    Lampa.Storage.set("keyboard_type", currentKeyboardType);
    Lampa.SettingsApi.addParam({
      component: "more",
      param: {
        name: "desktop_keyboard_separator",
        type: "title",
      },
      field: {
        name: Lampa.Lang.translate("app_settings_keyboard_section"),
      },
      onRender: function (element) {
        setTimeout(function () {
          const anchor = $('div[data-name="keyboard_type"]');
          anchor.hide();
          const moreTitle = $('div[data-name="pages_save_total"]').prev(
            ".settings-param-title",
          );
          element.attr("data-desktop-section", "keyboard");
          if (moreTitle.length) moreTitle.before(element);
        }, 0);
      },
    });
    Lampa.SettingsApi.addParam({
      component: "more",
      param: {
        name: "desktop_keyboard_regular",
        type: "select",
        values: {
          integrate: Lampa.Lang.translate("app_settings_keyboard_system"),
          lampa: Lampa.Lang.translate("app_settings_keyboard_builtin"),
        },
        default: currentKeyboardType,
      },
      field: {
        name: Lampa.Lang.translate("app_settings_keyboard_default"),
      },
      onChange: function (value) {
        const type = normalizeKeyboardType(value, "integrate");
        Lampa.Storage.set("desktop_keyboard_regular", type);
        Lampa.Storage.set("keyboard_type", type);
      },
      onRender: function (element) {
        setTimeout(function () {
          const section = $('[data-desktop-section="keyboard"]');
          if (section.length) section.after(element);
        }, 0);
      },
    });
    Lampa.SettingsApi.addParam({
      component: "more",
      param: {
        name: "desktop_keyboard_gamepad",
        type: "select",
        values: {
          integrate: Lampa.Lang.translate("app_settings_keyboard_system"),
          lampa: Lampa.Lang.translate("app_settings_keyboard_builtin"),
        },
        default: gamepadKeyboardType,
      },
      field: {
        name: Lampa.Lang.translate("app_settings_keyboard_gamepad"),
      },
      onChange: function (value) {
        const type = normalizeKeyboardType(value, "lampa");
        Lampa.Storage.set("desktop_keyboard_gamepad", type);
        Lampa.Storage.set("keyboard_type", type);
      },
      onRender: function (element) {
        setTimeout(function () {
          const regular = $('div[data-name="desktop_keyboard_regular"]');
          if (regular.length) regular.after(element);
          else {
            const anchor = $('div[data-name="keyboard_type"]');
            if (anchor.length) anchor.after(element);
          }
        }, 0);
      },
    });
    if (!Lampa.Platform.macOS()) {
      Lampa.SettingsApi.addParam({
        component: "player",
        param: {
          name: "player_find",
          type: "button",
        },
        field: {
          name: Lampa.Lang.translate("app_settings_player_find"),
          description: Lampa.Lang.translate(
            "app_settings_player_find_description",
          ),
        },
        onChange: async () => {
          Lampa.Loading.start(
            () => {},
            Lampa.Lang.translate("app_settings_player_find"),
          );

          const result = await window.electronAPI.player.getAllWithDetails();
          Lampa.Loading.stop();

          if (!result.success || result.players.length === 0) {
            Lampa.Noty.show(
              Lampa.Lang.translate("app_settings_player_not_found"),
              "error",
              5000,
            );
            return;
          }

          // Используем встроенный Lampa.Select вместо кастомного модального окна
          const items = [];
          for (let i = 0; i < result.players.length; i++) {
            const player = result.players[i];
            items.push({
              title: player.name,
              subtitle: player.path,
              value: player.id,
              selected: player.isDefault,
            });
          }

          Lampa.Select.show({
            title: Lampa.Lang.translate("app_settings_player_select_title"),
            items: items,
            onSelect: async (item) => {
              Lampa.Loading.start(
                () => {},
                Lampa.Lang.translate("app_settings_player_selecting").replace(
                  "{name}",
                  item.title,
                ),
              );

              const saveResult =
                await window.electronAPI.player.setDefaultAndSave(item.value);

              Lampa.Loading.stop();

              if (
                saveResult.success &&
                applyTrustedPlayerSelection(saveResult.path)
              ) {
                Lampa.Noty.show(
                  Lampa.Lang.translate("app_settings_player_selected").replace(
                    "{name}",
                    item.title,
                  ),
                  "success",
                  3000,
                );
                Lampa.Settings.update();
              } else {
                Lampa.Noty.show(
                  Lampa.Lang.translate("app_settings_player_select_error"),
                  "error",
                  3000,
                );
              }

              Lampa.Controller.toggle("settings_component");
            },
            onBack: () => {
              Lampa.Controller.toggle("settings_component");
            },
          });
        },
        onRender: function (element) {
          setTimeout(function () {
            var anchor = $('div[data-name="player_nw_path"]');
            if (anchor.length) anchor.after(element);
          }, 0);
        },
      });
    }

    Promise.all([
      settingsManager.addToQueue({
        order: 3,
        param: {
          name: "app_settings_fullscreen_mode",
          type: "select",
          values: {
            always: Lampa.Lang.translate("fullscreen_mode_always"),
            never: Lampa.Lang.translate("fullscreen_mode_never"),
            last: Lampa.Lang.translate("fullscreen_mode_last"),
          },
          default: "last",
        },
        field: {
          name: Lampa.Lang.translate("app_settings_fullscreen_mode_name"),
          description: Lampa.Lang.translate(
            "app_settings_fullscreen_mode_description",
          ),
        },
        onChange: async (value) => {
          const result = await window.electronAPI.setFullscreenMode(value);
          if (result.success) {
            Lampa.Noty.show(`Режим изменен на: ${value}`, "success", 2000);
          } else {
            Lampa.Noty.show(
              `${Lampa.Lang.translate("app_error")}: ${result.message}`,
              "error",
              5000,
            );
          }
        },
      }),

      settingsManager.loadAsyncSetting("autoUpdate", {
        order: 4,
        param: {
          name: "app_settings_autoUpdate",
          type: "trigger",
        },
        field: {
          name: Lampa.Lang.translate("app_settings_autoupdate_field_name"),
        },
        onChange: async function (value) {
          await window.electronAPI.store.set("autoUpdate", value === "true");
        },
      }),

      settingsManager.loadAsyncSetting("lampaUrl", {
        order: 5,
        param: {
          name: "app_settings_lampaUrl",
          type: "select",
          values: LAMPA_URL_OPTIONS,
          default: DEFAULT_LAMPA_URL,
        },
        field: {
          name: Lampa.Lang.translate("app_settings_lampa_url_name"),
          description: Lampa.Lang.translate(
            "app_settings_lampa_url_description",
          ),
        },
        onChange: async function (value) {
          const lampaUrl = Object.prototype.hasOwnProperty.call(
            LAMPA_URL_OPTIONS,
            value,
          )
            ? value
            : DEFAULT_LAMPA_URL;

          Lampa.Noty.show(Lampa.Lang.translate("app_settings_lampa_url_ok"));
          setTimeout(
            async () =>
              await window.electronAPI.store.set("lampaUrl", lampaUrl),
            1000,
          );
        },
      }),
      settingsManager.loadAsyncSetting("webSecurity", {
        order: 8.5,
        param: {
          name: "app_settings_webSecurity",
          type: "trigger",
        },
        field: {
          name: Lampa.Lang.translate("app_settings_web_security_field_name"),
          description: Lampa.Lang.translate(
            "app_settings_web_security_field_description",
          ),
        },
        onChange: async function (value) {
          await window.electronAPI.store.set("webSecurity", value === "true");
          Lampa.Noty.show(
            Lampa.Lang.translate("app_settings_web_security_notify"),
          );
        },
      }),
    ]).then(() => {
      settingsManager
        .addToQueue({
          order: 0.5,
          param: {
            name: "app_settings_donate",
            type: "button",
          },
          field: {
            name: Lampa.Lang.translate("donate_btn_title"),
            description: Lampa.Lang.translate("donate_btn_description"),
          },
          onChange: function () {
            Lampa.Loading.start(() => {}, Lampa.Lang.translate("loading"));

            Lampa.Template.add(
              "donate_modal",
              `<div class="app-modal-donate" style="padding: 24px; display: flex; align-items: center; min-height: 180px; flex-direction: column; gap: 18px;">
                <div style="font-size: 1.15em; line-height: 1.45; text-align: center; color: #ddd; max-width: 560px;">` +
                Lampa.Lang.translate("donate_modal_description") +
                `</div>
                <div style="display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;">
                  <div class="simple-button selector donate-link" data-amount="100" style="margin-right: unset; font-size: unset;"><span>` +
                Lampa.Lang.translate("donate_support").replace(
                  "{amount}",
                  "100",
                ) +
                `</span></div>
                  <div class="simple-button selector donate-link" data-amount="200" style="margin-right: unset; font-size: unset;"><span>` +
                Lampa.Lang.translate("donate_support").replace(
                  "{amount}",
                  "200",
                ) +
                `</span></div>
                  <div class="simple-button selector donate-link" data-amount="300" style="margin-right: unset; font-size: unset;"><span>` +
                Lampa.Lang.translate("donate_support").replace(
                  "{amount}",
                  "300",
                ) +
                `</span></div>
                  <div class="simple-button selector donate-link" data-amount="500" style="margin-right: unset; font-size: unset;"><span>` +
                Lampa.Lang.translate("donate_support").replace(
                  "{amount}",
                  "500",
                ) +
                `</span></div>
                </div>
              </div>`,
            );

            let donate_html = Lampa.Template.get("donate_modal", {});

            const paymentLinks = {
              100: "https://send.monobank.ua/jar/9CbDrcurEX",
              200: "https://send.monobank.ua/jar/9CbDrcurEX",
              300: "https://send.monobank.ua/jar/9CbDrcurEX",
              500: "https://send.monobank.ua/jar/9CbDrcurEX",
            };

            donate_html.find(".donate-link").on("hover:enter", function () {
              const amount = this.getAttribute("data-amount");
              const link = paymentLinks[amount];

              if (link) {
                window.open(link, "_blank");
              }
            });

            Lampa.Modal.open({
              title: Lampa.Lang.translate("donate_modal_title"),
              html: donate_html,
              size: "medium",
              onBack: function () {
                Lampa.Modal.close();
                Lampa.Controller.toggle("settings_component");
              },
            });

            Lampa.Loading.stop();
            Lampa.Controller.toggle("modal");
          },
        })
        .addToQueue({
          order: 1,
          param: {
            name: "app_settings_about",
            type: "button",
          },
          field: {
            name: Lampa.Lang.translate("app_settings_about_field_name"),
            description: Lampa.Lang.translate(
              "app_settings_about_field_description",
            ),
          },
          onChange: function () {
            Lampa.Loading.start(() => {}, Lampa.Lang.translate("loading"));
            const network = new Lampa.Reguest();
            network.silent(
              "https://api.github.com/repos/Hlushok/lampaua-desktop/releases/latest",
              (data) => {
                window.electronAPI
                  .getAppVersion()
                  .then((current_version) => {
                    const latest_version = data.tag_name.replace("v", "");

                    Lampa.Template.add(
                      "about_modal",
                      `<div class="app-modal-about">
                        ` +
                        Lampa.Lang.translate("app_about_title") +
                        `
                        <ul>
                            <li>` +
                        Lampa.Lang.translate("app_about_version_app").replace(
                          "{current_version}",
                          current_version,
                        ) +
                        `</li>
                            <li>` +
                        Lampa.Lang.translate(
                          "app_about_version_latest",
                        ).replace("{latest_version}", latest_version) +
                        `</li>
                            <li>` +
                        Lampa.Lang.translate("app_about_version_lampa").replace(
                          "{lampa_version}",
                          Lampa.Platform.version("app"),
                        ) +
                        `</li>
                        </ul>
                        <div class="simple-button selector github">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                            </svg>
                            <span>` +
                        Lampa.Lang.translate("app_about_github") +
                        `</span>
                        </div>
                      </div>`,
                    );

                    let about_html = Lampa.Template.get("about_modal", {});
                    about_html.find(".github").on("hover:enter", function () {
                      window.open(
                        "https://github.com/Hlushok/lampaua-desktop",
                        "_blank",
                      );
                    });

                    Lampa.Modal.open({
                      title: Lampa.Lang.translate(
                        "app_settings_about_field_name",
                      ),
                      html: about_html,
                      size: "small",
                      onBack: function () {
                        Lampa.Modal.close();
                        Lampa.Controller.toggle("settings_component");
                      },
                    });
                    Lampa.Loading.stop();
                    // И убеждаемся, что фокус на модальном окне
                    Lampa.Controller.toggle("modal");
                  })
                  .catch((error) => {
                    console.error(
                      "APP",
                      "Не удалось получить appVersion",
                      error,
                    );
                  });
              },
              () => {
                Lampa.Loading.stop();
              },
              null,
              {
                cache: { life: 10 },
              },
            );
          },
        })
        .addToQueue({
          order: 2,
          param: {
            name: "app_settings_separator_main",
            type: "title",
          },
          field: {
            name: Lampa.Lang.translate("app_settings_separator_main_name"),
          },
        })
        .addToQueue({
          order: 6,
          param: {
            name: "app_settings_separator_main",
            type: "title",
          },
          field: {
            name: "TorrServer",
          },
        })
        .addToQueue({
          order: 7,
          param: {
            name: "app_settings_ts",
            type: "button",
          },
          field: {
            name: Lampa.Lang.translate("app_settings_ts_field_name"),
            description: Lampa.Lang.translate(
              "app_settings_ts_field_description",
            ),
          },
          onChange: () => {
            Lampa.Settings.create("app_settings_ts", {
              onBack: () => Lampa.Settings.create("app_settings"),
            });
          },
        })
        .addToQueue({
          order: 8,
          param: {
            name: "app_settings_separator_other",
            type: "title",
          },
          field: {
            name: Lampa.Lang.translate("app_settings_separator_other_name"),
          },
        })
        .addToQueue({
          order: 9,
          param: {
            name: "app_settings_ie",
            type: "button",
          },
          field: {
            name: Lampa.Lang.translate("app_settings_ie_field_name"),
            description: Lampa.Lang.translate(
              "app_settings_ie_field_description",
            ),
          },
          onChange: () => {
            Lampa.Select.show({
              title: Lampa.Lang.translate("app_settings_ie_field_name"),
              items: [
                {
                  title: Lampa.Lang.translate(
                    "app_settings_ie_separator_cloud_title",
                  ),
                  separator: true,
                },
                {
                  title: Lampa.Lang.translate(
                    "app_settings_ie_btn_export_cloud_title",
                  ),
                  subtitle: Lampa.Lang.translate(
                    "app_settings_ie_btn_export_cloud_subtitle",
                  ),
                  action: "e-cloud",
                },
                {
                  title: Lampa.Lang.translate(
                    "app_settings_ie_btn_import_cloud_title",
                  ),
                  subtitle: Lampa.Lang.translate(
                    "app_settings_ie_btn_import_cloud_subtitle",
                  ),
                  action: "i-cloud",
                },
                {
                  title: Lampa.Lang.translate(
                    "app_settings_ie_separator_local_title",
                  ),
                  separator: true,
                },
                {
                  title: Lampa.Lang.translate(
                    "app_settings_ie_btn_export_file_title",
                  ),
                  subtitle: Lampa.Lang.translate(
                    "app_settings_ie_btn_export_subtitle",
                  ),
                  action: "e-file",
                },
                {
                  title: Lampa.Lang.translate(
                    "app_settings_ie_btn_import_file_title",
                  ),
                  subtitle: Lampa.Lang.translate(
                    "app_settings_ie_btn_import_subtitle",
                  ),
                  action: "i-file",
                },
              ],
              onSelect: async (a) => {
                try {
                  let result;
                  if (a.action === "e-cloud") {
                    Lampa.Noty.show(
                      Lampa.Lang.translate("app_settings_noty_waiting"),
                    );
                    result = await window.electronAPI.exportSettingsToCloud();
                    if (result && result.message) {
                      Lampa.Noty.show(result.message);
                    }
                  } else if (a.action === "i-cloud") {
                    // Функция для показа модального окна ввода 10-значного кода
                    async function showTenDigitModal() {
                      return new Promise((resolve) => {
                        let html = $(
                          `
                      <div class="account-modal-split">
                        <div class="account-modal-split__info">
                          <div class="account-modal-split__title">` +
                            Lampa.Lang.translate(
                              "app_settings_ie_modal_import_cloud",
                            ) +
                            `</div>
                          <div class="account-modal-split__text">` +
                            Lampa.Lang.translate(
                              "app_settings_ie_modal_enter_id",
                            ) +
                            `</div>
                          <div class="account-modal-split__code">
                            ${Array(10).fill('<div class="account-modal-split__code-num"><span>-</span></div>').join("")}
                          </div>
                          <div class="account-modal-split__keyboard">
                            <div class="simple-keyboard"></div>
                          </div>
                        </div>
                      </div>`,
                        );

                        let nums = html.find(".account-modal-split__code-num");
                        let keyboard;

                        if (Lampa.Platform.tv()) {
                          html.addClass(
                            "layer--" +
                              (Lampa.Platform.mouse() ? "wheight" : "height"),
                          );
                        } else {
                          html.addClass("account-modal-split--mobile");
                        }

                        function drawCode(value) {
                          nums.find("span").text("-");
                          value.split("").forEach((v, i) => {
                            if (nums[i]) nums.eq(i).find("span").text(v);
                          });
                        }

                        Lampa.Modal.open({
                          title: "",
                          html: html,
                          size: Lampa.Platform.tv() ? "full" : "medium",
                          scroll: { nopadding: true },
                          onBack: () => {
                            if (
                              keyboard &&
                              typeof keyboard.destroy === "function"
                            ) {
                              keyboard.destroy();
                              keyboard = null;
                            }
                            Lampa.Modal.close();
                            Lampa.Controller.toggle("settings_component");
                            resolve(null);
                          },
                        });

                        keyboard = new window.SimpleKeyboard.default({
                          display: {
                            "{BKSP}": "&nbsp;",
                            "{ENTER}": "&nbsp;",
                          },
                          layout: {
                            default: ["0 1 2 3 4 {BKSP}", "5 6 7 8 9 {ENTER}"],
                          },
                          onChange: async (value) => {
                            drawCode(value);
                            if (value.length === 10) {
                              if (
                                keyboard &&
                                typeof keyboard.destroy === "function"
                              ) {
                                keyboard.destroy();
                                keyboard = null;
                              }
                              Lampa.Modal.close();
                              // Открываем второй модал для PIN и получаем результат
                              const pinResult = await showPinModal(value);
                              resolve(pinResult);
                            }
                          },
                          onKeyPress: async (button) => {
                            if (button === "{BKSP}") {
                              keyboard.setInput(
                                keyboard.getInput().slice(0, -1),
                              );
                              drawCode(keyboard.getInput());
                            } else if (button === "{ENTER}") {
                              if (keyboard.getInput().length === 10) {
                                if (
                                  keyboard &&
                                  typeof keyboard.destroy === "function"
                                ) {
                                  keyboard.destroy();
                                  keyboard = null;
                                }
                                Lampa.Modal.close();
                                const pinResult = await showPinModal(
                                  keyboard.getInput(),
                                );
                                resolve(pinResult);
                              }
                            }
                          },
                        });

                        let keys = $(".simple-keyboard .hg-button").addClass(
                          "selector",
                        );
                        Lampa.Controller.collectionSet($(".simple-keyboard"));
                        Lampa.Controller.collectionFocus(
                          keys[0],
                          $(".simple-keyboard"),
                        );
                        $(".simple-keyboard .hg-button").on(
                          "hover:enter",
                          function (e) {
                            Lampa.Controller.collectionFocus($(this)[0]);
                            keyboard.handleButtonClicked(
                              $(this).attr("data-skbtn"),
                              e,
                            );
                          },
                        );
                      });
                    }

                    // Функция для показа модального окна ввода PIN-кода
                    async function showPinModal(code10) {
                      return new Promise((resolve) => {
                        Lampa.Input.edit(
                          {
                            free: true,
                            title: Lampa.Lang.translate(
                              "app_settings_ie_modal_enter_pin_title",
                            ),
                            nosave: true,
                            value: "",
                            layout: "nums",
                            keyboard: "lampa",
                            password: false,
                          },
                          async (pin4) => {
                            if (pin4 && pin4.length === 4) {
                              try {
                                const importResult =
                                  await window.electronAPI.importSettingsFromCloud(
                                    code10,
                                    pin4,
                                  );
                                resolve(importResult);
                              } catch (error) {
                                resolve({
                                  message:
                                    Lampa.Lang.translate(
                                      "app_settings_ie_import_error",
                                    ) +
                                    ": " +
                                    error.toString(),
                                });
                              }
                            } else {
                              resolve({
                                message: Lampa.Lang.translate(
                                  "app_settings_ie_invalid_pin",
                                ),
                              });
                            }
                            Lampa.Controller.toggle("menu");
                          },
                        );
                      });
                    }

                    // Запускаем процесс импорта из облака
                    result = await showTenDigitModal();
                    if (result && result.message) {
                      Lampa.Noty.show(result.message);
                    } else if (result === null) {
                      // Пользователь закрыл модальное окно
                    } else {
                      Lampa.Noty.show(
                        Lampa.Lang.translate("app_settings_ie_import_success"),
                      );
                    }
                  } else if (a.action === "e-file") {
                    result = await window.electronAPI.exportSettingsToFile();
                    if (result && result.message) {
                      Lampa.Noty.show(result.message);
                    }
                  } else if (a.action === "i-file") {
                    result = await window.electronAPI.importSettingsFromFile();
                    if (result && result.message) {
                      Lampa.Noty.show(result.message);
                    }
                  }
                } catch (error) {
                  Lampa.Noty.show(error.toString());
                }
              },
              onBack: () => {
                Lampa.Controller.toggle("settings_component");
              },
            });
          },
        });
      if (!Lampa.Platform.macOS()) {
        settingsManager.addToQueue({
          order: 5.5,
          param: {
            name: "player_find",
            type: "button",
          },
          field: {
            name: Lampa.Lang.translate("app_settings_player_find"),
            description: Lampa.Lang.translate(
              "app_settings_player_find_description",
            ),
          },
          onChange: async () => {
            Lampa.Loading.start(
              () => {},
              Lampa.Lang.translate("app_settings_player_find"),
            );

            const result = await window.electronAPI.player.getAllWithDetails();
            Lampa.Loading.stop();

            if (!result.success || result.players.length === 0) {
              Lampa.Noty.show(
                Lampa.Lang.translate("app_settings_player_not_found"),
                "error",
                5000,
              );
              return;
            }

            const items = [];
            for (let i = 0; i < result.players.length; i++) {
              const player = result.players[i];
              items.push({
                title: player.name,
                subtitle: player.path,
                value: player.id,
                selected: player.isDefault,
              });
            }

            Lampa.Select.show({
              title: Lampa.Lang.translate("app_settings_player_select_title"),
              items: items,
              onSelect: async (item) => {
                Lampa.Loading.start(
                  () => {},
                  Lampa.Lang.translate("app_settings_player_selecting").replace(
                    "{name}",
                    item.title,
                  ),
                );

                const saveResult =
                  await window.electronAPI.player.setDefaultAndSave(item.value);

                Lampa.Loading.stop();

                if (
                  saveResult.success &&
                  applyTrustedPlayerSelection(saveResult.path)
                ) {
                  Lampa.Noty.show(
                    Lampa.Lang.translate(
                      "app_settings_player_selected",
                    ).replace("{name}", item.title),
                    "success",
                    3000,
                  );
                  Lampa.Settings.update();
                } else {
                  Lampa.Noty.show(
                    Lampa.Lang.translate("app_settings_player_select_error"),
                    "error",
                    3000,
                  );
                }

                Lampa.Controller.toggle("settings_component");
              },
              onBack: () => {
                Lampa.Controller.toggle("settings_component");
              },
            });
          },
        });
      }
      settingsManager.apply();
    });

    const settingsTsManager = new SettingsManager("app_settings_ts");

    Promise.all([
      settingsTsManager.loadAsyncSetting("tsAutoStart", {
        order: 6,
        param: {
          name: "app_settings_ts_tsAutostart",
          type: "trigger",
        },
        field: {
          name: Lampa.Lang.translate("app_settings_ts_autostart_field_name"),
        },
        onChange: async function (value) {
          // Lampa.Settings.update();
          await window.electronAPI.store.set("tsAutoStart", value === "true");
        },
      }),
      settingsTsManager.loadAsyncSetting("tsPort", {
        order: 8,
        param: {
          name: "app_settings_ts_tsPort",
          type: "input",
          values: "",
        },
        field: {
          name: Lampa.Lang.translate("app_settings_ts_port_name"),
          description: Lampa.Lang.translate("app_settings_ts_port_description"),
        },
        onChange: async function (value) {
          // Lampa.Settings.update();
          Lampa.Noty.show(Lampa.Lang.translate("app_settings_ts_port_ok"));
          setTimeout(
            async () => await window.electronAPI.store.set("tsPort", value),
            1000,
          );
        },
      }),
      settingsTsManager.loadAsyncSetting("tsUseGst", {
        order: 7,
        param: {
          name: "app_settings_ts_tsUseGst",
          type: "trigger",
        },
        field: {
          name: Lampa.Lang.translate("app_settings_ts_gst_field_name"),
          description: Lampa.Lang.translate(
            "app_settings_ts_gst_field_description",
          ),
        },
        onChange: async function (value) {
          const useGst = value === "true";
          await window.electronAPI.store.set("tsUseGst", useGst);

          // Проверяем, установлен ли TorrServer
          const status = await window.electronAPI.torrServer.getStatus();
          if (status.installed) {
            Lampa.Noty.show(
              Lampa.Lang.translate("app_settings_ts_gst_changed_notify"),
              "warning",
              5000,
            );
          }

          setTimeout(updateTsStatus, 500);
        },
      }),
    ]).then(() => {
      settingsTsManager
        .addToQueue({
          order: 1,
          param: {
            name: "app_settings_ts_separator_main",
            type: "title",
          },
          field: {
            name: Lampa.Lang.translate("app_settings_ts_separator_main_title"),
          },
        })
        .addToQueue({
          component: "app_settings_ts",
          order: 2,
          param: {
            name: "ts_start",
            type: "button",
          },
          field: {
            name: Lampa.Lang.translate("app_settings_ts_start_name"),
          },
          onChange: async () => {
            const status = await window.electronAPI.torrServer.getStatus();
            if (status.installed) {
              Lampa.Loading.start(
                () => {},
                Lampa.Lang.translate("app_settings_ts_start_loading"),
              );
            } else {
              Lampa.Loading.start(
                () => {},
                Lampa.Lang.translate("app_settings_ts_download_loading"),
              );
            }

            const tsPort = await window.electronAPI.store.get("tsPort");
            const result = await window.electronAPI.torrServer.start([
              "--port",
              tsPort,
            ]);
            Lampa.Storage.set("torrserver_url", `http://localhost:${tsPort}`);
            Lampa.Storage.set("torrserver_use_link", "one");

            setTimeout(updateTsStatus, 1000);

            Lampa.Loading.stop();
            Lampa.Noty.show(
              result.success
                ? result.message
                : `${Lampa.Lang.translate("app_error")}: ${result.message}`,
            );
          },
        })
        .addToQueue({
          component: "app_settings_ts",
          order: 3,
          param: {
            name: "ts_stop",
            type: "button",
          },
          field: {
            name: Lampa.Lang.translate("app_settings_ts_stop_name"),
          },
          onChange: async () => {
            Lampa.Loading.start(
              () => {},
              Lampa.Lang.translate("app_settings_ts_stop_loading"),
            );
            const result = await window.electronAPI.torrServer.stop();
            Lampa.Loading.stop();
            setTimeout(updateTsStatus, 500);
            Lampa.Noty.show(
              result.success
                ? result.message
                : `${Lampa.Lang.translate("app_error")}: ${result.message}`,
            );
          },
        })
        .addToQueue({
          component: "app_settings_ts",
          order: 4,
          param: {
            name: "ts_restart",
            type: "button",
          },
          field: {
            name: Lampa.Lang.translate("app_settings_ts_restart_name"),
          },
          onChange: async () => {
            Lampa.Loading.start(
              () => {},
              Lampa.Lang.translate("app_settings_ts_restart_loading"),
            );

            const tsPort = await window.electronAPI.store.get("tsPort");
            const result = await window.electronAPI.torrServer.restart([
              "--port",
              tsPort,
            ]);
            Lampa.Storage.set("torrserver_url", `http://localhost:${tsPort}`);
            Lampa.Storage.set("torrserver_use_link", "one");

            setTimeout(updateTsStatus, 1000);
            Lampa.Loading.stop();
            Lampa.Noty.show(
              result.success
                ? result.message
                : `${Lampa.Lang.translate("app_error")}: ${result.message}`,
            );
          },
        })
        .addToQueue({
          component: "app_settings_ts",
          order: 4.5,
          param: {
            name: "ts_reinstall",
            type: "button",
          },
          field: {
            name: Lampa.Lang.translate("app_settings_ts_reinstall_name"),
          },
          onChange: async () => {
            Lampa.Loading.start(
              () => {},
              Lampa.Lang.translate("app_settings_ts_reinstall_loading"),
            );

            const tsPort = await window.electronAPI.store.get("tsPort");
            const result = await window.electronAPI.torrServer.reinstall([
              "--port",
              tsPort,
            ]);

            Lampa.Storage.set("torrserver_url", `http://localhost:${tsPort}`);
            Lampa.Storage.set("torrserver_use_link", "one");

            setTimeout(updateTsStatus, 1000);
            Lampa.Loading.stop();
            Lampa.Noty.show(
              result.success
                ? result.message
                : `${Lampa.Lang.translate("app_error")}: ${result.message}`,
            );
          },
        })
        .addToQueue({
          component: "app_settings_ts",
          order: 4.6,
          param: {
            name: "ts_check_update",
            type: "button",
          },
          field: {
            name: Lampa.Lang.translate("app_settings_ts_check_update_name"),
          },
          onChange: async () => {
            Lampa.Loading.start(
              () => {},
              Lampa.Lang.translate("app_settings_ts_check_update_loading"),
            );
            const result = await window.electronAPI.torrServer.checkUpdate();
            // Создаем модальное окно если есть обновление
            if (result.hasUpdate) {
              Lampa.Template.add(
                "ts_update_modal",
                `<div class="app-modal-ts-update">
                    ${Lampa.Lang.translate("app_settings_ts_update_found_message")}
                    <ul>
                        <li>${Lampa.Lang.translate("app_settings_ts_update_installed").replace("{current_version}", result.current)}</li>
                        <li>${Lampa.Lang.translate("app_settings_ts_update_latest").replace("{latest_version}", result.latest)}</li>
                    </ul>
                    <div class="simple-button selector ts_update">${Lampa.Lang.translate("app_settings_ts_update_button")}</div>
                  </div>`,
              );

              let ts_update_modal_html = Lampa.Template.get(
                "ts_update_modal",
                {},
              );
              ts_update_modal_html
                .find(".ts_update")
                .on("hover:enter", async function () {
                  Lampa.Loading.start(
                    () => {},
                    Lampa.Lang.translate("app_settings_ts_update_loading"),
                  );
                  const result = await window.electronAPI.torrServer.update();
                  Lampa.Loading.stop();
                  Lampa.Modal.close();
                  Lampa.Controller.toggle("settings_component");
                  setTimeout(updateTsStatus, 1000);
                  Lampa.Noty.show(
                    result.success
                      ? Lampa.Lang.translate("app_settings_ts_update_success")
                      : `${Lampa.Lang.translate("app_error")}: ${result.message}`,
                  );
                });

              Lampa.Modal.open({
                title: Lampa.Lang.translate(
                  "app_settings_ts_update_found_title",
                ),
                html: ts_update_modal_html,
                size: "small",
                onBack: function () {
                  Lampa.Modal.close();
                  Lampa.Controller.toggle("settings_component");
                },
              });
              Lampa.Loading.stop();
              // И убеждаемся, что фокус на модальном окне
              Lampa.Controller.toggle("modal");
            } else {
              Lampa.Noty.show(
                Lampa.Lang.translate("app_settings_ts_update_no_updates"),
              );
              Lampa.Loading.stop();
            }
          },
        })
        .addToQueue({
          component: "app_settings_ts",
          order: 4.7,
          param: {
            name: "ts_open_path",
            type: "button",
          },
          field: {
            name: Lampa.Lang.translate("app_settings_ts_open_path_name"),
          },
          onChange: async () => {
            const status = await window.electronAPI.torrServer.getStatus();

            if (status.installed) {
              await window.electronAPI.folder.open(status.executableDir);
            } else {
              Lampa.Noty.show(
                Lampa.Lang.translate("app_settings_ts_install_prompt"),
              );
            }
          },
        })
        .addToQueue({
          component: "app_settings_ts",
          order: 4.8,
          param: {
            name: "ts_open_web",
            type: "button",
          },
          field: {
            name: Lampa.Lang.translate("app_settings_ts_open_web_name"),
          },
          onChange: async () => {
            const status = await window.electronAPI.torrServer.getStatus();
            if (status.installed) {
              window.open(`http://${status.host}:${status.port}`, "_blank");
            } else {
              Lampa.Noty.show(
                Lampa.Lang.translate("app_settings_ts_install_prompt"),
              );
            }
          },
        })
        .addToQueue({
          order: 5,
          param: {
            name: "app_settings_ts_separator_settings",
            type: "title",
          },
          field: {
            name: Lampa.Lang.translate(
              "app_settings_ts_separator_settings_title",
            ),
          },
        })
        .addToQueue({
          order: 9,
          param: {
            name: "app_settings_ts_separator_danger",
            type: "title",
          },
          field: {
            name: Lampa.Lang.translate(
              "app_settings_ts_separator_danger_title",
            ),
          },
        })
        .addToQueue({
          component: "app_settings_ts",
          order: 10,
          param: {
            name: "ts_uninstall",
            type: "button",
          },
          field: {
            name: Lampa.Lang.translate("app_settings_ts_uninstall_name"),
          },
          onChange: async () => {
            Lampa.Noty.show(
              Lampa.Lang.translate("app_settings_ts_uninstall_loading"),
            );
            const result = await window.electronAPI.torrServer.uninstall();
            setTimeout(updateTsStatus, 500);
            Lampa.Noty.show(
              result.success
                ? result.message
                : `${Lampa.Lang.translate("app_error")}: ${result.message}`,
            );
          },
        })
        .addToQueue({
          component: "app_settings_ts",
          order: 11,
          param: {
            name: "ts_uninstall_keep_data",
            type: "button",
          },
          field: {
            name: Lampa.Lang.translate(
              "app_settings_ts_uninstall_keep_data_name",
            ),
          },
          onChange: async () => {
            Lampa.Noty.show(
              Lampa.Lang.translate(
                "app_settings_ts_uninstall_keep_data_loading",
              ),
            );
            const result = await window.electronAPI.torrServer.uninstall(true);
            setTimeout(updateTsStatus, 500);
            Lampa.Noty.show(
              result.success
                ? result.message
                : `${Lampa.Lang.translate("app_error")}: ${result.message}`,
            );
          },
        })
        .apply();
    });

    function updateTsStatus() {
      window.electronAPI.torrServer
        .getStatus()
        .then(async (status) => {
          console.log("🔄 Обновление статуса TorrServer:", status);

          // Обновляем версию с информацией о GST
          const versionElement = $(
            '[data-name="app_settings_ts_tsVersion"]',
          ).find(".settings-param__descr");

          if (status.version !== null) {
            const useGst = status.useGst || false;
            let versionText;
            if (status.running) {
              // Если сервер запущен, пытаемся получить информацию с сервера
              try {
                const serverInfo =
                  await window.electronAPI.torrServer.getServerInfo(
                    status.port,
                  );
                if (serverInfo.gstSupported) {
                  versionText = Lampa.Lang.translate(
                    "app_settings_ts_version_with_gst",
                  ).replace("{version}", status.version);
                } else if (serverInfo.gstSupported === false) {
                  versionText = Lampa.Lang.translate(
                    "app_settings_ts_version_without_gst",
                  ).replace("{version}", status.version);
                } else {
                  versionText = status.version;
                }
                // eslint-disable-next-line no-unused-vars
              } catch (e) {
                versionText = status.version;
              }
            } else {
              // Если сервер остановлен, показываем версию с настройкой GST
              versionText = useGst
                ? Lampa.Lang.translate(
                    "app_settings_ts_version_with_gst",
                  ).replace("{version}", status.version)
                : Lampa.Lang.translate(
                    "app_settings_ts_version_without_gst",
                  ).replace("{version}", status.version);
            }
            versionElement.text(versionText);
          } else {
            versionElement.text(
              Lampa.Lang.translate("app_settings_ts_status_install_prompt"),
            );
          }

          // Обновляем статус
          $('[data-name="app_settings_ts_tsStatus"]')
            .find(".settings-param__descr")
            .text(
              status.installed
                ? status.running
                  ? Lampa.Lang.translate(
                      "app_settings_ts_status_installed_running",
                    )
                  : Lampa.Lang.translate(
                      "app_settings_ts_status_installed_stopped",
                    )
                : Lampa.Lang.translate("app_settings_ts_status_not_installed"),
            );

          // Обновляем статус GStreamer
          const gstStatusElement = $(
            '[data-name="app_settings_ts_tsGstStatus"]',
          );
          const gstVersionElement = $(
            '[data-name="app_settings_ts_tsGstVersion"]',
          );

          if (gstStatusElement.length) {
            if (status.running) {
              try {
                const serverInfo =
                  await window.electronAPI.torrServer.getServerInfo(
                    status.port,
                  );
                const gstText = serverInfo.gstSupported
                  ? Lampa.Lang.translate("app_settings_ts_gst_enabled")
                  : Lampa.Lang.translate("app_settings_ts_gst_disabled");
                gstStatusElement.find(".settings-param__descr").text(gstText);

                if (gstVersionElement.length) {
                  gstVersionElement
                    .find(".settings-param__descr")
                    .text(serverInfo.gstreamerVersion || "—");
                }
              } catch (error) {
                console.error("Ошибка получения информации о GST:", error);
                gstStatusElement
                  .find(".settings-param__descr")
                  .text(Lampa.Lang.translate("app_settings_ts_gst_unknown"));
                if (gstVersionElement.length) {
                  gstVersionElement.find(".settings-param__descr").text("—");
                }
              }
            } else {
              // Сервер не запущен
              gstStatusElement
                .find(".settings-param__descr")
                .text(Lampa.Lang.translate("app_settings_ts_gst_unknown"));
              if (gstVersionElement.length) {
                gstVersionElement.find(".settings-param__descr").text("—");
              }
            }
          }
        })
        .catch((error) => {
          console.error("Ошибка обновления статуса:", error);
        });
    }

    // Подписываемся на открытие настроек TorrServer для обновления статуса
    Lampa.Settings.listener.follow("open", function (e) {
      if (e.name === "app_settings_ts") {
        // Обновляем статус сразу при открытии
        setTimeout(updateTsStatus, 100);
      }
    });

    // Также обновляем статус при переключении на вкладку настроек
    Lampa.Settings.listener.follow("component", function (e) {
      if (e.component === "app_settings_ts") {
        setTimeout(updateTsStatus, 100);
      }
    });
  }

  /**
   * Класс для управления курсором и горячими клавишами
   */
  class InputManager {
    constructor(options = {}) {
      this.cursorVisible = true;
      this.mouseMoveTimer = null;
      this.debug = options.debug || false;

      this.keyHandlers = new Map();

      this.modifiers = {
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
      };

      this.cursorSettings = {
        hideOnKeyPress: options.hideOnKeyPress ?? true,
        showOnMouseMove: options.showOnMouseMove ?? true,
        hideCursorStyle: options.hideCursorStyle || "none",
        showCursorStyle: options.showCursorStyle || "default",
        mouseInactivityTimeout: options.mouseInactivityTimeout || 0,
      };

      this.ignoredSelectors = [
        "input",
        "textarea",
        '[contenteditable="true"]',
        "select",
        // "button",
        // "a",
      ];

      this.init();
    }

    init() {
      if (this.cursorSettings.hideOnKeyPress) {
        document.addEventListener("keydown", this.handleKeyDown.bind(this));
      }

      if (this.cursorSettings.showOnMouseMove) {
        document.addEventListener("mousemove", this.handleMouseMove.bind(this));
        document.addEventListener(
          "mousedown",
          this.handleMouseAction.bind(this),
        );
        document.addEventListener("mouseup", this.handleMouseAction.bind(this));
        document.addEventListener("wheel", this.handleMouseAction.bind(this));
      }

      document.addEventListener("keyup", this.handleKeyUp.bind(this));
      window.addEventListener("blur", this.handleWindowBlur.bind(this));

      this.log("InputManager инициализирован");
    }

    hideCursor() {
      if (!this.cursorSettings.hideOnKeyPress) return;

      if (this.cursorVisible) {
        document.body.style.cursor = this.cursorSettings.hideCursorStyle;
        this.cursorVisible = false;

        const style = document.createElement("style");
        style.id = "input-manager-cursor-style";
        style.textContent = `* { cursor: ${this.cursorSettings.hideCursorStyle} !important; }`;

        const oldStyle = document.getElementById("input-manager-cursor-style");
        if (oldStyle) oldStyle.remove();

        document.head.appendChild(style);
        this.log("Курсор скрыт");
      }
    }

    showCursor() {
      if (this.cursorVisible) return;

      document.body.style.cursor = this.cursorSettings.showCursorStyle;
      this.cursorVisible = true;

      const style = document.getElementById("input-manager-cursor-style");
      if (style) style.remove();

      this.log("Курсор показан");
    }

    toggleCursor() {
      if (this.cursorVisible) {
        this.hideCursor();
      } else {
        this.showCursor();
      }
    }

    updateCursorSettings(settings) {
      Object.assign(this.cursorSettings, settings);
      this.log("Настройки курсора обновлены");
    }

    /**
     * Проверяет, находится ли фокус в игнорируемом элементе
     */
    isIgnoredElement(element = document.activeElement) {
      if (!element) return false;

      for (const selector of this.ignoredSelectors) {
        if (element.matches && element.matches(selector)) {
          return true;
        }
      }

      // Проверяем, является ли элемент формой или частью формы
      return element.form !== undefined;
    }

    /**
     * Добавить селектор для игнорирования
     */
    addIgnoredSelector(selector) {
      if (!this.ignoredSelectors.includes(selector)) {
        this.ignoredSelectors.push(selector);
        this.log(`Добавлен игнорируемый селектор: ${selector}`);
      }
      return this;
    }

    /**
     * Удалить селектор из игнорируемых
     */
    removeIgnoredSelector(selector) {
      const index = this.ignoredSelectors.indexOf(selector);
      if (index !== -1) {
        this.ignoredSelectors.splice(index, 1);
        this.log(`Удален игнорируемый селектор: ${selector}`);
      }
      return this;
    }

    /**
     * Установить список игнорируемых селекторов
     */
    setIgnoredSelectors(selectors) {
      this.ignoredSelectors = [...selectors];
      this.log("Список игнорируемых селекторов обновлен");
      return this;
    }

    /**
     * Подписаться на нажатие клавиши
     * @param {string|string[]} key - клавиша или массив клавиш
     * @param {Function} handler - обработчик
     * @param {Object} options - опции
     * @param {boolean} options.ignoreIfInput - игнорировать если фокус в поле ввода (по умолчанию true)
     * @param {boolean} options.ignoreIfModal - игнорировать если открыто модальное окно
     * @param {Function} options.condition - дополнительное условие для выполнения
     */
    on(key, handler, options = {}) {
      if (Array.isArray(key)) {
        key.forEach((k) => this.on(k, handler, options));
        return this;
      }

      const keyId = key.toLowerCase();

      if (!this.keyHandlers.has(keyId)) {
        this.keyHandlers.set(keyId, []);
      }

      this.keyHandlers.get(keyId).push({
        handler,
        requireCtrl: options.ctrl || false,
        requireAlt: options.alt || false,
        requireShift: options.shift || false,
        requireMeta: options.meta || false,
        preventDefault: options.preventDefault || false,
        description: options.description || "",
        once: options.once || false,
        ignoreIfInput: options.ignoreIfInput !== false,
        ignoreIfModal: options.ignoreIfModal || false,
        condition: options.condition || null,
        ignoreSelectors: options.ignoreSelectors || [], // дополнительные селекторы для этого обработчика
      });

      this.log(`Добавлен обработчик для клавиши: ${keyId}`, options);
      return this;
    }

    /**
     * Подписаться на одноразовое нажатие
     */
    once(key, handler, options = {}) {
      return this.on(key, handler, { ...options, once: true });
    }

    /**
     * Отписаться от клавиши
     */
    off(key, handler) {
      const keyId = key.toLowerCase();

      if (this.keyHandlers.has(keyId)) {
        if (handler) {
          const handlers = this.keyHandlers.get(keyId);
          const index = handlers.findIndex((h) => h.handler === handler);
          if (index !== -1) {
            handlers.splice(index, 1);
            this.log(`Удален обработчик для клавиши: ${keyId}`);
          }
        } else {
          this.keyHandlers.delete(keyId);
          this.log(`Удалены все обработчики для клавиши: ${keyId}`);
        }
      }
      return this;
    }

    /**
     * Очистить все обработчики
     */
    clearAllHandlers() {
      this.keyHandlers.clear();
      this.log("Все обработчики удалены");
    }

    /**
     * Получить список всех зарегистрированных горячих клавиш
     */
    getRegisteredKeys() {
      const keys = [];
      for (const [keyId, handlers] of this.keyHandlers) {
        handlers.forEach((h) => {
          keys.push({
            key: keyId,
            modifiers: {
              ctrl: h.requireCtrl,
              alt: h.requireAlt,
              shift: h.requireShift,
              meta: h.requireMeta,
            },
            description: h.description,
            ignoreIfInput: h.ignoreIfInput,
            ignoreIfModal: h.ignoreIfModal,
          });
        });
      }
      return keys;
    }

    /**
     * Показать справку по горячим клавишам
     */
    showHelp() {
      // TODO(Kolovatoff): добавить открытие modal
      console.log("=== Зарегистрированные горячие клавиши ===");
      const keys = this.getRegisteredKeys();
      if (keys.length === 0) {
        console.log("Нет зарегистрированных клавиш");
      } else {
        keys.forEach((k) => {
          const modifiers = [];
          if (k.modifiers.ctrl) modifiers.push("Ctrl");
          if (k.modifiers.alt) modifiers.push("Alt");
          if (k.modifiers.shift) modifiers.push("Shift");
          if (k.modifiers.meta) modifiers.push("Meta");

          const modifierStr =
            modifiers.length > 0 ? modifiers.join("+") + "+" : "";
          const flags = [];
          if (k.ignoreIfInput) flags.push("🚫 input");
          console.log(
            `  ${modifierStr}${k.key.toUpperCase()} - ${k.description || "нет описания"} ${flags.length ? `(${flags.join(", ")})` : ""}`,
          );
        });
      }
    }

    /**
     * Проверяет, можно ли выполнить обработчик
     */
    canExecuteHandler(item, event) {
      // Проверка на фокус в поле ввода
      if (item.ignoreIfInput) {
        const activeElement = document.activeElement;
        if (this.isIgnoredElement(activeElement)) {
          this.log(`Игнорируем: фокус в поле ввода (${activeElement.tagName})`);

          // Дополнительно проверяем игнорируемые селекторы для этого обработчика
          if (item.ignoreSelectors && item.ignoreSelectors.length > 0) {
            for (const selector of item.ignoreSelectors) {
              if (activeElement.matches && activeElement.matches(selector)) {
                return false;
              }
            }
          }

          return false;
        }
      }

      if (item.ignoreIfModal) {
        const modal = document.querySelector(
          '.modal[style*="display: block"], .modal.show, [role="dialog"][aria-hidden="false"]',
        );
        if (modal) {
          this.log("Игнорируем: открыто модальное окно");
          return false;
        }
      }

      if (item.condition && typeof item.condition === "function") {
        if (!item.condition(event)) {
          this.log("Игнорируем: не выполнено пользовательское условие");
          return false;
        }
      }

      return true;
    }

    handleKeyDown(event) {
      const code = event.code.toLowerCase();
      const key = event.key.toLowerCase();

      const ctrl = event.ctrlKey;
      const alt = event.altKey;
      const shift = event.shiftKey;
      const meta = event.metaKey;

      this.modifiers = { ctrl, alt, shift, meta };

      this.hideCursor();

      if (this.cursorSettings.mouseInactivityTimeout > 0) {
        clearTimeout(this.mouseMoveTimer);
      }

      let handlerExecuted = false;

      // Проверяем обработчики по CODE
      if (this.keyHandlers.has(code)) {
        handlerExecuted =
          this.executeHandlers(code, event, ctrl, alt, shift, meta) ||
          handlerExecuted;
      }

      // Проверяем обработчики по KEY
      if (this.keyHandlers.has(key) && code !== key) {
        handlerExecuted =
          this.executeHandlers(key, event, ctrl, alt, shift, meta) ||
          handlerExecuted;
      }

      this.log(
        `Нажата: code=${code}, key=${key}, выполнен=${handlerExecuted}, activeElement=${document.activeElement?.tagName}`,
      );
    }

    /**
     * Выполнить обработчики для указанного идентификатора клавиши
     */
    executeHandlers(keyId, event, ctrl, alt, shift, meta) {
      if (!this.keyHandlers.has(keyId)) return false;

      const handlers = this.keyHandlers.get(keyId);
      let executed = false;

      for (let i = 0; i < handlers.length; i++) {
        const item = handlers[i];

        if (
          item.requireCtrl === ctrl &&
          item.requireAlt === alt &&
          item.requireShift === shift &&
          item.requireMeta === meta
        ) {
          if (!this.canExecuteHandler(item, event)) {
            continue;
          }

          this.log(`Выполняется действие для: ${keyId}`, {
            modifiers: this.modifiers,
            ignoreIfInput: item.ignoreIfInput,
          });

          if (item.preventDefault) {
            event.preventDefault();
          }

          // Вызываем обработчик с расширенной информацией
          item.handler(event, {
            ...this.modifiers,
            code: event.code.toLowerCase(),
            key: event.key.toLowerCase(),
            activeElement: document.activeElement,
            isInInput: this.isIgnoredElement(document.activeElement),
          });

          executed = true;

          // Если одноразовый - удаляем
          if (item.once) {
            handlers.splice(i, 1);
            i--;
          }
        }
      }

      return executed;
    }

    handleKeyUp(event) {
      this.modifiers = {
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        meta: event.metaKey,
      };
    }

    handleMouseMove() {
      this.showCursor();

      if (this.cursorSettings.mouseInactivityTimeout > 0) {
        clearTimeout(this.mouseMoveTimer);
        this.mouseMoveTimer = setTimeout(() => {
          this.hideCursor();
        }, this.cursorSettings.mouseInactivityTimeout);
      }
    }

    handleMouseAction() {
      this.showCursor();
    }

    handleWindowBlur() {
      this.showCursor();
      this.modifiers = { ctrl: false, alt: false, shift: false, meta: false };
    }

    log(message, data = null) {
      if (this.debug) {
        if (data) {
          console.log(`[InputManager] ${message}`, data);
        } else {
          console.log(`[InputManager] ${message}`);
        }
      }
    }

    /**
     * Очистка ресурсов
     */
    destroy() {
      document.removeEventListener("keydown", this.handleKeyDown);
      document.removeEventListener("keyup", this.handleKeyUp);
      document.removeEventListener("mousemove", this.handleMouseMove);
      document.removeEventListener("mousedown", this.handleMouseAction);
      document.removeEventListener("mouseup", this.handleMouseAction);
      document.removeEventListener("wheel", this.handleMouseAction);
      window.removeEventListener("blur", this.handleWindowBlur);

      clearTimeout(this.mouseMoveTimer);
      this.showCursor();
      this.keyHandlers.clear();

      this.log("InputManager уничтожен");
    }
  }

  /**
   * Translates the browser Gamepad API's standard layout to the keyboard
   * controls already understood by Lampa. Chromium normalizes Xbox,
   * PlayStation, Switch Pro and most generic controllers to this layout.
   */
  class GamepadManager {
    constructor() {
      this.animationFrame = null;
      this.buttonStates = new Map();
      this.deadzone = 0.55;
      this.repeatDelay = 420;
      this.repeatInterval = 110;

      this.buttonMap = {
        0: { key: "Enter", code: "Enter", keyCode: 13 }, // A / Cross
        1: {
          key: "Backspace",
          code: "Backspace",
          keyCode: 8,
          fallback: "back",
        }, // B / Circle
        2: { action: "virtual-backspace" }, // X / Square
        3: { key: "s", code: "KeyS", keyCode: 83 }, // Y / Triangle
        4: { key: "PageUp", code: "PageUp", keyCode: 33 }, // LB / L1
        5: { key: "PageDown", code: "PageDown", keyCode: 34 }, // RB / R1
        8: {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          fallback: "back",
        }, // View / Share
        9: { key: "m", code: "KeyM", keyCode: 77 }, // Menu / Options
        12: { key: "ArrowUp", code: "ArrowUp", keyCode: 38, repeat: true },
        13: { key: "ArrowDown", code: "ArrowDown", keyCode: 40, repeat: true },
        14: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, repeat: true },
        15: {
          key: "ArrowRight",
          code: "ArrowRight",
          keyCode: 39,
          repeat: true,
        },
      };

      this.axisMap = [
        {
          axis: 0,
          direction: -1,
          key: "ArrowLeft",
          code: "ArrowLeft",
          keyCode: 37,
        },
        {
          axis: 0,
          direction: 1,
          key: "ArrowRight",
          code: "ArrowRight",
          keyCode: 39,
        },
        {
          axis: 1,
          direction: -1,
          key: "ArrowUp",
          code: "ArrowUp",
          keyCode: 38,
        },
        {
          axis: 1,
          direction: 1,
          key: "ArrowDown",
          code: "ArrowDown",
          keyCode: 40,
        },
      ];

      this.poll = this.poll.bind(this);
      this.handleDisconnect = this.handleDisconnect.bind(this);
      this.handlePhysicalKeyboard = this.handlePhysicalKeyboard.bind(this);
      this.handlePointerInput = this.handlePointerInput.bind(this);
      window.addEventListener("gamepaddisconnected", this.handleDisconnect);
      window.addEventListener("keydown", this.handlePhysicalKeyboard, true);
      window.addEventListener("pointerdown", this.handlePointerInput, true);
      this.animationFrame = requestAnimationFrame(this.poll);
    }

    selectKeyboardFor(device) {
      // Lampa chooses between two different keyboard implementations while
      // creating an input form. Changing keyboard_type after that also
      // changes global layout classes and breaks plugin input screens.
      if (this.isInputFormOpen()) return;

      const setting =
        device === "gamepad"
          ? "desktop_keyboard_gamepad"
          : "desktop_keyboard_regular";
      const fallback = device === "gamepad" ? "lampa" : "integrate";
      const type = normalizeKeyboardType(
        Lampa.Storage.get(setting, fallback),
        fallback,
      );
      Lampa.Storage.set("keyboard_type", type);
    }

    isInputFormOpen() {
      return Boolean(
        document.querySelector(".simple-keyboard") ||
        document.body.classList.contains("keyboard-input--visible"),
      );
    }

    handlePhysicalKeyboard(event) {
      if (!event.isTrusted) return;

      if (event.key === "Escape" && this.isInputFormOpen()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        Lampa.Controller.back();
        return;
      }

      this.selectKeyboardFor("regular");
    }

    handlePointerInput(event) {
      if (event.isTrusted) this.selectKeyboardFor("regular");
    }

    isTextInputFocused() {
      const element = document.activeElement;
      return (
        !!element &&
        (element.matches("input, textarea, select") ||
          element.isContentEditable)
      );
    }

    resolveButtonBinding(index, binding) {
      if (index === "1" && this.isInputFormOpen()) {
        return { action: "close-input-form" };
      }

      // Backspace edits text instead of navigating back while an input has
      // focus. Escape is the conventional way to close these Lampa screens.
      if (index === "1" && this.isTextInputFocused()) {
        return {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          fallback: binding.fallback,
        };
      }

      return binding;
    }

    dispatch(type, binding) {
      if (binding.action === "close-input-form") {
        if (type === "keydown") Lampa.Controller.back();
        return;
      }

      if (binding.action === "virtual-backspace") {
        if (type !== "keydown") return;
        const button = document.querySelector(".hg-button-BKSP");
        if (button) {
          const keyboard = button.closest(".simple-keyboard");
          const previous = keyboard?.querySelector(".selector.focus");
          button.dispatchEvent(
            new CustomEvent("hover:enter", {
              bubbles: true,
              detail: { target: button },
            }),
          );
          if (previous && previous !== button) {
            setTimeout(function () {
              Lampa.Controller.collectionFocus(previous, keyboard);
            }, 0);
          }
        }
        return;
      }

      if (type === "keydown") this.selectKeyboardFor("gamepad");

      const event = new KeyboardEvent(type, {
        key: binding.key,
        code: binding.code,
        bubbles: true,
        cancelable: true,
      });

      // Some Lampa versions still inspect the legacy numeric fields.
      Object.defineProperties(event, {
        keyCode: { get: () => binding.keyCode },
        which: { get: () => binding.keyCode },
      });
      // Native keyboard events originate on the focused element. Dispatching
      // there is important because Lampa's input component handles keyup on
      // the input itself to blur it and move to the surrounding controls.
      const target = document.activeElement || document;
      target.dispatchEvent(event);

      // Some plugin input screens temporarily disable Lampa.Keypad. Its
      // normal back handler prevents the event's default action, so only use
      // the controller fallback when the synthetic key was left unhandled.
      if (
        type === "keydown" &&
        binding.fallback === "back" &&
        !event.defaultPrevented &&
        window.Lampa?.Controller?.back
      ) {
        window.Lampa.Controller.back();
      }
    }

    updateControl(id, pressed, binding, now, canRepeat) {
      const state = this.buttonStates.get(id);

      if (pressed && !state) {
        this.buttonStates.set(id, {
          nextRepeat: now + this.repeatDelay,
          binding,
        });
        this.dispatch("keydown", binding);
      } else if (pressed && state && canRepeat && now >= state.nextRepeat) {
        state.nextRepeat = now + this.repeatInterval;
        this.dispatch("keydown", binding);
      } else if (!pressed && state) {
        this.dispatch("keyup", state.binding);
        this.buttonStates.delete(id);
      }
    }

    poll(now) {
      const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const gamepad of gamepads) {
        if (!gamepad || !gamepad.connected) continue;

        for (const [index, binding] of Object.entries(this.buttonMap)) {
          const button = gamepad.buttons[Number(index)];
          const resolvedBinding = this.resolveButtonBinding(index, binding);
          this.updateControl(
            `${gamepad.index}:button:${index}`,
            !!button && (button.pressed || button.value > 0.5),
            resolvedBinding,
            now,
            !!resolvedBinding.repeat,
          );
        }

        for (const binding of this.axisMap) {
          const value = gamepad.axes[binding.axis] || 0;
          const pressed = value * binding.direction > this.deadzone;
          const id = `${gamepad.index}:axis:${binding.axis}:${binding.direction}`;
          this.updateControl(id, pressed, binding, now, true);
        }
      }

      this.animationFrame = requestAnimationFrame(this.poll);
    }

    handleDisconnect(event) {
      const prefix = `${event.gamepad.index}:`;
      for (const [id, state] of this.buttonStates) {
        if (id.startsWith(prefix)) {
          this.dispatch("keyup", state.binding);
          this.buttonStates.delete(id);
        }
      }
    }

    destroy() {
      cancelAnimationFrame(this.animationFrame);
      window.removeEventListener("gamepaddisconnected", this.handleDisconnect);
      window.removeEventListener("keydown", this.handlePhysicalKeyboard, true);
      window.removeEventListener("pointerdown", this.handlePointerInput, true);
      this.buttonStates.clear();
    }
  }

  function initInputManager() {
    const input = new InputManager({
      hideOnKeyPress: true,
      showOnMouseMove: true,
    });

    input
      .on(
        "keys",
        (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          setTimeout(function () {
            Lampa.Search.open();
          }, 0);
        },
        {
          description: Lampa.Lang.translate("hotkey_search"),
          preventDefault: true,
          condition: () => {
            const active = document.activeElement;
            const textInputActive =
              active &&
              (active.matches("input, textarea, select") ||
                active.isContentEditable);

            return !(
              document.body.classList.contains("search--open") ||
              document.body.classList.contains("keyboard-input--visible") ||
              textInputActive ||
              !!document.body.querySelector(
                "div.modal, .simple-keyboard, [contenteditable='true']",
              )
            );
          },
        },
      )
      .on(
        "keyf",
        () => {
          Lampa.Utils.toggleFullscreen();
        },
        {
          description: Lampa.Lang.translate("hotkey_fullscreen"),
        },
      )
      .on(
        "f4",
        () => {
          window.electronAPI.closeApp();
        },
        {
          description: Lampa.Lang.translate("hotkey_close"),
          alt: true,
          ignoreIfInput: false,
        },
      )
      // открытие/закрытие меню
      .on(
        "keym",
        () => {
          Lampa.Menu.toggle();
        },
        {
          description: Lampa.Lang.translate("hotkey_menu"),
        },
      );
  }

  function initGamepadManager() {
    // The welcome/language screen is shown before Lampa's `appready` event,
    // so gamepad navigation must start as soon as the desktop plugin loads.
    if (window.appGamepadManager) window.appGamepadManager.destroy();
    window.appGamepadManager = new GamepadManager();
  }

  function overwriteToggleFullscreen() {
    Lampa.Utils.toggleFullscreen = function () {
      window.electronAPI.toggleFullscreen();
    };
  }

  function init() {
    overwriteToggleFullscreen(); // Переопределение функции Utils.toggleFullscreen
    addQuitButton(); // Кнопка выхода в шапке
    addAppSettings(); // Настройки приложения внутри лампы
    initInputManager();
  }

  initUaPlayerSessionIntegration();

  if (!window.plugin_app_ready) {
    window.plugin_app_ready = true;
    initGamepadManager();

    if (window.appready) {
      init();
    } else {
      Lampa.Listener.follow("app", function (e) {
        if (e.type === "ready") init();
      });
    }
  }
})();
