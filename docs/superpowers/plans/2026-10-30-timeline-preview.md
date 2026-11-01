# Timeline Preview Implementation Plan

> Implement sequentially here; use one independent final reviewer. The owner
> approved the follow-up requirements and instructed "починай роботу".

**Goal:** Show TorrServer's reader buffer and UA Player-style target-frame
preview; seek once when the mouse is released.

**Architecture:** Keep Lampa's panel, keyboard/remote/touch behavior and accepted
D3D11 playback. A small desktop timeline adapter handles mouse gestures and
consumes existing PlayerInfo `stat` events (no new server polling). A private
preview provider uses the current libmpv DLL in an expendable Electron utility
process, never the visible player's queues. This is my implementation choice:
WinUI/Flyleaf code cannot run inside Electron; reusing its interaction, isolation,
debounce and cache rules avoids a second playback engine or VPS generation.

**Tech Stack:** Electron 45, existing MPV addon/DLL, JS/TypeScript, Node tests.

**Spec:** Follow-up in `2026-10-27-desktop-unified-update.md`, the owner's UA
Player screenshot, and read-only inspection of Windows TimelineControl,
PlayerPage frame-preview handlers and FlyleafFramePreviewService.

## Constraints

- Do not change installed apps/profiles, UA Player, Lampac/VPS, runtime source
  pins or published v2.0.4 assets/tag. Build only a separate local test package.
- Do not intercept browser YouTube, non-MPV, IPTV live, keyboard/remote or touch.
- One seek on mouse release, none on hover/drag/cancel/capture loss.
- Preview is video-only, at most 320x180 RGBA, 48 cache entries, one active worker,
  250 ms pointer-settle delay; kill outstanding work on cancellation/close.
- Main bounds each active request to 8 seconds; a successful worker stays warm
  for at most 3 idle seconds. No native cleanup can hold app shutdown.
- Input comes from the owned active player's normalized URL/headers, not another
  renderer-supplied URL. Preserve protocol and header restrictions; no secrets in
  logs. On failure show time only, without a player error.
- Cache is per-source and cleared on open/stop/destroy. Worker does not scan or
  prefetch a timeline. Extra preview reads must be measured on real TorrServer.

## Review Focus

- Stale thumbnails/IPC arriving after quality, episode or document changes.
- Fast pointer motion/cancellation causing worker accumulation or duplicate seek.
- Preview network errors/auth headers and non-seekable streams.
- Player close while preview native open/render/cleanup hangs.
- 4K throughput and correct edge positioning with previews visible.

## Task 1: Gesture And Buffer

**Files:** `src/mpv/timeline-controls.js`, `src/mpv/renderer-entry.mjs`,
`tests/mpvTimeline.test.js`.

- [x] RED: test clamping, hover/no seek, one release seek, cancellation, pointer
      ownership; valid/malformed/multiple-reader cache stats and time formatting.
- [x] Implement `createSeekGesture`, `bufferState`, `installTimelineControls`.
      Render a bounded frame/time bubble and target marker. Read existing stat events,
      distinguish TorrServer buffer from MPV demuxer buffer; expire stale stats.
- [x] GREEN: unit tests, lint and real-DOM pointer tests/screenshots.

## Task 2: Isolated Frame Provider

**Files:** `src/modules/mpv/framePreview.js`, `frame-preview-worker.cjs`,
`src/modules/mpv/manager.js`, MPV service/shared/preload/renderer types,
`src/mpv/lampa-adapter.js`, `native/mpv-addon/src/mpv_addon.cc`,
`tests/mpvFramePreview.test.js`, IPC regression contracts.

- [x] RED: test cache/source reset, bounded frame payload, cancel/timeout, no
      concurrent workers, failure isolation, unchanged source/headers and ownership.
- [x] Implement a lazy private preview provider. Only new owned-session IPC
      `player:preview`/`player:preview-cancel` is exposed; never expose arbitrary native
      options or URLs. Preview constructor options apply only to the isolated worker.
- [x] GREEN: full unit/IPC/isolation contracts, TypeScript, syntax and lint.
- [x] Rebuild the addon and isolated local Desktop package using accepted DLL;
      verify actual frame/time, cancellation, errors and clean close in Electron.
- [x] Run existing full playback QA and sustained 4K controls. Record limitations
      and independent final review.
- [x] Ask owner to compare the 80+ GB scene with previews active. Do not call
      synthetic QA a real torrent acceptance.
- [x] Owner to confirm the stationary-hover follow-up before publication.

No publication of a new version until this feature's acceptance. The current
release remains 2.0.4 throughout this implementation.

## Evidence

31 October: 68 unit tests PASS (17 focused); independent reviewer found one P1
and two P2, fixed and rechecked. Actual packaged Playwright QA PASS
`1793433320619`; full existing Desktop QA PASS `1793433410770`. Primary profile
metadata unchanged in both. Original REDs, exact behavior and maintenance steps
are recorded in `docs/timeline-preview-maintenance.md`. Sustained 4K preview
load and the owner's real-torrent acceptance remain pending.

Follow-up: one-process-per-frame preview stress failed (5/11 SW, 7/11 GPU;
GPU run also dropped 2 visible frames). Keep one isolated decoder warm instead,
as in the reference UA Player. Private D3D11 readback copies only a small final
frame; the accepted DLL and main rendering options stay unchanged. New unit
contracts first RED then GREEN; now 71 tests PASS. Timeline QA
`1793453203731` PASS, including distinct repeated-seek pixels. Sustained load
and fresh full regression must still be completed before owner acceptance.

Warm-worker acceptance: 72 unit tests PASS, actual native P2 rejection-state
regression RED/GREEN; both D3D11/software worker reuse tests PASS. Isolated
4K HDR throughput `1793453660146` (30 s, 11/11 previews) and `1793453739030`
(180 s, 71/71 previews, 4320 unique frames, 0 drops, all cadence windows PASS).
Primary profile unchanged; final native guard does not alter normal playback.
Actual TorrServer preview/reader acceptance is still the owner's pending step.

Final native guard package: `package-1793453456509`; timeline QA
`1793454093449` PASS; full playback QA `1793454149018` PASS. Syntax checks,
ownership/facade/renderer/Ytdl/isolation contracts, ESLint and Prettier PASS.
The full QA restores the test profile's original address after legacy HTTP QA.

Owner acceptance: the real 80+ GB torrent is smooth; frame previews and
release-only seeking work. Follow-up before publication: stationary hover
sometimes outlasts Lampa's 3-second controls hide timeout, including right
after a frame arrives. Publication has not started. Keep the panel alive via
its existing mousemove API only while the pointer remains on the timeline or
a drag is active; cancel/leave/source reset must release the hold. Release
inside the timeline retains hover without committing a second seek.

Unit RED reproduced pending-preview hide; old-package real-Lampa QA RED
reproduced hiding just after the frame appears. New unit coverage PASS
(74 total). Rebuilt hover package `package-1793458335031`; packaged checks
and fresh throughput are pending. Independent bounded hover review found
no actionable issues and did not modify files or execute tests.

Hover follow-up validation: packaged timeline QA `1793458625504` PASS. Slow
preview (4.2s), stationary pointer before/after frame, release-only seek and
auto-hide after leave all PASS. Lampa's play/rewind state adds a 1s grace before
its 3s hide, so the test uses a long playing fixture and allows that exact
behavior rather than hitting EOF on the 14s clip. No production timing changed.
The 180s follow-up `1793458720890` is NOT acceptance: the window was hidden
for over two minutes, with renderer throttling and failed gates. Keep the RED.
Fresh visible 30s follow-up `1793472347484` PASS: 720 frames, 0 drops, no
buffering, 11/11 previews. 74 unit tests, ESLint and Prettier PASS. The previous
180s accepted decoder run remains separate evidence, not a claim about this
later hover build. Ready for a short owner hover confirmation; no release yet.

Owner then confirmed stationary hover, auto-hide after leave and finally
"everything works". Local acceptance is complete; preparation of 2.0.5 is
authorized by the standing publication request. No runtime/dependency upgrade
is included. Keep release CI, final-artifact QA and public updater verification
as separate unfinished gates in docs/2.0.5-maintenance.md.

Publication complete: PR #24, merge/tag `890c9c7`, release CI `41232608767`
SUCCESS. Exact CI timeline `1793512790309`, Portable full QA `1793512885555`
and 30s HDR/preview throughput `1793513029732` PASS. Published v2.0.5 as latest
on 2026-11-01 06:05:37 UTC; all 20 public assets and updater metadata verified,
plus a full anonymous installer download. Historical REDs and platform/VM
validation limits remain in docs/2.0.5-maintenance.md. No tag or binary changes
are included in this documentation-only postpublication receipt.
