function formatTime(value) {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const pad = (number) => String(number).padStart(2, "0");
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
    : `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

function createSeekGesture({ commit, preview }) {
  let pointer = null;
  let clickPointer = null;
  const clamp = (value) => Math.max(0, Math.min(1, value));
  return {
    begin(id, fraction) {
      if (pointer !== null || !Number.isFinite(fraction)) return false;
      pointer = id;
      clickPointer = id;
      preview(clamp(fraction));
      return true;
    },
    move(id, fraction) {
      if (pointer === id && Number.isFinite(fraction)) preview(clamp(fraction));
    },
    end(id, fraction) {
      if (pointer !== id || !Number.isFinite(fraction)) return;
      pointer = null;
      preview(clamp(fraction));
      commit(clamp(fraction));
    },
    cancel() {
      pointer = null;
    },
    clearClick() {
      clickPointer = null;
    },
    consumeClick(id) {
      if (clickPointer === null || (id !== undefined && id !== clickPointer))
        return false;
      clickPointer = null;
      return true;
    },
  };
}

function bufferState(event) {
  const cache = event?.cache;
  if (
    !cache ||
    !Array.isArray(cache.Readers) ||
    cache.Readers.length !== 1 ||
    !cache.Pieces ||
    typeof cache.Pieces !== "object"
  )
    return null;
  const { Reader: start, End: end } = cache.Readers[0] || {};
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end - start > 100000
  )
    return null;
  let loaded = 0;
  while (
    loaded < end - start &&
    cache.Pieces[start + loaded]?.Completed === true
  )
    loaded++;
  return { percent: Math.round((loaded / (end - start)) * 100), readers: 1 };
}

function installTimelineControls(Lampa) {
  if (Lampa.__lampauaTimeline || !Lampa.PlayerPanel?.render) return;
  Lampa.__lampauaTimeline = true;
  const style = document.createElement("style");
  style.textContent = `
    .lampaua-preview { position:absolute; bottom:calc(100% + 16px); width:240px; max-width:100%;
      box-sizing:border-box; padding:6px; border:1px solid #e3b62f; border-radius:8px;
      background:#18212eee; color:#fff; text-align:center; pointer-events:none; z-index:15;
      font:16px/24px sans-serif; letter-spacing:0; }
    .lampaua-preview canvas { display:block; width:100%; height:126px; object-fit:contain; background:#000; border-radius:4px; }
    .lampaua-preview canvas[hidden] { display:block; visibility:hidden; }
    .lampaua-preview.time-only canvas { display:none; }
    .lampaua-preview [hidden], .lampaua-preview[hidden], .lampaua-seek-target[hidden], .lampaua-torrent-buffer[hidden] { display:none; }
    .lampaua-seek-target { position:absolute; top:-6px; bottom:-6px; width:2px; background:#e3b62f; pointer-events:none; z-index:4; }
    .lampaua-torrent-buffer { position:absolute; left:50%; transform:translateX(-50%); max-width:40%;
      font:14px/20px sans-serif; color:#b9e6d1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  `;
  document.head.appendChild(style);
  let track, bubble, canvas, caption, marker, badge;
  let active = null,
    pointer = null,
    generation = 0,
    bucket = null,
    timer,
    holdTimer,
    expiry;
  const videoNow = () => Lampa.PlayerVideo.video();
  const isSeekable = (video) =>
    video &&
    typeof video.requestPreview === "function" &&
    Number.isFinite(video.duration) &&
    video.duration > 0 &&
    !Lampa.Player.playdata()?.iptv;
  function ensure(target) {
    if (track === target && bubble?.isConnected) return;
    bubble?.remove();
    marker?.remove();
    badge?.remove();
    track = target;
    bubble = document.createElement("div");
    bubble.className = "lampaua-preview";
    bubble.hidden = true;
    canvas = document.createElement("canvas");
    canvas.hidden = true;
    caption = document.createElement("div");
    caption.className = "lampaua-preview__time";
    // Lampa overrides Element.append with a single-argument implementation.
    bubble.appendChild(canvas);
    bubble.appendChild(caption);
    marker = document.createElement("div");
    marker.className = "lampaua-seek-target";
    marker.hidden = true;
    track.appendChild(bubble);
    track.appendChild(marker);
    badge = document.createElement("span");
    badge.className = "lampaua-torrent-buffer";
    badge.title = "Буфер читача TorrServer";
    badge.hidden = true;
    track.parentElement
      .querySelector(".player-panel__line-one")
      ?.appendChild(badge);
  }
  function dismiss() {
    generation++;
    clearTimeout(timer);
    bucket = null;
    active?.video.cancelPreview?.();
    if (bubble) bubble.hidden = true;
    if (marker) marker.hidden = true;
  }
  function cancel() {
    gesture.cancel();
    clearInterval(holdTimer);
    holdTimer = null;
    if (active) {
      active.video.rewind = false;
      active.video.removeEventListener("emptied", cancel);
    }
    const old = pointer;
    pointer = null;
    dismiss();
    if (old !== null && track?.hasPointerCapture(old))
      track.releasePointerCapture(old);
    active = null;
  }
  function activate(next) {
    if (
      active &&
      (active.video !== next.video || active.source !== next.source)
    )
      cancel();
    active = next;
    active.video.addEventListener("emptied", cancel);
    if (!holdTimer)
      holdTimer = setInterval(() => {
        if (
          !active ||
          document.hidden ||
          !track?.isConnected ||
          videoNow() !== active.video ||
          active.video.src !== active.source
        ) {
          cancel();
          return;
        }
        // Lampa auto-hides after three seconds, including stationary hover.
        Lampa.PlayerPanel.mousemove?.();
      }, 1000);
  }
  function hint(fraction) {
    const { video, source } = active;
    if (videoNow() !== video || video.src !== source) {
      cancel();
      return;
    }
    const seconds = Math.min(
      Math.max(0, video.duration - 0.1),
      fraction * video.duration,
    );
    caption.textContent = formatTime(seconds);
    bubble.hidden = false;
    const width = track.getBoundingClientRect().width;
    bubble.style.left = `${Math.max(0, Math.min(width - bubble.offsetWidth, fraction * width - bubble.offsetWidth / 2))}px`;
    marker.hidden = false;
    marker.style.left = `${fraction * 100}%`;
    Lampa.PlayerPanel.mousemove?.();
    const next = Math.floor(seconds);
    if (next === bucket) return;
    dismissRequest();
    bucket = next;
    canvas.hidden = true;
    bubble.classList.remove("time-only");
    const token = generation;
    timer = setTimeout(async () => {
      try {
        const frame = await video.requestPreview(seconds);
        if (
          token !== generation ||
          videoNow() !== video ||
          video.src !== source
        )
          return;
        if (!frame) {
          bubble.classList.add("time-only");
          return;
        }
        canvas.width = frame.width;
        canvas.height = frame.height;
        canvas
          .getContext("2d")
          .putImageData(
            new ImageData(
              new Uint8ClampedArray(frame.rgba),
              frame.width,
              frame.height,
            ),
            0,
            0,
          );
        canvas.hidden = false;
      } catch {
        /* Time preview remains available when a frame cannot be decoded. */
        if (token === generation) bubble.classList.add("time-only");
      }
    }, 250);
  }
  function dismissRequest() {
    generation++;
    clearTimeout(timer);
    active?.video.cancelPreview?.();
  }
  const gesture = createSeekGesture({
    preview: hint,
    commit(fraction) {
      if (
        active &&
        videoNow() === active.video &&
        active.video.src === active.source
      )
        active.video.currentTime = Math.min(
          Math.max(0, active.video.duration - 0.1),
          fraction * active.video.duration,
        );
    },
  });
  const fraction = (event) => {
    const rect = track.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)),
    );
  };
  function context(event) {
    const video = videoNow();
    if (!isSeekable(video)) return null;
    const target = event.target.closest?.(".player-panel__timeline");
    if (!target) return null;
    ensure(target);
    return { video, source: video.src };
  }
  const stop = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      gesture.clearClick();
      if (pointer !== null) return;
      const next = context(event);
      if (!next) return;
      activate(next);
      pointer = event.pointerId;
      active.video.rewind = true;
      gesture.begin(pointer, fraction(event));
      track.setPointerCapture(pointer);
      stop(event);
    },
    true,
  );
  document.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType !== "mouse") return;
      if (pointer !== null) {
        if (pointer !== event.pointerId) return;
        gesture.move(pointer, fraction(event));
        stop(event);
      } else {
        const next = context(event);
        if (!next) {
          cancel();
          return;
        }
        activate(next);
        hint(fraction(event));
      }
    },
    true,
  );
  document.addEventListener(
    "pointerup",
    (event) => {
      if (pointer === null || pointer !== event.pointerId) return;
      const rect = track.getBoundingClientRect();
      const stillOverTrack =
        event.clientX >= rect.left &&
        event.clientX <= rect.left + rect.width &&
        event.clientY >= rect.top &&
        event.clientY <= rect.top + rect.height;
      gesture.end(pointer, fraction(event));
      cancel();
      if (stillOverTrack) {
        const next = context(event);
        if (next) {
          activate(next);
          hint(fraction(event));
        }
      }
      stop(event);
    },
    true,
  );
  document.addEventListener(
    "pointerout",
    (event) => {
      if (
        event.pointerType === "mouse" &&
        pointer === null &&
        active &&
        !track?.contains(event.relatedTarget)
      )
        cancel();
    },
    true,
  );
  for (const name of ["pointercancel", "lostpointercapture"])
    document.addEventListener(
      name,
      (event) => {
        if (event.pointerId === pointer) cancel();
      },
      true,
    );
  document.addEventListener(
    "click",
    (event) => {
      if (
        event.detail > 0 &&
        event.pointerType !== "touch" &&
        (gesture.consumeClick(event.pointerId) || context(event))
      )
        stop(event);
    },
    true,
  );
  document.addEventListener(
    "mousemove",
    (event) => {
      if (context(event)) event.stopImmediatePropagation();
    },
    true,
  );
  window.addEventListener("blur", cancel);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancel();
  });
  const reset = () => {
    cancel();
    if (badge) badge.hidden = true;
    clearTimeout(expiry);
  };
  Lampa.Player.listener.follow("destroy", reset);
  Lampa.Player.listener.follow("start", reset);
  Lampa.PlayerVideo.listener?.follow("destroy", reset);
  Lampa.PlayerInfo?.listener.follow("stat", (event) => {
    const target = Lampa.PlayerPanel.render()?.[0]?.querySelector(
      ".player-panel__timeline",
    );
    if (
      !target ||
      !isSeekable(videoNow()) ||
      !Lampa.Player.playdata()?.torrent_hash
    )
      return;
    ensure(target);
    const state = bufferState(event);
    badge.hidden = !state;
    if (state) badge.textContent = `TorrServer: ${state.percent}%`;
    clearTimeout(expiry);
    expiry = setTimeout(() => {
      if (badge) badge.hidden = true;
    }, 12000);
  });
}
module.exports = {
  createSeekGesture,
  formatTime,
  bufferState,
  installTimelineControls,
};
