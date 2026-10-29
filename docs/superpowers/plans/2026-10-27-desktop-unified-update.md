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
- [ ] Build the full Windows Desktop candidate with the NEW DLL, not a standalone player; retain isolated test profile/updater-off.
- [ ] Run native/transport/lifecycle and full packaged playback, controls/orientation/GPU-recovery tests.
- [ ] Repeat sustained H264/HEVC/Main10 and real 80+ GB 4K scene acceptance; no CPU-copy or UI-freeze regression.
- [x] Obtain one independent code review, resolve findings and record exact evidence/limits. Binary/playback acceptance remains separate and pending the new DLL.
- [ ] Prepare one release only after acceptance; verify tag/package version, cross-platform CI, source assets and anonymous update metadata before publication.

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
