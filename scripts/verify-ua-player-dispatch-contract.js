const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Executes the actual preload and renderer adapter together, without Electron,
// a media engine or network. This is dispatch-contract evidence, not playback QA.
const root = path.resolve(__dirname, "..");
const timers = new Map();
const microtasks = [];
let nextTimer = 0;
const sent = [];
const ipcListeners = new Map();
const window = { plugin_app_ready: true };
const scheduling = {
  queueMicrotask(callback) {
    microtasks.push(callback);
  },
  setTimeout(callback, delay) {
    const id = ++nextTimer;
    timers.set(id, { callback, delay });
    return id;
  },
  clearTimeout(id) {
    timers.delete(id);
  },
};
function flushTurn() {
  while (microtasks.length) microtasks.shift()();
  for (const [id, timer] of [...timers]) {
    if (timer.delay !== 0) continue;
    timers.delete(id);
    timer.callback();
  }
}
const ipcRenderer = {
  send(channel, ...args) {
    sent.push({ channel, args });
  },
  on(channel, handler) {
    ipcListeners.set(channel, handler);
  },
  once(channel, handler) {
    ipcListeners.set(channel, handler);
  },
  removeListener(channel, handler) {
    if (ipcListeners.get(channel) === handler) ipcListeners.delete(channel);
  },
};
vm.runInNewContext(fs.readFileSync(path.join(root, "src/preload.js"), "utf8"), {
  ...scheduling,
  console,
  require(name) {
    if (name !== "electron") return require(name);
    return {
      ipcRenderer,
      contextBridge: {
        exposeInMainWorld(name, value) {
          window[name] = value;
        },
      },
    };
  },
});
let selectedPath = "C:\\Program Files\\UA Player\\UAPlayer.exe";
let activeCard = { id: 125988, name: "Бункер", media_type: "tv" };
const listeners = new Map();
let nativeSubtitlesCalls = 0;
let nativePlaylistCalls = 0;
const Lampa = {
  Player: {
    listener: {
      follow(name, handler) {
        listeners.set(name, handler);
      },
      send(name, data) {
        listeners.get(name)?.(data);
      },
    },
    subtitles() {
      nativeSubtitlesCalls++;
      return "subtitles-result";
    },
    playlist() {
      nativePlaylistCalls++;
      return "playlist-result";
    },
  },
  Storage: {
    field(key) {
      return key === "player_nw_path" ? selectedPath : "1080";
    },
  },
  Activity: {
    active() {
      return { card: activeCard };
    },
  },
  Timeline: {
    view() {
      return { time: 42, duration: 120 };
    },
  },
  Torserver: {
    toPlayUrl(url) {
      return url.replace("&preload", "&play");
    },
  },
};
window.Lampa = Lampa;
vm.runInNewContext(fs.readFileSync(path.join(root, "src/plugin.js"), "utf8"), {
  ...scheduling,
  window,
  Lampa,
  console,
});
const spawn = window.require("child_process").spawn;
const spawns = () =>
  sent.filter((message) => message.channel === "child-process-spawn");
const sessionAt = (index) => spawns()[index].args[4]?.uaPlayerSession;
function dispatch(data, create = true) {
  if (create) Lampa.Player.listener.send("create", { data });
  // Lampa's desktop branch emits external AFTER calling spawn.
  const child = spawn(selectedPath, [
    encodeURI(Lampa.Torserver.toPlayUrl(data.url)),
  ]);
  Lampa.Player.listener.send("external", data);
  return child;
}

let returnedTimeline;
const current = {
  url: "https://stream.example.test/initial.m3u8",
  timeline: {
    hash: "episode-2",
    time: 3,
    handler(...values) {
      returnedTimeline = values;
    },
  },
};
Lampa.Player.listener.send("create", { data: current });
current.url = "https://stream.example.test/selected.m3u8?token=a%2Fb";
current.quality = {
  "720p": "https://stream.example.test/720.m3u8",
  "1080p": current.url,
};
dispatch(current, false);
assert.equal(
  spawns().length,
  0,
  "UA dispatch must wait for Lampa's external event",
);
assert.equal(
  Lampa.Player.playlist([
    { url: "https://stream.example.test/first.m3u8", episode: 1 },
    { url: current.url, episode: 2, subtitles: [] },
  ]),
  "playlist-result",
);
assert.equal(
  Lampa.Player.subtitles([
    { url: "https://sub.example.test/uk.vtt", language: "uk" },
  ]),
  "subtitles-result",
);
current._session_segments = [{ start: 5, end: 9, kind: "intro" }];
current.segments = [];
flushTurn();
const first = sessionAt(0);
assert.ok(first, "launch must contain a full session");
assert.equal(first.payload.items.length, 2);
assert.equal(first.payload.playlist_index, 1);
assert.equal(
  first.payload.items[1].url,
  current.url,
  "do not double encode signed URLs",
);
assert.equal(first.payload.items[1].tmdb_id, 125988);
assert.equal(first.payload.items[1].position_ms, 42000);
assert.equal(first.payload.items[1].subtitles[0].language, "uk");
assert.equal(first.payload.items[1].segments.length, 1);
assert.equal(
  first.payload.items[0].subtitles.length,
  0,
  "current subtitles must not leak to another episode",
);
assert.equal(nativeSubtitlesCalls, 1);
assert.equal(nativePlaylistCalls, 1);
ipcListeners.get("ua-player-session-result")(
  {},
  {
    sessionId: first.sessionId,
    result: {
      schema: "lampaua-player-result-v1",
      playlist_index: 1,
      position: 60000,
      duration: 120000,
    },
  },
);
assert.deepEqual(returnedTimeline, [50, 60, 120]);

// IPTV has no create event and must not inherit the previous movie/card.
dispatch(
  { url: "https://live.example.test/news.m3u8", iptv: true, title: "Новини" },
  false,
);
flushTurn();
assert.equal(sessionAt(1).payload.items[0].is_live, true);
assert.equal(sessionAt(1).payload.items[0].tmdb_id, undefined);
assert.equal(sessionAt(1).payload.items[0].subtitles.length, 0);

// Same-turn overlapping launches keep their own payload, even for the same URL.
activeCard = null;
dispatch({
  url: "https://stream.example.test/shared.m3u8",
  title: "A",
  card: { id: 1 },
});
dispatch({
  url: "https://stream.example.test/shared.m3u8",
  title: "B",
  card: { id: 2 },
});
flushTurn();
assert.equal(sessionAt(2).payload.items[0].tmdb_id, 1);
assert.equal(sessionAt(3).payload.items[0].tmdb_id, 2);

selectedPath = "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe";
dispatch({ url: "https://stream.example.test/vlc.m3u8" });
assert.equal(spawns().length, 5, "VLC must still dispatch synchronously");
assert.equal(spawns()[4].args.length, 4);

// An uncorrelated direct UA launch must fall back, never consume stale metadata.
selectedPath = "C:\\Program Files\\UA Player\\UAPlayer.exe";
spawn(selectedPath, ["https://stream.example.test/unmatched.m3u8"]);
flushTurn();
assert.equal(spawns()[5].args.length, 4);

// Preroll postpones external/spawn, not the synchronous metadata producers.
const preroll = { url: "https://stream.example.test/preroll.m3u8" };
Lampa.Player.listener.send("create", { data: preroll });
Lampa.Player.playlist([
  { url: preroll.url },
  { url: "https://stream.example.test/after.m3u8" },
]);
Lampa.Player.subtitles([{ url: "https://sub.example.test/preroll.vtt" }]);
flushTurn();
dispatch(preroll, false);
flushTurn();
assert.equal(sessionAt(6).payload.items.length, 2);
assert.equal(
  sessionAt(6).payload.items[0].subtitles[0].url,
  "https://sub.example.test/preroll.vtt",
);

// A previous film's async response must never be assigned to the new film.
dispatch({ url: "https://stream.example.test/new.m3u8" });
while (microtasks.length) microtasks.shift()();
Lampa.Player.subtitles([{ url: "https://sub.example.test/OLD.vtt" }]);
flushTurn();
assert.equal(sessionAt(7).payload.items[0].subtitles.length, 0);

// external without a real spawn (e.g. executable missing) expires this turn.
Lampa.Player.listener.send("external", {
  url: "https://stream.example.test/missing.m3u8",
  card: { id: 999 },
});
flushTurn();
spawn(selectedPath, ["https://stream.example.test/missing.m3u8"]);
flushTurn();
assert.equal(spawns()[8].args.length, 4);

dispatch({
  url: "https://stream.example.test/rich.m3u8",
  url_reserve: "https://proxy.example.test/rich.m3u8",
  quality: {
    "4K": {
      url: "https://stream.example.test/4k.m3u8",
      id: "uhd",
      width: 3840,
      height: 2160,
      bitrate: 14000000,
      headers: { Referer: "https://origin.example.test/" },
    },
  },
  subtitles: [
    {
      url: "https://sub.example.test/rich.ass",
      id: "uk-forced",
      forced: true,
      format: "ass",
      headers: { Referer: "https://origin.example.test/" },
    },
  ],
  segments: [],
  _session_segments: [
    { id: "opening", start: 0, end: 30, mode: "ask", label: "Вступ" },
  ],
});
flushTurn();
const rich = sessionAt(9).payload.items[0];
assert.equal(rich.url_reserve, "https://proxy.example.test/rich.m3u8");
assert.equal(rich.quality["4K"].width, 3840);
assert.equal(
  rich.quality["4K"].headers.Referer,
  "https://origin.example.test/",
);
assert.equal(rich.subtitles[0].id, "uk-forced");
assert.equal(rich.subtitles[0].forced, true);
assert.equal(rich.subtitles[0].format, "ass");
assert.equal(rich.subtitles[0].headers.Referer, "https://origin.example.test/");
assert.equal(rich.segments[0].label, "Вступ");

dispatch({
  url: "https://stream.example.test/array.m3u8",
  qualities: [
    {
      label: "1080p",
      url: "https://stream.example.test/1080.m3u8",
      height: 1080,
    },
  ],
  subtitles: [
    { url: "https://sub.example.test/preferred.vtt", path: "C:\\stale.vtt" },
  ],
});
flushTurn();
assert.equal(sessionAt(10).payload.items[0].subtitles[0].path, undefined);
assert.equal(sessionAt(10).payload.items[0].quality["1080p"].height, 1080);

const cancelled = dispatch({ url: "https://stream.example.test/cancel.m3u8" });
const lifecycle = [];
cancelled.on("exit", (code, signal) => lifecycle.push(["exit", code, signal]));
cancelled.on("close", (code, signal) =>
  lifecycle.push(["close", code, signal]),
);
cancelled.kill("SIGTERM");
flushTurn();
assert.equal(
  spawns().length,
  11,
  "cancelled launch must not spawn a native process",
);
assert.deepEqual(lifecycle, [
  ["exit", null, "SIGTERM"],
  ["close", null, "SIGTERM"],
]);
console.log("UA Player actual preload/renderer dispatch contract verified");
