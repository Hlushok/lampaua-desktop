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

### Task 1: Donor Integration

**Files:** `src/modules/windowManager.js`, new donor `src/modules/iinaAutoplay.js`, `tests/iinaAutoplay.test.js`, new `tests/windowManager.test.js`, `package.json`, `yarn.lock`, donor documentation/CI.

- [x] Add failing window-manager tests for macOS fullscreen, IINA routing/fallback and retained internal navigation.
- [x] Run bounded sync against pinned `upstream/main` f834fec9; inspect and resolve only known conflicts.
- [x] Preserve our package/build identity, current dependency floors, MPV attach/close and URL policy.
- [ ] Run new donor/window tests, syntax, MPV isolation, external-player and upstream-sync contracts; commit the reviewed merge.

### Task 2: Dependencies And Security

**Files:** `package.json`, `yarn.lock`, audit evidence and maintenance documentation.

- [x] Integrate PR #21 content: updater 6.8.11, builder 26.18.0, rolldown 1.2.15.
- [x] Refresh compatible transitive branches for fast-uri/js-yaml and build-tool advisories, with no blanket major resolutions.
- [x] Run immutable install, production/full audit, syntax/contracts and lint. Record any unsupported/deprecated dependency separately.
- [ ] Verify actual staged/committed package versions and commit scoped changes.

### Task 3: CI Maintenance

**Files:** `.github/workflows/*.yml`, `.github/dependabot.yml` if needed, associated workflow-contract tests.

- [x] Read major release migration notes/action manifests and add/update failing workflow tests.
- [x] Update checkout/setup/upload/download actions with hosted-runner compatibility; preserve project Node 24 and token/permission boundaries.
- [x] Include new tests, production audit and existing D3D11 gates in validation/sync CI without weakening manual-review rules.
- [ ] Validate YAML, workflow contracts and lint; commit.

### Task 4: New Core Candidate

**Files:** candidate source-build config/lock, source provenance/patch tooling and tests, artifact-only workflow.

- [ ] Inspect complete MPV/FFmpeg changes and source compatibility, pin MPV 82667e3c and FFmpeg 86444dd3 (or document a compatibility-driven bounded alternative).
- [ ] Support unpatched upstream-native D3D11 provenance while preserving verification of the historical patched source bundle.
- [ ] Run source/environment/preflight tests before the expensive compilation; commit candidate build inputs.
- [ ] Push only the update/candidate branch as needed for the artifact-only DLL build. No release or production-pin promotion in this step.
- [ ] Verify the finished DLL/SDK/API/imports and independently audit complete sources/notices; preserve exact accepted inputs.

### Task 5: Application Acceptance

**Files:** runtime pins only after candidate acceptance, build/package contracts, maintenance/user-facing release notes.

- [ ] Build the full Windows Desktop candidate, not a standalone player; retain isolated test profile/updater-off.
- [ ] Run native/transport/lifecycle and full packaged playback, controls/orientation/GPU-recovery tests.
- [ ] Repeat sustained H264/HEVC/Main10 and real 80+ GB 4K scene acceptance; no CPU-copy or UI-freeze regression.
- [ ] Obtain one independent final review, resolve findings and record exact evidence/limits.
- [ ] Prepare one release only after acceptance; verify tag/package version, cross-platform CI, source assets and anonymous update metadata before publication.

## Progress

- Audit and clean checkout confirmed; implementation starting from main e9acfed.
- Local donor/window tests: 18 PASS, including RED-to-GREEN for the three new behaviors.
- Production and full dependency audits: zero advisory after compatible lockfile refresh; deprecations remain visible through the ordinary audit command.
- Existing player/updater/network/semantic-sync contracts and lint PASS. Candidate DLL work has not promoted or changed production runtime pins.
