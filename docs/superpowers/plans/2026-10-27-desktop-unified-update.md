# Desktop Unified Update Implementation Plan

> **For agentic workers:** Implement sequentially in the current session. Preserve the user's requested native execution method; use one independent final reviewer. Do not delegate implementation.

**Goal:** Prepare one tested Desktop update combining donor changes, dependency security fixes, CI maintenance and a separately accepted new MPV/FFmpeg runtime.

**Architecture:** Reuse the clean managed release checkout on `codex/desktop-update-20261027`; keep the original dirty checkout untouched. Integrate upstream through bounded rules, update compatible dependency branches, then build an artifact-only MPV candidate. Production pins and the update channel stay on the accepted 2.0.3 runtime until candidate acceptance.

**Tech Stack:** Electron 45.0.0, Node 24, Yarn 4.18.1, JavaScript/TypeScript, C++ D3D11, Python source/provenance tooling, GitHub Actions.

**Spec:** User-approved donor audit, `D:/opt/lampaua-desktop/.cache/update-audit-20261027/REPORT.md`, and existing `docs/release-maintenance.md`. The user said "Ок починай" to execute that scope; no further architecture questionnaire is needed.

## Global Constraints

- Preserve `com.lampaua.desktop`, existing user settings/profile, both fixed HTTPS/HTTP addresses, UA Player, donations and GPL-3.0-or-later.
- No rollback to donor Electron 44 or ESLint 9; no Windows 32-bit/macOS 12 restoration.
- No installed application/profile, external player, Lampac, VPS, TorrServer instance or server-module edits.
- Keep source locks, complete corresponding sources, notices, immutable hashes and candidate-only CI until acceptance.
- No moving published tags. Public release follows completed package/runtime acceptance, not merely a main push.

## Review Focus

- macOS IINA conversion must not steal same-origin navigation or affect other OS/player routes.
- Disabled next-episode setting, settings-read failure and failed IINA playlist opening must keep original single-episode behavior.
- Fullscreen shortcuts must be macOS-only and MPV close deadlines must survive donor integration.
- Dependency updates must preserve Node 24, release identity, updater architecture selection and full-download behavior.
- Upstream-native D3D11 must not receive a duplicate backport; historical accepted runtime provenance must remain reproducible.

## Deferred Follow-Up

The user selected a separate stage AFTER the new core's acceptance for two ideas
from Notme-SI/mpv-plus b4944849fa32f2c078ac6e5c20a1ca9518551d53:

- Add read-only TorrServer cache statistics, clearly separate from the existing
  MPV demuxer-buffer indication. No server setting changes.
- Add mouse drag-to-seek with preview while dragging and one seek on release.
  Current Lampa mouse movement only previews time, clicks seek, and touch already
  seeks on release; do not present these existing behaviors as missing.

On 30 October, the owner added frame-thumbnail preview to this SAME follow-up
stage, using the UA Player screenshot and current Windows implementation as the
behavior reference (not another feature taken from mpv-plus):

- Show a frame for the hovered/dragged target time, with its timestamp below,
  above the timeline. This is not the poster or a screenshot of the current
  playback position. Keep the bubble inside the player at both timeline edges.
- Hover and dragging must not seek the visible player. Commit one seek on
  pointer release; cancellation/capture loss must not accidentally commit it.
- Keep extraction asynchronous and separate from the active playback clock,
  queues and D3D11 rendering. Bound work/cache, cancel superseded requests and
  reject stale results after a source/episode/quality change or player close.
- Preserve authorized source headers and existing URL/access restrictions.
  Do not generate previews on the VPS or change Lampac/TorrServer settings.
  Separate preview reads can use network bandwidth: do not prefetch the whole
  timeline or let pending previews accumulate during fast pointer movement.
- On unsupported/non-seekable live streams, extraction failure or timeout,
  keep the time-only hint where seeking is supported; never block playback,
  controls or closing the application for a thumbnail.
- Acceptance must include hovered-frame correctness, timestamp, edge placement,
  rapid drag/cancel/source changes, bounded memory/work, and the accepted 80+ GB
  4K scene with previews active. Preserve keyboard/remote and browser YouTube
  behavior; verify preview support per playback path rather than assuming the
  Windows MPV implementation covers every platform/player.

Windows reference inspected read-only: `D:/opt/lampaua-player-windows/src/`
`LampaUA.Player.App/Controls/TimelineControl.xaml.cs`,
`LampaUA.Player.App/Views/PlayerPage.xaml.cs`, and
`LampaUA.Player.Flyleaf/Engine/FlyleafFramePreviewService.cs`.
It uses a lazy video-only decoder independent of playback, a 250 ms settled-
pointer delay, one-second cache buckets, at most 48 JPEGs (up to 320x180 and
256 KiB each), cancellation and source generations. Reuse the behavior and
safety boundaries, not WinUI/Flyleaf-specific code in Electron. The exact
Desktop extraction mechanism still needs a bounded design/prototype before
product implementation; the accepted production DLL is not changed by this
requirements update.

Do not add these features to this unified update. Their detailed design and tests
belong to that later stage. Intro skipping already exists in Lampa; retain it
without a second Lua implementation. Track selection is transferred between
playlist items in the current session; persistent per-series preference matching
is a separate feature, not assumed missing or selected for implementation.

### Task 1: Donor Integration

**Files:** `src/modules/windowManager.js`, new donor `src/modules/iinaAutoplay.js`, `tests/iinaAutoplay.test.js`, new `tests/windowManager.test.js`, `package.json`, `yarn.lock`, donor documentation/CI.

- [x] Add failing window-manager tests for macOS fullscreen, IINA routing/fallback and retained internal navigation.
- [x] Run bounded sync against pinned `upstream/main` f834fec9; inspect and resolve only known conflicts.
- [x] Preserve our package/build identity, current dependency floors, MPV attach/close and URL policy.
- [x] Run new donor/window tests, syntax, MPV isolation, external-player and upstream-sync contracts; commit the reviewed merge.

### Task 2: Dependencies And Security

**Files:** `package.json`, `yarn.lock`, audit evidence and maintenance documentation.

- [x] Integrate PR #21 content: updater 6.8.11, builder 26.18.0, rolldown 1.2.15.
- [x] Refresh compatible transitive branches for fast-uri/js-yaml and build-tool advisories, with no blanket major resolutions.
- [x] Run immutable install, production/full audit, syntax/contracts and lint. Record any unsupported/deprecated dependency separately.
- [x] Verify actual staged/committed package versions and commit scoped changes.

### Task 3: CI Maintenance

**Files:** `.github/workflows/*.yml`, `.github/dependabot.yml` if needed, associated workflow-contract tests.

- [x] Read major release migration notes/action manifests and add/update failing workflow tests.
- [x] Update checkout/setup/upload/download actions with hosted-runner compatibility; preserve project Node 24 and token/permission boundaries.
- [x] Include new tests, production audit and existing D3D11 gates in validation/sync CI without weakening manual-review rules.
- [x] Validate YAML, workflow contracts and lint; commit.

### Task 4: New Core Candidate

**Files:** candidate source-build config/lock, source provenance/patch tooling and tests, artifact-only workflow.

- [x] Inspect pinned source snapshots, relevant MPV/FFmpeg changes, native D3D11/API and minimum dependency compatibility; pin MPV 82667e3c and FFmpeg 86444dd3. The GitHub FFmpeg compare is truncated, not a complete manual review of 879 commits.
- [x] Support unpatched upstream-native D3D11 provenance while preserving verification of the historical patched source bundle.
- [x] Run source/environment/preflight tests before the expensive compilation; commit candidate build inputs. Run 40556592535 passed the container, 94 source/tooling tests and captured-source preflight before compilation.
- [x] Push only the update/candidate branch as needed for the artifact-only DLL build. No release or production-pin promotion in this step.
- [x] Repair the confirmed FFmpeg configure incompatibility: remove only the obsolete `--enable-opengl` from the new candidate recipe. Capture the actual CMake configure argument vector and validate it with pinned FFmpeg's own parser (`--help` last) in a disposable directory before GCC; add negative option/early-exit and recipe-isolation tests.
- [x] Rerun artifact-only CI after all local checks: run 40929887820, commit 3761a32. Candidate-only, no production promotion.
- [x] Verify the new argument preflight is reached before compilation: 40929887820 completed the input step and entered compilation.
- [x] Verify the DLL build completes: 40929887820 PASS, source commit 3761a32, compiled 18:27:19-20:13:40 UTC on 29 October.
- [x] Verify the finished DLL/SDK/API/imports and independently audit complete sources/notices; preserve exact audited inputs. ZIP digest and all inner checksums match; API 2.6, hardware context cycles, 54 MPV exports and the same 50 external imports. Source audit: 91 pins, 96 components, 827 notices plus 8 unchanged reviewed files. No production promotion.

### Task 5: Application Acceptance

**Files:** runtime pins only after candidate acceptance, build/package contracts, maintenance/user-facing release notes.

- [x] Intermediate dependency acceptance: full isolated Windows Desktop with the previously accepted D3D11 DLL; 4K HEVC/H264, AC3/EAC3, AVI/Xvid, controls and browser/native DASH pass. This does not accept the new DLL.
- [x] Prepare explicit `--d3d11-next` app packaging/staging/QA, separate caches/output/profile and a required source-audited `build/libmpv-d3d11-next-test.json` receipt. Existing candidate/release paths and hard release prohibition retained. The new receipt is deliberately absent until the artifact/source audit exists.
- [x] Build the full Windows Desktop candidate with the NEW DLL, not a standalone player; retain isolated test profile/updater-off. Portable SHA-256 c14fe16e0f214cdc3d17949acbc45384b1280885e2ee08eda35876b80496a0b6.
- [x] Run native/transport/lifecycle and full packaged playback, controls/orientation/GPU-recovery tests. Initial timing RED and passing controls/repeats remain explicitly recorded below.
- [x] Repeat sustained H264/HEVC/Main10 fixture acceptance: three isolated authenticated 180-second runs, all 18 cadence windows PASS, zero video/decoder drop deltas, no buffering, D3D11VA GPU frames.
- [x] Repeat the real 80+ GB 4K scene: user confirmed the NEW test package is smooth for at least 3 minutes from 25:10 and seeking works. This is manual acceptance, not per-frame torrent telemetry.
- [x] Live authenticated YouTube accepted by the owner on 30 October: "ютуб вважаємо робочим". A real 1080p clip resumed after seeking; intermittent 4K upstream failures remain recorded, not claimed fixed by the Desktop update. No YouTube/server/proxy changes.
- [x] Extend draft-only source preservation to the finished `d3d11-next` artifact; add RED/GREEN and negative workflow contract checks. No recompilation, default/old variants preserved.
- [x] Preserve the verified SDK and two source parts in the next release draft (run 41078485801), independently compare the evidence, then promote production provenance/notices with contract coverage. All 835 original notices match; inventory differs only CRLF/LF, production retains exact audited local receipt bytes.
- [x] Obtain one independent code review, resolve findings and record exact evidence/limits. Fresh new-DLL acceptance is recorded separately above; physical macOS/IINA playback remains unverified.
- [x] Publish one accepted release: v2.0.4 at 35ef525, CI 41081807942 PASS, exact final Windows artifact QA and source assets verified. Published 30 October 18:57:55 UTC; all 20 public assets and Windows/macOS/Linux update metadata verified anonymously. Physical macOS/IINA and new disposable-VM installation remain explicit verification limits.

## Progress

- Audit and clean checkout confirmed; implementation starting from main e9acfed.
- Local donor/window tests: 18 PASS, including RED-to-GREEN for the three new behaviors.
- Production and full dependency audits: zero advisory after compatible lockfile refresh; deprecations remain visible through the ordinary audit command.
- Existing player/updater/network/semantic-sync contracts and lint PASS. Candidate DLL work has not promoted or changed production runtime pins.
- Merge dfb201f: GitHub validation 40554085686 and IINA/macOS build 40554086063 both PASS.
- New-core tooling: 90 Python tests PASS, native metadata and workflow regression checks PASS, lint PASS. The pinned new recipe prepares successfully locally; actual Linux source/environment preflight remains a CI gate.
- First DLL run 40555733449 stopped before compilation because the upstream registry removed the old container digest. Candidate-only container refresh and a tested pre-container registry gate added; no floating-image fallback or historical pin rewrites.
- 29 October reconciliation: branch b05c234 is clean and pushed. Latest donor still f834fec. Validation 40556594250 and IINA/macOS 40556594500 PASS. The old-runtime Windows portable was packaged (SHA-256 2a95c3ce8930e71782483ffc774068e2e481995155def5cbed75abd2a4701a39); it is NOT new-DLL acceptance. New DLL run 40556592535 failed at FFmpeg configure after dependency compilation: `Unknown option "--enable-opengl"`. Source and environment preflight had passed.
- Scheduled sync 40667554836 still runs main e9acfed and correctly requests manual review of donor package/window-manager changes already merged into this candidate branch. Do not weaken the sync policy or push an unaccepted core to main to silence that notification.
- Configure repair RED/GREEN: exact pinned FFmpeg rejected the old recipe, then accepted all 64 options after the single flag removal. Full local checks: 99 Python tests, 18 donor/navigation tests, lint, workflow contracts and production audit PASS. Packaged old-runtime app's 42-package dependency graph is complete; new-runtime playback is still pending.
- Run 40929887735 (validation) and 40929887774 (IINA/macOS) PASS for 3761a32. Full old-runtime packaged quality QA PASS: `.cache/mpv-desktop-d3d11-test/evidence/run-1793298077484/results.json`; D3D11 playback and browser/native DASH without video errors, pause/seek/volume/speed, changing pixels, profile isolation, clean app exit 848 ms. Screenshots inspected. These are synthetic local streams, not a live authenticated YouTube/TorrServer acceptance test.
- Native-candidate packaging preparation: CLI/profile RED-to-GREEN, D3D11 service/isolation/release/renderer contracts and lint PASS. Full old-SDK stage-only build also PASS, including real Electron network checks, native rebuild, staging hashes and native lifecycle. Cache `.cache/mpv-desktop-d3d11-test/package-1793298707838` is still OLD-runtime evidence, not a next-candidate build.
- Independent review of main e9acfed through 5f730f3 found one P2 in QA only: navigation recovery read the old D3D11 profile for `--d3d11-next`. Fixed the diagnostic path; regression executes the actual read expression across old/next, persistent/run-id and release profiles (8 combinations). RED with the original expression, GREEN after the fix, confirmed independently. No other confirmed code defects found; lint, D3D11 integration and release contracts PASS. Validation 40931989759 and IINA/macOS 40931989753 PASS for 5f730f3. New DLL run 40929887820 remains a separate acceptance gate.
- DLL build 40929887820 completed successfully. Artifact 12929033512 is 2,899,264,068 bytes, ZIP SHA-256 accc92c9b04f532be507185ca249826324acc1623cc3b848f5d2db5d71095962. Extracted SDK/source paths and all checksums verified in `.cache/libmpv-d3d11-next-candidate`. Source/native receipt added only after the complete audit, using `licenses/libmpv/inventory.json` as the previous manual-review record (the old candidate cache lacks that record). Five hardware context cycles PASS: API 131078, render thread, max main heartbeat gap 50.98 ms, zero remaining textures/handles/threads. These gates allow isolated test packaging, not release acceptance.
- New-runtime native playback/lifecycle PASS: H264 48 frames and HEVC Main10 4K 240 frames, D3D11VA/WASAPI, video/decoder drop deltas 0/0, max A/V sync 3.69/10.67 ms; 50 lifetime/fault/cleanup cycles, max main heartbeat gap 73.91 ms, zero remaining GPU resources. Evidence `.cache/libmpv-d3d11-next-candidate/player-tests.log`. Full Desktop/compositor/sustained real-torrent acceptance still pending.
- 30 October: full next-Desktop package built from 208d378, `.cache/mpv-desktop-d3d11-next-test/package-1793306282304`; staging, Electron network, production-addon/test-hook exclusion and native lifecycle PASS. The first full QA run 1793306560765 stopped at its final offline-recovery assertion: WebGL recovery had a confirmed retired GPU owner, but that call incorrectly required native. Scoped QA-only fix plus VM RED/GREEN; ordinary native assertions and recovery-cause guards unchanged. Full repeat 1793345939108 PASS (54 entries, close 401 ms, production profile metadata unchanged). Four-corner orientation 1793346053871 PASS. Pool bounds/pixels/resize/fault/lifecycle PASS.
- Transport timing results are not all green: initial next runs 1793346212051 (24 FPS) and 1793346782197 (60 FPS) failed the unchanged strict cadence/compositor gates. No corrupt/reordered pixels or leaked resources. Accepted-DLL controls 1793346485907 / 1793347040636 PASS. Same-code next repeats 1793346641474 / 1793347213630 PASS (1440 / 3599 unique pixels; no compositor drops). Exact loaded DLL paths verified for the 24 FPS A/B. Do not claim a proven causal timing fix or erase the initial RED evidence. Review/other tests were not run during the isolated repeats; no GPU algorithm, thresholds or per-video settings changed.
- Transport 50-cycle run 1793347403813 PASS: callback failure released, no errors, final textures/handles/threads 0/0/0. Packaged 4K controls/layout 1793347667419 PASS: 24 operations, max round-trip 64 ms, 1280x720 / 960x640 / fullscreen, no decode error. GPU loss 1793348321417 PASS: Canvas2D recovery, position 12.208 -> 12.5 s, changing nonblank pixels (mean 128.41, delta 3.93), controls, close 731 ms.
- Subtitle verification exposed a bad local fixture, not a demonstrated player regression: old MKV had a subtitle header but zero packets. Preserve it as `.cache/libmpv-d3d11-next-candidate/tracks-subs-empty-before-fix.mkv`. Added reproducible `create-mpv-stream-fixtures.cjs --tracks-subs`, packet/text validation, full-QA nonempty-packet guard and 3 VM regression tests. New SRT packet 1.021-10.021 s, text visibly confirmed in run 1793348185128 screenshot after hiding controls. Full QA PASS (53 entries, close 782 ms, production profile unchanged). Earlier screenshots did not prove subtitle rendering. Independent reviewer found no confirmed issues in this QA-only change.
- User signed into the separate NextTest profile and closed it. Authenticated, isolated 180-second runs: H264 SDR 1793366806874, HEVC SDR 1793367053480, HEVC Main10 HDR 1793367292217. Each delivered 4320 unique frames, zero video/decoder drop deltas and no buffering; all 6 windows per run PASS. Max consumer gap 57.7 / 63.0 / 57.9 ms, no long tasks or visibility changes. Startup access requests ended before each measurement. These are consumer/GPU-submission measurements, not physical scan-out or real-torrent evidence.
- User confirmed the actual 80+ GB 4K BDRemux in the NEW NextTest Desktop: at least 3 minutes from the previously problematic 25:10 scene, smooth playback and functional seeking. This closes the manual real-torrent gate; no per-frame physical-presentation capture of that torrent is claimed. Live YouTube remains pending.
- Owner subsequently accepted YouTube on 30 October and requested publication on completion. Release 2.0.4 published after final CI package QA; see docs/2.0.4-maintenance.md for original REDs, final PASS receipts, QA-only bounded startup follow-up and explicit platform/VM limits. No production/server/profile changes were made by local QA. TorrServer buffer and drag-release seeking remain a separate next stage.
