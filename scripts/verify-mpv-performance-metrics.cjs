const assert = require("node:assert/strict");
const { summarizeFrameCadence } = require("./mpv/performance-metrics.cjs");

function frames(fps = 24, seconds = 30) {
  return Array.from({ length: Math.ceil(fps * seconds) }, (_, i) => ({
    generation: 1,
    sequence: i + 1,
    frameFlags: 1,
    targetTimeNs: 1e9 + (i * 1e9) / fps,
    receiveMs: (i * 1000) / fps,
    submitMs: (i * 1000) / fps + 0.1,
    releaseMs: null,
    timeSeconds: i / fps,
    drops: 0,
    decoderDrops: 0,
    avsync: 0.001,
    rafCount: (i * 60) / fps,
    buffering: false,
    error: null,
    visibility: "visible",
  }));
}
function check(samples, fps = 24, idle = 60) {
  return summarizeFrameCadence(samples, fps, idle, {
    startMs: 0,
    endMs: 30000,
  });
}
assert.equal(
  check(frames().filter((frame) => frame.receiveMs < 29200)).passed,
  false,
  "An 800 ms tail freeze passed",
);
assert.equal(
  check(frames().filter((frame) => frame.receiveMs > 800)).passed,
  false,
  "An 800 ms startup freeze passed",
);
assert.equal(
  summarizeFrameCadence(frames(), 24, 60).passed,
  false,
  "Missing measurement boundaries passed",
);
for (const fps of [24, 24000 / 1001, 25, 30000 / 1001, 50, 60]) {
  const result = check(frames(fps), fps);
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.ok(Math.abs(result.uniqueFps - fps) <= 1 / 30);
  assert.equal(result.releaseTelemetry, "unavailable");
}
const mutate = (callback) => {
  const samples = frames();
  callback(samples);
  return check(samples);
};
assert.equal(check(frames(22.81), 24).passed, false, "95% cadence passed");
assert.equal(
  mutate((samples) => {
    samples.at(-1).drops = 10;
  }).passed,
  false,
);
assert.equal(
  mutate((samples) => {
    samples.at(-1).decoderDrops = 2;
  }).passed,
  false,
);
assert.equal(
  mutate((samples) => {
    samples[100].sequence = samples[99].sequence;
  }).passed,
  false,
  "Repeated sequence passed",
);
assert.equal(
  mutate((samples) => {
    samples[100].generation = 2;
  }).passed,
  false,
  "Stale generation after seek passed",
);
assert.equal(
  mutate((samples) => {
    samples[100].targetTimeNs = samples[99].targetTimeNs;
  }).passed,
  false,
  "Duplicate playback timestamp passed",
);
assert.equal(
  mutate((samples) => {
    for (const frame of samples) frame.sequence = undefined;
  }).passed,
  false,
  "Missing sequence passed",
);
for (const fps of [0, undefined, NaN])
  assert.equal(summarizeFrameCadence(frames(), fps, 60).passed, false);
assert.equal(check(frames(), 24, 0).passed, false);
assert.equal(
  mutate((samples) => {
    for (const frame of samples) frame.timeSeconds *= 0.95;
  }).passed,
  false,
  "Slow playback clock passed",
);
assert.equal(
  mutate((samples) => {
    for (const frame of samples) frame.rafCount *= 0.89;
  }).passed,
  false,
  "Unresponsive UI passed",
);
assert.equal(
  mutate((samples) => {
    samples[100].avsync = -0.051;
  }).passed,
  false,
);
assert.equal(
  mutate((samples) => {
    samples[100].buffering = true;
  }).passed,
  false,
);
assert.equal(
  mutate((samples) => {
    samples[100].visibility = "hidden";
  }).passed,
  false,
  "Occluded playback passed a visible-window acceptance test",
);
assert.equal(
  mutate((samples) => {
    samples[100].error = "media failure";
  }).passed,
  false,
);
assert.equal(
  mutate((samples) => {
    samples[100].drops = undefined;
  }).passed,
  false,
);
assert.equal(
  mutate((samples) => {
    samples[100].submitMs = samples[100].receiveMs - 1;
  }).passed,
  false,
);
assert.equal(
  check(frames().filter((_, i) => i < 100 || i > 103)).passed,
  false,
  "Long gap passed",
);
const redraws = frames();
for (let i = redraws.length - 1; i > 0; i--) {
  redraws[i].sequence *= 2;
  redraws.splice(i, 0, {
    ...redraws[i],
    sequence: redraws[i].sequence - 1,
    frameFlags: 3,
  });
}
assert.equal(
  check(redraws).passed,
  true,
  "Redraw was counted as a playback frame",
);
const onlyRedraws = frames().map((frame) => ({ ...frame, frameFlags: 3 }));
assert.equal(check(onlyRedraws).passed, false);
const resetDrops = frames().map((frame, i) => ({
  ...frame,
  drops: i < 100 ? 4 : 0,
}));
assert.equal(check(resetDrops).passed, false, "Counter reset hid drops");
console.log(
  "Strict frame cadence metrics passed: unique frames, generations, clocks, drops, RAF and AV sync",
);
