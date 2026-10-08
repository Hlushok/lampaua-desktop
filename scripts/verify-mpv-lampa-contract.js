const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const file = path.resolve(__dirname, "../src/mpv/lampa-adapter.js");
assert.ok(fs.existsSync(file), "Lampa MPV facade is missing");
class Element extends EventTarget {
  constructor(tag) {
    super();
    this.tag = tag;
    this.style = {};
    this.attributes = {};
    this.calls = [];
  }
  append(...children) {
    this.children = children;
  }
  setAttribute(k, v) {
    this.attributes[k] = v;
  }
  async open(url) {
    this.calls.push(["open", url]);
    this.dispatchEvent(
      new CustomEvent("mpv-event", { detail: { type: "file-loaded" } }),
    );
    this.dispatchEvent(
      new CustomEvent("mpv-event", {
        detail: {
          type: "property-change",
          name: "track-list",
          data: [{ id: 10, type: "video" }],
        },
      }),
    );
  }
  async play() {
    this.calls.push(["play"]);
  }
  async pause() {
    this.calls.push(["pause"]);
  }
  async seek(value) {
    this.calls.push(["seek", value]);
  }
  async setVolume(value) {
    this.calls.push(["volume", value]);
  }
  async setSpeed(value) {
    this.calls.push(["speed", value]);
  }
  async setAudioTrack(value) {
    this.calls.push(["audio", value]);
  }
  async setSubtitleTrack(value) {
    this.calls.push(["sub", value]);
  }
  async destroy() {
    this.calls.push(["destroy"]);
  }
}
const document = { createElement: (tag) => new Element(tag) };
const window = {};
vm.runInNewContext(fs.readFileSync(file, "utf8"), {
  window,
  document,
  Event,
  CustomEvent,
  console,
  URL,
  setTimeout,
  clearTimeout,
  atob,
  btoa,
});
async function main() {
  const { createMpvVideo, installLampaMpvAdapter } = window.LampaUaMpvAdapter;
  let video;
  const element = createMpvVideo((value) => {
    video = value;
  });
  assert.equal(element, video);
  const surface = video.children[0];
  let loaded = 0;
  let ended = 0;
  video.addEventListener("loadeddata", () => loaded++);
  video.addEventListener("ended", () => ended++);
  video.volume = 0.37;
  video.src = "http://127.0.0.1:8090/movie";
  await video.load();
  assert.equal(loaded, 1);
  await video.play();
  await video.pause();
  assert.equal(video.paused, true);
  video.currentTime = 5;
  video.playbackRate = 1.5;
  video.muted = true;
  await video.flush();
  assert.ok(surface.calls.some(([k, v]) => k === "volume" && v === 0));
  video.muted = false;
  await video.flush();
  assert.ok(surface.calls.some(([k, v]) => k === "volume" && v === 37));
  assert.ok(surface.calls.some(([k, v]) => k === "seek" && v === 5));
  assert.ok(surface.calls.some(([k, v]) => k === "speed" && v === 1.5));
  const event = (name, data) =>
    surface.dispatchEvent(
      new CustomEvent("mpv-event", {
        detail: { type: "property-change", name, data },
      }),
    );
  event("track-list", [
    { id: 1, type: "audio", selected: true },
    { id: 2, type: "audio" },
    { id: 3, type: "sub" },
  ]);
  video.audioTracks[1].enabled = true;
  video.textTracks[0].mode = "showing";
  assert.equal(
    video.textTracks[0].index,
    0,
    "subtitle indices must be relative to subtitle list",
  );
  await video.flush();
  assert.equal(video.audioTracks[0].enabled, false);
  assert.ok(surface.calls.some(([k, v]) => k === "audio" && v === 2));
  assert.ok(surface.calls.some(([k, v]) => k === "sub" && v === 3));
  surface.dispatchEvent(
    new CustomEvent("mpv-event", { detail: { type: "end-file", reason: 2 } }),
  );
  assert.equal(ended, 0);
  event("eof-reached", true);
  assert.equal(ended, 1);
  event("time-pos", 10);
  event("demuxer-cache-duration", 15);
  assert.ok(
    video.buffered.start(0) < video.currentTime,
    "Lampa requires the buffered interval to include the current position",
  );
  surface.dispatchEvent(
    new CustomEvent("mpv-event", {
      detail: { type: "end-file", error: "HTTP 503" },
    }),
  );
  assert.equal(
    video.error.code,
    2,
    "HTTP errors are network failures, not decode failures",
  );
  assert.equal(video.error.message, "HTTP 503");
  surface.dispatchEvent(
    new CustomEvent("mpv-event", {
      detail: { type: "end-file", error: "unrecognized file format" },
    }),
  );
  assert.equal(video.error.code, 3);
  await video.destroy();
  await video.destroy();
  event("time-pos", 100);
  assert.notEqual(video.currentTime, 100);
  assert.equal(surface.calls.filter(([k]) => k === "destroy").length, 1);
  const late = createMpvVideo(() => {});
  const lateSurface = late.children[0];
  let lateLoaded = 0;
  late.addEventListener("loadeddata", () => lateLoaded++);
  lateSurface.open = async (url) => lateSurface.calls.push(["open", url]);
  late.src = "http://example.org/late";
  late.currentTime = 17;
  await late.load();
  assert.equal(late.duration, 0);
  assert.ok(!lateSurface.calls.some(([key]) => key === "seek"));
  const lateEvent = (detail) =>
    lateSurface.dispatchEvent(new CustomEvent("mpv-event", { detail }));
  lateEvent({ type: "file-loaded" });
  assert.equal(
    lateLoaded,
    0,
    "Loadeddata must wait for track metadata so Lampa restores saved selections",
  );
  lateEvent({ type: "property-change", name: "duration", data: 60 });
  lateEvent({
    type: "property-change",
    name: "track-list",
    data: [{ id: 7, type: "audio", selected: true }],
  });
  await late.flush();
  assert.equal(lateLoaded, 1);
  assert.ok(
    lateSurface.calls.some(([key, value]) => key === "seek" && value === 17),
  );
  assert.equal(late.duration, 60);
  const previousTrack = late.audioTracks[0];
  await late.load();
  assert.equal(late.audioTracks.length, 0);
  const beforeStale = lateSurface.calls.length;
  previousTrack.enabled = false;
  await late.flush();
  assert.equal(
    lateSurface.calls.length,
    beforeStale,
    "Previous-file track objects must be inert",
  );
  await late.destroy();
  const racing = createMpvVideo(() => {});
  const racingSurface = racing.children[0];
  let release;
  racingSurface.open = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  racing.src = "http://example.org/racing";
  const opening = racing.load();
  while (!release) await Promise.resolve();
  const closing = racing.destroy();
  const following = createMpvVideo(() => {});
  following.src = "http://example.org/following";
  const followingLoad = following.load();
  await Promise.resolve();
  assert.equal(
    following.children[0].calls.length,
    0,
    "Next player must wait for prior teardown",
  );
  release();
  await opening;
  await closing;
  await followingLoad;
  assert.equal(
    racingSurface.calls.filter(([key]) => key === "destroy").length,
    1,
  );
  await following.destroy();
  let registration;
  let createHook;
  let data = { launch_player: "other", torrent_hash: "hash" };
  const settings = { player: "inner", player_torrent: "inner" };
  const Lampa = {
    Player: {
      playdata: () => data,
      listener: {
        follow(name, callback) {
          if (name === "create") createHook = callback;
        },
      },
      runas() {},
      play(input) {
        createHook({ data: input });
        const custom = registration.verify(input.url);
        const external =
          Lampa.Storage.field(
            input.torrent_hash ? "player_torrent" : "player",
          ) === "other";
        delete input.launch_player;
        return custom
          ? "mpv"
          : external
            ? "external"
            : registration.verify(input.url)
              ? "mpv"
              : "html";
      },
    },
    Storage: { field: (key) => settings[key] },
    PlayerVideo: {
      registerTube: (value) => {
        registration = value;
      },
    },
  };
  installLampaMpvAdapter(Lampa, {});
  assert.equal(registration.verify("http://example.org/video"), false);
  data = { torrent_hash: "hash" };
  assert.equal(registration.verify("http://example.org/video"), true);
  settings.player_torrent = "other";
  assert.equal(registration.verify("http://example.org/video"), false);
  data.launch_player = "inner";
  assert.equal(registration.verify("https://youtube.com/watch?v=abc"), false);
  settings.player = "inner";
  settings.player_torrent = "inner";
  assert.equal(
    Lampa.Player.play({
      url: "http://example.org/video",
      launch_player: "other",
    }),
    "external",
    "Explicit external launch must win through the routing flow, not just the first predicate",
  );
  assert.equal(
    settings.player,
    "inner",
    "Per-launch overrides must not persist",
  );
  assert.equal(
    registration.verify("http://example.org/video"),
    false,
    "Deleted launch_player must not change the captured route",
  );
  console.log("MPV Lampa facade and routing contract verified");
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
