const POLL_MS = 1_000;
const TTL_MS = 24 * 60 * 60 * 1_000;

function createUaPlayerProgressMonitor({
  readSnapshot,
  readFinalResult,
  onProgress = () => {},
  onFinalResult = () => {},
  onDispose = () => {},
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let stopped = false;
  let started = false;
  let timer;
  let running;
  const expiresAt = now() + TTL_MS;
  let generation;
  let sequence = 0;
  const rowSequences = new Map();

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    onDispose();
  }

  async function acceptFinal(result, pendingSnapshot) {
    if (stopped || !result) return false;
    const snapshot =
      pendingSnapshot === undefined ? await readSnapshot() : pendingSnapshot;
    if (stopped) return true;
    // Legacy terminal results cannot distinguish failed/unstarted zero from a
    // real seek. Confirm zero only with a newer authenticated progress row that
    // agrees with the final result, and deliver it before retiring the session.
    if (snapshot) {
      const terminalRows = new Map(
        (result.playback_results || []).map((row) => [row.playlist_index, row]),
      );
      const confirmed = snapshot.playback_results.filter((row) => {
        const terminal = terminalRows.get(row.playlist_index);
        return (
          row.position === 0 &&
          terminal?.position === 0 &&
          terminal.duration === row.duration &&
          terminal.end_by !== "failed"
        );
      });
      if (confirmed.length)
        acceptSnapshot({ ...snapshot, playback_results: confirmed });
    }
    stop();
    onFinalResult(result);
    return true;
  }

  async function poll() {
    if (stopped) return;
    if (now() >= expiresAt) {
      stop();
      return;
    }
    if ((await acceptFinal(await readFinalResult())) || stopped) return;
    const snapshot = await readSnapshot();
    if (stopped) return;
    // A final result may appear while the asynchronous progress read is in flight.
    if (
      (await acceptFinal(await readFinalResult(), snapshot)) ||
      stopped ||
      !snapshot
    )
      return;
    acceptSnapshot(snapshot);
  }

  function acceptSnapshot(snapshot) {
    if (stopped) return;
    if (
      (generation !== undefined && generation !== snapshot.generation) ||
      snapshot.sequence <= sequence
    )
      return;
    generation = snapshot.generation;
    sequence = snapshot.sequence;
    const changed = snapshot.playback_results.filter(
      (row) => row.sequence > (rowSequences.get(row.playlist_index) || 0),
    );
    for (const row of changed)
      rowSequences.set(row.playlist_index, row.sequence);
    if (changed.length) onProgress({ sequence, playback_results: changed });
  }

  function tick() {
    if (stopped) return Promise.resolve();
    if (running) return running;
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    running = poll()
      .catch(() => {
        // A locked/missing file or failed callback is nonterminal; retry next tick.
      })
      .finally(() => {
        running = undefined;
        if (!stopped) {
          timer = schedule(tick, POLL_MS);
          timer?.unref?.();
        }
      });
    return running;
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      timer = schedule(tick, POLL_MS);
      timer?.unref?.();
    },
    stop,
    // Neither successful forwarding nor a nonzero exit proves session completion.
    // Only the protected terminal result, explicit spawn error/owner cleanup or TTL does.
    notifyChildClosed: () => tick(),
  };
}

module.exports = { createUaPlayerProgressMonitor };
