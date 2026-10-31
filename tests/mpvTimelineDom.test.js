const assert = require("node:assert/strict");
const test = require("node:test");
const { installTimelineControls } = require("../src/mpv/timeline-controls");

function harness() {
  const previous = { document: global.document, window: global.window };
  function bus() {
    const callbacks = new Map();
    return {
      follow: (name, fn) =>
        callbacks.set(name, [...(callbacks.get(name) || []), fn]),
      send: (name, data) =>
        (callbacks.get(name) || []).forEach((fn) => fn(data)),
    };
  }
  class Element {
    children = [];
    style = {};
    classList = { add() {}, remove() {} };
    offsetWidth = 240;
    isConnected = true;
    captured = new Set();
    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
    }
    remove() {
      this.isConnected = false;
    }
    closest() {
      return this;
    }
    contains(target) {
      for (let node = target; node; node = node.parentElement)
        if (node === this) return true;
      return false;
    }
    querySelector() {
      return new Element();
    }
    getBoundingClientRect() {
      return { left: 0, width: 1000, top: 500, height: 6 };
    }
    setPointerCapture(id) {
      this.captured.add(id);
    }
    hasPointerCapture(id) {
      return this.captured.has(id);
    }
    releasePointerCapture(id) {
      this.captured.delete(id);
    }
  }
  const events = bus();
  const track = new Element();
  track.parentElement = new Element();
  const document = {
    head: new Element(),
    createElement: () => new Element(),
    addEventListener: events.follow,
  };
  const window = { addEventListener() {} };
  Object.assign(global, { document, window });
  const video = Object.assign(new EventTarget(), {
    src: "https://example.org/video",
    duration: 100,
    requestPreview: async () => null,
    cancelPreview() {},
  });
  let current = video;
  let visible = false,
    hideTimer;
  const Lampa = {
    Player: { listener: bus(), playdata: () => ({}) },
    PlayerVideo: { listener: bus(), video: () => current },
    PlayerPanel: {
      render: () => [{ querySelector: () => track }],
      mousemove() {
        visible = true;
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          visible = false;
        }, 3000);
      },
      visibleStatus: () => visible,
    },
  };
  installTimelineControls(Lampa);
  const emit = (name, overrides = {}) => {
    const event = {
      target: track,
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      detail: 1,
      clientX: 500,
      clientY: 503,
      preventDefault() {
        this.prevented = true;
      },
      stopImmediatePropagation() {
        this.stopped = true;
      },
      ...overrides,
    };
    events.send(name, event);
    return event;
  };
  return {
    Lampa,
    video,
    track,
    emit,
    routeToBrowser: () => (current = {}),
    cleanup() {
      Lampa.Player.listener.send("destroy");
      clearTimeout(hideTimer);
      Object.assign(global, previous);
    },
  };
}
test("preview uses appendChild and resets immediately on PlayerVideo destruction/quality change", () => {
  const h = harness();
  try {
    h.emit("pointermove");
    const bubble = h.track.children.find(
      (child) => child.className === "lampaua-preview",
    );
    assert.equal(
      bubble.children.length,
      2,
      "Lampa's single-argument append must not drop the timestamp",
    );
    assert.equal(bubble.children[1].textContent, "00:50");
    assert.equal(bubble.hidden, false);
    h.Lampa.PlayerVideo.listener.send("destroy");
    assert.equal(bubble.hidden, true);
    assert.equal(
      h.track.children.find(
        (child) => child.className === "lampaua-seek-target",
      ).hidden,
      true,
    );
    h.emit("pointermove");
    assert.equal(bubble.hidden, false);
    h.video.dispatchEvent(new Event("emptied"));
    assert.equal(
      bubble.hidden,
      true,
      "Same-element source replacement retained a stale frame",
    );
  } finally {
    h.cleanup();
  }
});
test("stationary timeline hover holds controls before and after preview completion, then releases on exit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness();
  try {
    let complete;
    h.video.requestPreview = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    h.emit("pointermove");
    const bubble = h.track.children.find(
      (child) => child.className === "lampaua-preview",
    );
    t.mock.timers.tick(250);
    for (let seconds = 0; seconds < 5; seconds++) t.mock.timers.tick(1000);
    assert.equal(
      h.Lampa.PlayerPanel.visibleStatus(),
      true,
      "Controls vanished while preview was pending",
    );
    assert.equal(bubble.hidden, false);
    complete(null);
    await Promise.resolve();
    for (let seconds = 0; seconds < 4; seconds++) t.mock.timers.tick(1000);
    assert.equal(
      h.Lampa.PlayerPanel.visibleStatus(),
      true,
      "Controls vanished after preview completed",
    );
    h.emit("pointerout", { relatedTarget: {} });
    t.mock.timers.tick(3100);
    assert.equal(bubble.hidden, true);
    assert.equal(
      h.Lampa.PlayerPanel.visibleStatus(),
      false,
      "Hover hold survived leaving the timeline",
    );
  } finally {
    h.cleanup();
  }
});
test("release over the timeline keeps hover visible, release outside and source changes clear the hold", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = harness();
  try {
    h.emit("pointerdown");
    h.emit("pointerup");
    for (let seconds = 0; seconds < 4; seconds++) t.mock.timers.tick(1000);
    assert.equal(h.Lampa.PlayerPanel.visibleStatus(), true);
    h.video.dispatchEvent(new Event("emptied"));
    t.mock.timers.tick(3100);
    assert.equal(h.Lampa.PlayerPanel.visibleStatus(), false);
    h.emit("pointerdown");
    h.emit("pointerup", { clientX: 1100 });
    t.mock.timers.tick(3100);
    assert.equal(h.Lampa.PlayerPanel.visibleStatus(), false);
  } finally {
    h.cleanup();
  }
});
test("cancel followed by a browser route change consumes only the old mouse click", () => {
  const h = harness();
  try {
    h.emit("pointerdown");
    h.routeToBrowser();
    h.Lampa.PlayerVideo.listener.send("destroy");
    h.emit("pointerup");
    assert.equal(h.emit("click").stopped, true);
    h.emit("pointerdown");
    h.emit("pointerup");
    assert.notEqual(
      h.emit("click").stopped,
      true,
      "A new browser gesture was blocked",
    );
    assert.notEqual(
      h.emit("click", { detail: 0 }).stopped,
      true,
      "Keyboard click was blocked",
    );
    assert.notEqual(
      h.emit("click", { pointerType: "touch" }).stopped,
      true,
      "Touch click was blocked",
    );
  } finally {
    h.cleanup();
  }
});
