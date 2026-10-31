const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createSeekGesture,
  formatTime,
  bufferState,
} = require("../src/mpv/timeline-controls");
test("mouse drag previews, clamps and commits exactly once on release", () => {
  const seeks = [],
    hints = [];
  const gesture = createSeekGesture({
    commit: (value) => seeks.push(value),
    preview: (value) => hints.push(value),
  });
  gesture.move(7, 0.2);
  assert.equal(gesture.begin(7, -1), true);
  gesture.move(7, 0.7);
  gesture.end(8, 0.8);
  assert.deepEqual(seeks, []);
  gesture.end(7, 2);
  gesture.end(7, 0.4);
  assert.deepEqual(seeks, [1]);
  assert.deepEqual(hints, [0, 0.7, 1]);
});
test("capture loss/cancel and other pointers cannot seek", () => {
  let seeks = 0;
  const gesture = createSeekGesture({ commit: () => seeks++, preview() {} });
  gesture.begin(1, 0.2);
  assert.equal(gesture.begin(2, 0.9), false);
  gesture.cancel();
  gesture.end(1, 0.8);
  assert.equal(seeks, 0);
});
test("a canceled MPV drag consumes its following click even after playback routing changes", () => {
  const gesture = createSeekGesture({
    commit() {
      throw new Error("Unexpected seek");
    },
    preview() {},
  });
  gesture.begin(1, 0.2);
  gesture.cancel();
  gesture.end(1, 0.5);
  assert.equal(gesture.consumeClick(1), true);
  assert.equal(gesture.consumeClick(1), false);
  gesture.begin(1, 0.1);
  gesture.cancel();
  gesture.clearClick();
  assert.equal(
    gesture.consumeClick(1),
    false,
    "A new browser pointerdown must not inherit an old click block",
  );
});
test("time formatting is finite and supports long videos", () => {
  assert.equal(formatTime(272), "04:32");
  assert.equal(formatTime(3661), "1:01:01");
  assert.equal(formatTime(NaN), "00:00");
});
test("TorrServer reports contiguous reader availability, not total downloaded percent", () => {
  const data = {
    cache: {
      Readers: [{ Reader: 2, End: 6 }],
      Pieces: {
        2: { Completed: true },
        3: { Completed: true },
        5: { Completed: true },
      },
    },
  };
  assert.deepEqual(bufferState(data), { percent: 50, readers: 1 });
});
test("unknown, malformed and ambiguous multi-reader stats hide the indicator", () => {
  for (const value of [
    null,
    {},
    { cache: { Readers: [] } },
    { cache: { Readers: [{ Reader: 5, End: 2 }], Pieces: {} } },
    {
      cache: {
        Readers: [
          { Reader: 1, End: 2 },
          { Reader: 4, End: 6 },
        ],
        Pieces: {},
      },
    },
  ]) {
    assert.equal(bufferState(value), null);
  }
});
