(function () {
  let cleanup = Promise.resolve();

  function createMpvVideo(onVideo) {
    const video = document.createElement("div");
    video.className = "player-video__video";
    const surface = document.createElement("mpv-video");
    surface.setAttribute("defer-init", "");
    surface.setAttribute("render-mode", "webgl");
    Object.assign(surface.style, { width: "100%", height: "100%" });
    video.append(surface);
    let source = "";
    let dead = false;
    let loaded = false;
    let paused = true;
    let ended = false;
    let time = 0;
    let duration = 0;
    let volume = 1;
    let muted = false;
    let speed = 1;
    let cache = 0;
    let pendingSeek = null;
    let commands = cleanup;
    let destroyPromise;
    let tracks = [];
    const emit = (type) => {
      if (!dead) video.dispatchEvent(new Event(type));
    };
    const fail = (error) => {
      if (dead) return;
      video.error = { code: 3, message: error?.message || String(error) };
      emit("error");
    };
    function queue(operation) {
      const next = commands.then(() => {
        if (!dead) return operation();
      });
      commands = next.catch(fail);
      return next;
    }
    const property = (name, get, set) =>
      Object.defineProperty(video, name, { configurable: true, get, set });
    property(
      "src",
      () => source,
      (value) => {
        source = String(value || "");
      },
    );
    property(
      "currentTime",
      () => time,
      (value) => {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds < 0) return;
        pendingSeek = seconds;
        time = seconds;
        if (loaded) {
          pendingSeek = null;
          void queue(() => surface.seek(seconds));
        }
      },
    );
    property("duration", () => duration);
    property("videoWidth", () => surface.videoWidth || 0);
    property("videoHeight", () => surface.videoHeight || 0);
    property("paused", () => paused);
    property("ended", () => ended);
    property(
      "volume",
      () => volume,
      (value) => {
        volume = Math.max(0, Math.min(1, Number(value) || 0));
        if (loaded)
          void queue(() => surface.setVolume(muted ? 0 : volume * 100));
      },
    );
    property(
      "muted",
      () => muted,
      (value) => {
        muted = Boolean(value);
        if (loaded)
          void queue(() => surface.setVolume(muted ? 0 : volume * 100));
      },
    );
    property(
      "playbackRate",
      () => speed,
      (value) => {
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0.25 || number > 4) return;
        speed = number;
        if (loaded) void queue(() => surface.setSpeed(speed));
      },
    );
    property("audioTracks", () =>
      tracks.filter((track) => track.type === "audio"),
    );
    property("textTracks", () =>
      tracks.filter((track) => track.type === "sub"),
    );
    property("buffered", () => ({
      length: cache > 0 ? 1 : 0,
      start: () => time,
      end: () => time + cache,
    }));
    video.load = () =>
      queue(async () => {
        if (!source) return;
        loaded = false;
        ended = false;
        duration = 0;
        time = 0;
        tracks = [];
        video.error = null;
        emit("waiting");
        await surface.open(source);
        if (dead) return;
        await surface.setVolume(muted ? 0 : volume * 100);
        await surface.setSpeed(speed);
      });
    video.play = () =>
      queue(async () => {
        await surface.play();
        paused = false;
        emit("play");
      });
    video.pause = () =>
      queue(async () => {
        await surface.pause();
        paused = true;
        emit("pause");
      });
    video.flush = () => commands;
    video.canPlayType = () => "probably";
    video.destroy = () => {
      if (destroyPromise) return destroyPromise;
      dead = true;
      surface.removeEventListener("mpv-event", onEvent);
      surface.removeEventListener("mpv-error", onError);
      destroyPromise = commands.catch(() => {}).then(() => surface.destroy());
      cleanup = destroyPromise.catch(() => {});
      return destroyPromise;
    };
    function setTracks(list) {
      const indices = { audio: 0, sub: 0 };
      tracks = list
        .filter((item) => item.type === "audio" || item.type === "sub")
        .map((item) => {
          let selected = Boolean(item.selected);
          const track = {
            id: item.id,
            type: item.type,
            index: indices[item.type]++,
            label: item.title || item.lang || `${item.type} ${item.id}`,
            language: item.lang || "",
          };
          function select(value) {
            if (!tracks.includes(track)) return;
            const enabled = Boolean(value);
            if (selected === enabled) return;
            if (enabled)
              for (const other of tracks)
                if (other !== track && other.type === track.type)
                  other.clearSelection();
            selected = enabled;
            const id = enabled ? track.id : "no";
            void queue(() =>
              track.type === "audio"
                ? surface.setAudioTrack(id)
                : surface.setSubtitleTrack(id),
            );
          }
          Object.defineProperties(track, {
            selected: { get: () => selected, set: select },
            enabled: { get: () => selected, set: select },
            mode: {
              get: () => (selected ? "showing" : "disabled"),
              set: (value) => {
                select(value === "showing");
              },
            },
            clearSelection: {
              value: () => {
                selected = false;
              },
            },
          });
          return track;
        });
      emit("mpv-tracks");
    }
    function onError(event) {
      fail(event.detail);
    }
    function onEvent(event) {
      if (dead) return;
      const value = event.detail;
      if (
        value.error ||
        value.type === "render-error" ||
        value.type === "event-error"
      ) {
        fail(value.error || value.data);
        return;
      }
      if (value.type === "file-loaded") {
        loaded = true;
        if (pendingSeek !== null) {
          const seconds = pendingSeek;
          pendingSeek = null;
          void queue(() => surface.seek(seconds));
        }
        emit("loadeddata");
        emit("canplay");
        emit("playing");
      }
      if (value.name === "time-pos" && typeof value.data === "number") {
        time = value.data;
        emit("timeupdate");
      }
      if (value.name === "duration" && typeof value.data === "number") {
        duration = value.data;
        emit("durationchange");
      }
      if (value.name === "pause") {
        paused = Boolean(value.data);
        emit(paused ? "pause" : "playing");
      }
      if (value.name === "track-list" && Array.isArray(value.data))
        setTracks(value.data);
      if (value.name === "demuxer-cache-duration") {
        cache = Math.max(0, Number(value.data) || 0);
        emit("progress");
      }
      if (value.name === "paused-for-cache")
        emit(value.data ? "waiting" : "playing");
      if (
        (value.name === "eof-reached" && value.data === true) ||
        (value.type === "end-file" && value.reason === 0)
      ) {
        if (!ended) {
          ended = true;
          paused = true;
          emit("ended");
        }
      }
    }
    surface.addEventListener("mpv-event", onEvent);
    surface.addEventListener("mpv-error", onError);
    onVideo(video);
    return video;
  }

  function installLampaMpvAdapter(Lampa, api) {
    if (!api || !Lampa.PlayerVideo?.registerTube || Lampa.__mpvInstalled)
      return;
    Lampa.__mpvInstalled = true;
    let pending;
    Lampa.Player.listener.follow("create", (event) => {
      pending = event.data;
    });
    Lampa.PlayerVideo.registerTube({
      name: "LampaUa libmpv",
      verify(src) {
        let url;
        try {
          url = new URL(src);
        } catch {
          return false;
        }
        if (
          !["http:", "https:"].includes(url.protocol) ||
          /(^|\.)(youtube\.com|youtu\.be)$/.test(url.hostname)
        )
          return false;
        const data = pending || Lampa.Player.playdata() || {};
        const choice =
          data.launch_player ||
          Lampa.Storage.field(data.torrent_hash ? "player_torrent" : "player");
        return choice === "inner" || choice === "lampa";
      },
      create(callback) {
        return createMpvVideo((video) => {
          video.addEventListener("mpv-tracks", () => {
            Lampa.PlayerVideo.listener.send("tracks", {
              tracks: video.audioTracks,
            });
            Lampa.PlayerVideo.listener.send("subs", { subs: video.textTracks });
          });
          callback(video);
        });
      },
    });
  }
  window.LampaUaMpvAdapter = { createMpvVideo, installLampaMpvAdapter };
})();
