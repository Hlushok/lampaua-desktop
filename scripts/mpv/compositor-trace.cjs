const finite = (value) => typeof value === "number" && Number.isFinite(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;

function summarizeCompositorTrace(
  events,
  { rendererPid, startUs, endUs, sourceFps },
) {
  const invalid = (reason) => ({ passed: false, valid: false, reason });
  if (
    !Array.isArray(events) ||
    !Number.isSafeInteger(rendererPid) ||
    !finite(startUs) ||
    !finite(endUs) ||
    endUs <= startUs ||
    !finite(sourceFps) ||
    sourceFps <= 0
  )
    return invalid("Invalid trace window or renderer identity");
  const active = new Map();
  const segments = [];
  const presentation = [];
  let presentedPipelines = 0;
  let droppedPipelines = 0;
  for (const event of events) {
    if (!finite(event.ts)) continue;
    if (
      event.name === "Display::FrameDisplayed" &&
      event.ts >= startUs &&
      event.ts < endUs + 40000
    )
      presentation.push(event.ts);
    if (event.pid !== rendererPid) continue;
    if (
      event.name === "PipelineReporter" &&
      event.ph === "b" &&
      event.ts >= startUs &&
      event.ts < endUs
    ) {
      const state = event.args?.frame_reporter?.state;
      if (state === "STATE_PRESENTED_ALL") presentedPipelines++;
      else if (state === "STATE_DROPPED" || state === "STATE_PRESENTED_PARTIAL")
        droppedPipelines++;
      else if (state !== "STATE_NO_UPDATE_DESIRED")
        return invalid(`Unsupported compositor state: ${state}`);
    }
    if (
      event.name !== "FrameSequenceTrackerV3" ||
      typeof event.id2?.local !== "string"
    )
      continue;
    const id = `${event.pid}:${event.tid}:${event.id2.local}`;
    if (event.ph === "b" && event.args?.name === "CanvasAnimation") {
      const data = event.args?.args?.data;
      if (active.has(id))
        return invalid("Overlapping CanvasAnimation identity");
      active.set(id, { start: event.ts, data });
    } else if (event.ph === "e" && active.has(id)) {
      const begin = active.get(id);
      active.delete(id);
      if (event.ts <= begin.start)
        return invalid("Invalid CanvasAnimation time range");
      if (event.ts > startUs && begin.start < endUs) {
        const data = begin.data;
        if (
          !data ||
          !count(data.expected) ||
          !count(data.dropped_v3) ||
          !count(data.dropped_v4) ||
          !count(data.missing_content)
        )
          return invalid("Missing versioned CanvasAnimation counters");
        segments.push({ ...begin, end: event.ts });
      }
    }
  }
  if (!segments.length || !presentation.length || !presentedPipelines)
    return invalid(
      "No complete canvas/presentation evidence for this renderer",
    );
  presentation.sort((a, b) => a - b);
  const ranges = segments
    .map((item) => [Math.max(item.start, startUs), Math.min(item.end, endUs)])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    if (merged.length && range[0] <= merged.at(-1)[1])
      merged.at(-1)[1] = Math.max(merged.at(-1)[1], range[1]);
    else merged.push([...range]);
  }
  const coverage =
    merged.reduce((sum, range) => sum + range[1] - range[0], 0) /
    (endUs - startUs);
  // A segment crossing a window boundary is counted conservatively in both.
  const canvasExpected = segments.reduce(
    (sum, segment) => sum + segment.data.expected,
    0,
  );
  const canvasDropped = segments.reduce(
    (sum, segment) =>
      sum + Math.max(segment.data.dropped_v3, segment.data.dropped_v4),
    0,
  );
  const missingContent = segments.reduce(
    (sum, segment) => sum + segment.data.missing_content,
    0,
  );
  const seconds = (endUs - startUs) / 1e6;
  const presentationFps = presentation.length / seconds;
  const maxGapMs = Math.max(
    0,
    ...presentation
      .slice(1)
      .map((time, index) => (time - presentation[index]) / 1000),
  );
  const clockRatio =
    presentation.length > 1
      ? (presentation.length - 1) /
        sourceFps /
        ((presentation.at(-1) - presentation[0]) / 1e6)
      : 0;
  return {
    valid: true,
    coverage,
    canvasExpected,
    canvasDropped,
    missingContent,
    presentedPipelines,
    droppedPipelines,
    presentationCount: presentation.length,
    presentationFps,
    maxGapMs,
    clockRatio,
    passed:
      coverage >= 0.98 &&
      canvasExpected > 0 &&
      canvasDropped <= 1 &&
      missingContent === 0 &&
      droppedPipelines <= 1 &&
      presentationFps >= sourceFps * 0.98 &&
      clockRatio >= 0.98 &&
      clockRatio <= 1.02 &&
      maxGapMs <= 3000 / sourceFps + 1000 / 60,
  };
}

module.exports = { summarizeCompositorTrace };
