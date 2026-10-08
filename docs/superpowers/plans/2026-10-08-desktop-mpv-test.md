# Full LampaUa Desktop MPV Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the complete LampaUa Desktop as a local Windows x64 portable EXE with embedded libmpv and Lampa's playback controls.

**Architecture:** Keep the current desktop application and inject a locally bundled PlayerVideo adapter. A video-like facade wraps the vendor's rendering element, translating Lampa controls and native events. A test-only bootstrap and authenticated, owner-scoped IPC isolate the experimental runtime from production.

**Tech Stack:** Electron 43.7.5, CommonJS desktop modules, TypeScript electron-mpv-video, C++ Node-API addon, libmpv, electron-builder 26.15.3, Node contract scripts.

**Spec:** `docs/superpowers/specs/2026-10-08-desktop-mpv-test-design.md`

## Global Constraints

- Windows x64 only; Electron `43.7.5` and vendor commit `4944079b4133715848ea3c3bdaf99742b8c68406`.
- Profile `LampaUaDesktopMpvTest`; appId `com.lampaua.desktop.mpvtest`; no production-profile migration.
- Staged version `1.5.24-mpv.2`; artifact `dist/mpv-desktop-test/lampaua-desktop-x64-1.5.24-mpv.2-portable.exe`.
- Preserve `https://kinohub.uk/` and `http://lampaua.mooo.com/`, including their different protocols.
- No edits to Lampac, JackTor, VPS or `wwwroot/lampa-main`; read-only reference inspection is allowed.
- No push, tag, release or production package/version changes. Keep unrelated worktree changes.
- Test mode disables desktop autoUpdater regardless of saved `autoUpdate`; new-profile TorrServer autostart stays off.
- Only attached main-frame senders on the two trusted Lampa origins can use MPV IPC; all media sources must be absolute HTTP/HTTPS URLs.
- Keep existing external-player and UA Player contracts; do not force external selections into embedded playback.
- Embedded audio/subtitle selection, playback speed, pause, seek, volume and position persistence are acceptance requirements.
- No DRM, Chromecast, PiP, external plugin subtitles or decoder utility-process redesign in this test build.
- Tests of synthetic HTTP streams do not establish compatibility with a real TorrServer torrent.

## Review Focus

1. An explicit external `launch_player` must win even if saved defaults select the embedded player (Task 4).
2. Closing or navigating during asynchronous session creation must not resurrect a native player or update a new playback with stale events (Tasks 2 and 3).
3. Missing duration and late track metadata must not break resume seeks or retain track selections from a previous file (Task 3).
4. HTTP redirects or nested references must not bypass the media-source protocol boundary to open local files (Task 2).
5. Portable self-extraction, an unavailable Lampa site and a machine without developer tools must not hide startup failures or leave an orphaned test process (Tasks 5 and 6).

## File Structure

- `src/mpv-test-main.js`: staged test entrypoint; establish identity/profile before loading `src/main.js`.
- `src/modules/mpv/testMode.js`: read the staged package marker; ordinary builds are always inactive.
- `src/modules/mpv/manager.js`: own the vendor service and BrowserWindow attachment/cleanup.
- `src/mpv/lampa-adapter.js`: video facade, track objects and HTML-media-compatible events.
- `src/mpv/renderer-entry.mjs`: define the rendering element and register the adapter; bundled locally.
- `third_party/electron-mpv-video/`: pinned vendor sources, license and modified sources; no demo, downloaded runtime, node_modules or build output committed.
- `scripts/build-win-mpv-test.cjs`: verify inputs, compile vendor/native runtime, stage the full application and build portable.
- `scripts/verify-mpv-test-isolation.js`, `scripts/verify-mpv-ipc-contract.js`, `scripts/verify-mpv-lampa-contract.js`: mock-based regression contracts.
- `scripts/verify-mpv-desktop.cjs`: parent-owned Electron integration harness with deadlines and exact process cleanup.
- `docs/superpowers/2026-10-08-desktop-mpv-test-results.md`: commands, artifact digest and actual verification limits.

## Task 1: Isolated Full-Application Startup

**Files:** Create test entrypoint, testMode and isolation contract script. Modify `src/main.js`, `src/modules/autoUpdater.js` and `src/modules/lampaInitializer.js` only at test-mode boundaries.

**Interfaces:** `isMpvTest(): boolean` reads `lampauaMpvTest === true` from the app package. `bootstrapMpvTest(app): void` sets appId/userData before any store or single-instance imports. Neither a renderer argument nor a URL can enable test mode in an ordinary build. Under that marker only, `--mpv-test-run=<id>` accepts `[a-z0-9-]{1,64}` and selects `appData/LampaUaDesktopMpvTest-<id>` for automated tests; it never accepts an arbitrary profile path.

- [ ] Write isolation tests using mocked Electron and store: identity is set before `requestSingleInstanceLock`; root package does not enable MPV; test startup never invokes autoUpdater even with `autoUpdate=true`; test defaults use `inner`; saved player selections remain unchanged on later starts; traversal/path inputs in test run IDs are rejected.
- [ ] Run `node scripts/verify-mpv-test-isolation.js`; confirm failures correspond to missing bootstrap and test-mode guards.
- [ ] Implement the entrypoint and marker reader. Stage `main: src/mpv-test-main.js` and the marker only in the test package. Preserve the ordinary entrypoint and production initialization behavior.
- [ ] Guard updater setup at its entry, so callers cannot accidentally reactivate it. Audit for manual desktop update IPC; if present, return `{supported:false, reason:"mpv-test"}` rather than installing an update. TorrServer update commands are not desktop update commands.
- [ ] Implement first-install embedded defaults without overwriting saved values. Verify any existing player-path initializer cannot silently change `inner` back to an external player.
- [ ] Run the isolation contract plus `node scripts/verify-external-player-contract.js`; require exit code 0, then make a local scoped commit of this task only.

## Task 2: Owner-Scoped Native Playback and Track Controls

**Files:** Create the pinned `third_party/electron-mpv-video` source subset and IPC contract script. Modify vendor `src/shared/types.ts`, `src/main/mpv-service.ts`, `src/preload/index.cts` and `native/mpv-addon/src/mpv_addon.cc`.

**Interfaces:** Extend `MpvMainOptions` with `authorize(event: IpcMainInvokeEvent): boolean`. Add session methods `setSpeed(value: number): Promise<void>`, `setAudioTrack(id: number | "no"): Promise<void>` and `setSubtitleTrack(id: number | "no"): Promise<void>`. Matching native methods return void or throw. Track events expose only `{id,type,title,lang,selected}`; end-file events include their native reason.

- [ ] Write mock IPC tests: only an attached main frame at a trusted origin passes; another renderer's player ID fails; subframes fail; `file:`, `lavfi:`, relative sources and Windows paths fail; HTTP and HTTPS pass; commands after navigation/destroy fail; track IDs must exist in the matching typed track list; invalid speed/volume values fail before native calls.
- [ ] Run `node scripts/verify-mpv-ipc-contract.js` and confirm expected failures. Vendor the pinned sources mechanically, retain MIT notices and apply the documented prototype patch; include provenance rather than treating cache files as maintained source.
- [ ] Apply authorization on every IPC operation, including create/destroy. Capture webContents IDs before destruction; clear sessions on navigation/destroy. Serialize per-session operations, cap active sessions to one per owner, and reject commands against stale generations.
- [ ] Implement only bounded controls: finite speed `0.25..4`, finite volume `0..100`, nonnegative finite seek seconds, existing typed audio/subtitle IDs or `"no"`. Observe `track-list`, `aid`, `sid`, `speed`, cache state and end reasons; convert the native track list to the specified fields rather than exposing arbitrary native properties/commands.
- [ ] Disable native config/scripts, companion-file autoload and unsafe references. Set `access-references=no`, `autoload-files=no`, `load-unsafe-playlists=no`; configure FFmpeg protocol allowlists via `stream-lavf-o` and `demuxer-lavf-o` for HTTP/HTTPS transport only. Use option-map APIs to avoid comma-escaping errors. Check every native option result. Add native HTTP fixtures with local-file redirect/reference targets and assert they fail without reading the target; verify ordinary HTTP media still plays. References: [mpv options](https://mpv.io/manual/stable/#options-access-references), [FFmpeg protocol whitelist](https://ffmpeg.org/ffmpeg-protocols.html#Protocol-Options).
- [ ] Compile against Electron 43.7.5 with the root node-gyp that supports the installed VS toolchain; use the pinned SDK and verify its SHA256. Run IPC contracts and native control checks; commit only maintained sources/tests/provenance, not SDK binaries or build caches.

## Task 3: Lampa-Compatible Video Facade

**Files:** Create `src/mpv/lampa-adapter.js` and Lampa contract tests. Modify vendor `src/renderer/mpv-video.ts` for explicit speed/track methods forwarding to Task 2's session API.

**Interfaces:** `createMpvVideo(onVideo: (video: HTMLElement) => void): HTMLElement` returns the display container and calls `onVideo` synchronously with its media facade. The facade implements the media fields/methods named in the spec. `installLampaMpvAdapter(Lampa, api): void` is idempotent. Renderer extension methods keep Task 2's names/signatures.

- [ ] Write facade tests with a DOM/session stub: volume `0.37` becomes native `37`; mute restores the prior volume when disabled; `currentTime=5` queues an absolute seek; play/pause/speed produce the correct native commands; state events emit expected media events; EOF alone emits ended; native error maps to a media error.
- [ ] Test create/destroy racing, repeated destroy, stale events, duration initially zero, resume seek before file-loaded, empty track lists, late tracks, selecting one track disables siblings, and opening a new file clears prior track objects/selections.
- [ ] Run `node scripts/verify-mpv-lampa-contract.js`; record the missing-facade failures before implementation.
- [ ] Implement a wrapper HTMLElement containing the vendor rendering element, not a global override of HTMLVideoElement. Keep facade volume units `0..1` separate from the renderer's `0..100`. Queue commands until creation/file-loaded as appropriate; capture generation for each async callback and dispose listeners on destruction.
- [ ] Translate waiting/playing/canplay/loadeddata/timeupdate/progress/ended/error events into the existing Lampa flow. Supply audioTracks/textTracks objects with setters for native selection, stable IDs, labels/languages and disabled/showing states. Do not claim buffered coverage when native cache metadata is unavailable.
- [ ] Run facade and IPC contracts, then the existing UA Player session/progress/dispatch/normalization scripts; all must exit 0. Make a local commit of the facade and renderer extension.

## Task 4: Integrate With the Actual Lampa Window

**Files:** Create `src/modules/mpv/manager.js` and `src/mpv/renderer-entry.mjs`. Modify `src/modules/windowManager.js`, `src/modules/pluginHandler.js`, `src/preload.js` and test-only main initialization/shutdown hooks.

**Interfaces:** `attachMpvWindow(window: BrowserWindow): Promise<void>` initializes once and binds the service; `detachMpvWindow(window): Promise<void>` removes its sessions; `disposeMpv(): Promise<void>` is idempotent. Authorization checks `senderFrame === sender.mainFrame` plus the trusted origin and attachment. Adapter injection follows successful Lampa initialization and uses a packaged local bundle.

- [ ] Add routing tests for inner defaults, explicit external launch overrides, saved external choices, torrent/non-torrent settings, YouTube and missing adapter capability. Assert external sources do not match the MPV registration and existing external-player dispatch stays intact.
- [ ] Read current Lampa start/playdata behavior to determine the effective player for each source. Implement the registration predicate from that actual context; never register a blanket HTTP matcher. Keep the local read-only Lampa reference unchanged.
- [ ] Attach the service before loading Lampa, expose the API only in test mode, and inject the bundled entrypoint once per document. The initial URL remains the configured allowed Lampa URL. Close/navigation cancels outstanding initialization and disposes MPV before the window/service is destroyed.
- [ ] Keep Lampa's PlayerVideo bindings as the authoritative controls and position clock; do not write an independent player toolbar or history store. Confirm first-load defaults and player-finder callbacks do not undo user choices.
- [ ] Run routing/facade contracts and a development Electron check through actual `Lampa.Player.play` with a loopback HTTP fixture: assert PlayerVideo reports native time and the normal panel is present. Test navigation/reload and close during playback with a parent deadline.
- [ ] Run syntax checks on modified JS and root lint; commit the narrowly scoped integration after passing checks.

## Task 5: Reproducible Portable Build of the Full App

**Files:** Create `scripts/build-win-mpv-test.cjs`; extend only generated-directory and pinned-vendor lint/format ignores if necessary. Verify vendor sources through their TypeScript/native compilation and contract tests rather than rewriting their formatting. Do not change production dependencies or root package/build scripts.

**Interfaces:** `node scripts/build-win-mpv-test.cjs` verifies pinned inputs, compiles the renderer/native addon, stages the app, and returns only after electron-builder completes. Output includes the EXE, digest manifest and third-party notices. Missing inputs, compile failures or missing runtime files yield nonzero exit.

- [ ] Add staging checks: test package has the exact marker/entrypoint/version; complete current `src` and `assets` are present; production dependency closure resolves; native DLL/addon hashes match; no prototype standalone HTML/main substitutes for the desktop app; updater publish config is absent.
- [ ] Implement clean, uniquely named staging under `.cache/mpv-desktop-test`; copy production dependencies from the installed dependency graph. Bundle the renderer with the vendor's installed build tooling; no browser CDN imports. Document the exact tool invocation and pin hashes of runtime inputs.
- [ ] Package with root electron-builder, `publish:"never"`, portable Windows x64 target, separate productName/appId, cached official Electron 43.7.5 and output `dist/mpv-desktop-test`. Include libmpv, addon, Vulkan loader, licenses and source/patch provenance; unpack native libraries as required.
- [ ] In afterPack verify all required resources and hashes. Run an unpacked-app smoke before portable compression; it must load the complete desktop UI and native player rather than just start a process.
- [ ] Build the EXE and inspect extracted resources. Run with PATH restricted to Windows directories; confirm no Node/Git/mpv executable is required, update metadata cannot be consumed, and the production profile is untouched. Commit only the build script and related maintained source, never EXE/cache files.

## Task 6: Actual-App Acceptance and Delivery

**Files:** Create `scripts/verify-mpv-desktop.cjs` and `docs/superpowers/2026-10-08-desktop-mpv-test-results.md`. Generated fixtures/evidence remain under `.cache/mpv-desktop-test`.

**Interfaces:** `node scripts/verify-mpv-desktop.cjs --exe <absolute-path>` launches the exact EXE and exits 0 only after all required assertions and owned-process cleanup pass. The harness uses Task 1's unique test run ID, a loopback HTTP Range server and a parent deadline; it never kills processes matched broadly by name. It drives the real main-frame Lampa through Chromium's loopback-only debugging endpoint, enabled for this invocation only, and observes the adapter's native events. Normal user startup does not enable remote debugging or a test media menu.

- [ ] Generate fixtures for MP4/H264/AAC, MKV/AC3, MKV/EAC3 and AVI/Xvid/MP3, plus one MKV with two audio tracks and an embedded subtitle. Tests must invoke actual Lampa PlayerVideo, not a standalone renderer test page. Capture evidence per run with expected codecs/duration/track counts.
- [ ] Exercise Lampa pause, seek, volume, mute, speed, audio selection, subtitle selection/visibility and save/resume. Assert native observations, stable paused time, resumed advancing time and nonblank changing frame pixels; keep UI screenshots for panel/catalog/settings and check no overlapping controls at supported window sizes.
- [ ] Exercise two consecutive starts, 404/invalid media then recovery, navigation, reload and closing during creation/playback. Test unavailable-site startup without hanging the harness. Assert no owned leftover processes and no production-profile changes.
- [ ] Verify both allowed Lampa origins and routing/settings preservation; run negative main-frame/ownership/source IPC tests. If either live site is unavailable, report that exact acceptance gap rather than treating a mock as a live-site pass.
- [ ] Run `node --check` for changed JS, root Yarn lint, all existing external/UA contract scripts, new contracts, then acceptance against the final portable EXE. Request one independent whole-change review and address actionable findings before reporting completion.
- [ ] Compute final SHA256/size, write the result report with actual pass/failure counts and limits, then link the complete-app EXE to the user. State separately whether a real TorrServer stream and physical audio output were tested. Do not publish.

## Execution Handoff

Recommended method: **Native**. Implement the six tasks in this chat with the plan tracking progress, then request one independent whole-change review. The facade, native events and Lampa routing share tightly coupled contracts, so retaining one implementation context is useful. Subagent-driven task-by-task implementation is an alternative if the user prefers independent review after every task.

Implementation begins only after the user reviews this plan and chooses the execution method.
