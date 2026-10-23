function summarizeFrameCadence(samples, sourceFps, idleRafFps, measurement) {
  const reasons = new Set();
  const fail = (reason) => reasons.add(reason);
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const { startMs, endMs } = measurement ?? {};
  if (!finite(startMs) || !finite(endMs) || endMs <= startMs)
    fail("invalid-measurement-window");
  if (!finite(sourceFps) || sourceFps <= 0) fail("unknown-source-fps");
  if (!finite(idleRafFps) || idleRafFps <= 0) fail("unknown-display-baseline");
  if (!Array.isArray(samples) || samples.length < 2) samples = [];
  if (!samples.length) fail("missing-samples");
  let generation = 0;
  let sequence = 0;
  let lastReceive = -Infinity;
  let lastUnique = startMs;
  let lastDrops;
  let lastDecoderDrops;
  let lastTarget = 0;
  let unique = 0;
  let intervalMax = 0;
  let avsyncMax = 0;
  let buffering = false;
  let released = 0;
  for (const sample of samples) {
    if (
      !Number.isSafeInteger(sample.generation) ||
      sample.generation < 1 ||
      !Number.isSafeInteger(sample.sequence) ||
      sample.sequence < 1 ||
      !Number.isSafeInteger(sample.frameFlags) ||
      sample.frameFlags < 0
    ) {
      fail("missing-frame-identity");
    }
    if (sample.generation < generation || sample.sequence <= sequence)
      fail("stale-or-repeated-frame");
    if (sample.generation > generation) lastTarget = 0;
    generation = sample.generation;
    sequence = sample.sequence;
    if (
      !finite(sample.receiveMs) ||
      sample.receiveMs < lastReceive ||
      sample.receiveMs < startMs ||
      sample.receiveMs > endMs ||
      !finite(sample.submitMs) ||
      sample.submitMs < sample.receiveMs
    )
      fail("invalid-frame-timing");
    if (sample.releaseMs !== null) {
      if (!finite(sample.releaseMs) || sample.releaseMs < sample.submitMs)
        fail("invalid-release-timing");
      else released++;
    }
    lastReceive = sample.receiveMs;
    if (
      !finite(sample.timeSeconds) ||
      !finite(sample.rafCount) ||
      sample.rafCount < 0 ||
      !finite(sample.avsync) ||
      !Number.isSafeInteger(sample.drops) ||
      sample.drops < 0 ||
      !Number.isSafeInteger(sample.decoderDrops) ||
      sample.decoderDrops < 0
    )
      fail("missing-playback-telemetry");
    if (sample.drops < lastDrops || sample.decoderDrops < lastDecoderDrops)
      fail("drop-counter-reset");
    lastDrops = sample.drops;
    lastDecoderDrops = sample.decoderDrops;
    avsyncMax = Math.max(avsyncMax, Math.abs(sample.avsync));
    if (sample.buffering !== false) buffering = true;
    if (sample.error) fail("playback-error");
    if (sample.visibility !== "visible") fail("window-not-visible");
    if (!(sample.frameFlags & 1) || sample.frameFlags & 6) continue;
    if (!finite(sample.targetTimeNs) || sample.targetTimeNs <= lastTarget)
      fail("missing-or-repeated-target");
    lastTarget = sample.targetTimeNs;
    if (lastUnique !== undefined)
      intervalMax = Math.max(intervalMax, sample.receiveMs - lastUnique);
    lastUnique = sample.receiveMs;
    unique++;
  }
  const first = samples[0] ?? {};
  const last = samples.at(-1) ?? {};
  intervalMax = Math.max(intervalMax, endMs - lastUnique);
  const elapsed = (endMs - startMs) / 1000;
  const frameElapsed = (last.receiveMs - first.receiveMs) / 1000;
  const uniqueFps = unique / elapsed;
  const dropDelta = last.drops - first.drops;
  const decoderDropDelta = last.decoderDrops - first.decoderDrops;
  const clockRatio = (last.timeSeconds - first.timeSeconds) / frameElapsed;
  const rafRatio = (last.rafCount - first.rafCount) / frameElapsed / idleRafFps;
  if (!finite(elapsed) || elapsed <= 0 || frameElapsed <= 0 || unique < 2)
    fail("insufficient-playback");
  if (!(uniqueFps >= sourceFps * 0.98)) fail("low-unique-fps");
  if (!(dropDelta >= 0 && dropDelta <= Math.max(1, elapsed / 30)))
    fail("video-drops");
  if (!(decoderDropDelta >= 0 && decoderDropDelta <= Math.max(1, elapsed / 30)))
    fail("decoder-drops");
  if (!(intervalMax <= 3000 / sourceFps + 1000 / idleRafFps))
    fail("long-frame-gap");
  if (!(clockRatio >= 0.98 && clockRatio <= 1.02)) fail("playback-clock");
  if (!(rafRatio >= 0.9)) fail("ui-raf");
  if (!(avsyncMax <= 0.05)) fail("av-sync");
  if (buffering) fail("buffering");
  return {
    uniqueFps,
    dropDelta,
    decoderDropDelta,
    intervalMax,
    clockRatio,
    rafRatio,
    avsyncMax,
    elapsed,
    unique,
    buffering,
    releaseTelemetry:
      samples.length && released === samples.length
        ? "complete"
        : "unavailable",
    passed: reasons.size === 0,
    reasons: [...reasons],
  };
}

module.exports = { summarizeFrameCadence };
