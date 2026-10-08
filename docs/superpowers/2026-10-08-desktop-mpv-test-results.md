# Full LampaUa Desktop MPV Test Results

Local Windows x64 test build of the complete desktop app, not the earlier
standalone player. Production package/version remains `1.5.24`. No push, tag,
release, installation over the production app, Lampac edit or VPS change.

This is the historical `mpv.2` result. The current builder includes the subsequent
[Ytdl DASH/IPTV/SISI compatibility fix](2026-10-08-desktop-mpv-ytdl-dash.md)
and produces `mpv.3`; the artifact and acceptance evidence below describe `mpv.2`.

## Artifact

- File: `dist/mpv-desktop-test/lampaua-desktop-x64-1.5.24-mpv.2-portable.exe`
- Size: `126384917` bytes (120.53 MiB).
- SHA256: `b9dbec2ef999a9442d375188d70b29460369c1c4250b52b79c428aafb4cc14cd`
- Product: `LampaUa Desktop MPV Test`; appId: `com.lampaua.desktop.mpvtest`.
- Default profile: `%APPDATA%\LampaUaDesktopMpvTest`. No production-data migration.
- Unsigned portable, no administrator installation or separate Node/Git/mpv needed.
- Desktop autoUpdater is disabled even if the saved settings toggle says enabled.
  New-profile TorrServer autostart remains off; an existing server is not stopped.

The full `src`, `assets`, production dependency closure, local renderer bundle,
native addon, libmpv DLL, Vulkan loader and vendor notices are packaged. All staged
application file hashes are checked in afterPack. Native source is included as
`src/mpv-runtime/mpv-addon-source.txt`.

Final portable acceptance: **pass**. The exact EXE self-extracted and ran the full
desktop application; the unpacked build also passed the same acceptance suite.

## Verification

Final portable run: `.cache/mpv-desktop-test/evidence/run-1791453032800/results.json`.
Unpacked final run: `.cache/mpv-desktop-test/evidence/run-1791452560251/results.json`.
Both exited 0 with `ok: true`, 26 evidence records including 11 playback
observations and three expected media failures per run.

| Synthetic HTTP Input                            | Video         | Audio | Result |
| ----------------------------------------------- | ------------- | ----- | ------ |
| MP4                                             | H.264         | AAC   | Pass   |
| MKV                                             | H.264         | AC3   | Pass   |
| MKV                                             | H.264         | EAC3  | Pass   |
| AVI, XVID tag                                   | MPEG-4 Part 2 | MP3   | Pass   |
| MKV, two audio tracks and one embedded subtitle | H.264         | AC3   | Pass   |

The harness drives actual `Lampa.Player.play` / PlayerVideo, not a demo page.
It verifies pause stability, seeking, native volume 37, speed 1.5, mute/unmute,
audio/subtitle selection and restoration through Lampa's own loadeddata handler.
Nonblank moving video is pixel-checked: mean 82.6319, inter-frame delta 5.3918 in
the final portable run (unpacked: 82.6438 and 4.2577). Audio decoder/output reports
WASAPI; audible speakers are not established by these observations.

Lampa Timeline saved 20 seconds and resumed at 20.1463 seconds in the portable run
(unpacked: 20.2297 seconds). Repeated launches,
HTTP 404, a local-file redirect and a nested local-file playlist fail as expected,
then ordinary playback recovers. Both `https://kinohub.uk/` and
`http://lampaua.mooo.com/` play media with their original protocols. Reload retains
saved settings. Explicit external launch takes the real external route without
changing the saved inner default; its nonexistent test path deliberately prevents
an OS process launch. Existing external/UA contracts test that process bridge.

Twenty real native create/open/play/destroy cycles pass without a crash. Controlled
HTTPS request failure displays the existing error page; network recovery and close
during a new playback request pass. HTTP-only offline emulation is not an equivalent
test because the existing main-process protocol handler performs that fetch.

Main-frame, origin, owner, source, numeric-control, navigation creation barrier,
queued pipeline destruction, deferred seek, late track, stale track and GPU fallback
contracts pass. Optional GPU fallback is mock-tested, not a physical device-loss test.
Nine regression scripts pass, including all existing external/UA Player contracts.
Native/TypeScript compilation, changed-JS syntax checks, full Yarn lint and staging
hash/dependency checks pass. Test app PATH contains only Windows directories.
The production `LampaUa` profile file names, sizes and modification times remain
unchanged across the acceptance run. This is metadata comparison, not a disk trace.
An elevated, narrowly filtered post-run process inspection found no remaining
test-app or portable-wrapper processes.

Catalog, playback, embedded subtitle, settings, 800x600 settings and offline error
screenshots are retained in the evidence directory. Settings at 800x600 were
visually checked for overlapping text and controls.

## Review

One independent whole-change review reported five Important findings and one Minor
finding, no Critical findings. The final fix pass addresses all six:

- Mutex-protected native callback handles during access/replacement/release.
- Immutable per-launch route plus a temporary, nonpersistent desktop field override.
- Navigation readiness barrier rejecting creation from the departing document.
- Track metadata before loadeddata so Lampa restores its own selections.
- Optional renderer fallback without fatal media errors or unused WebGPU probing.
- Buffered interval compatible with Lampa's strict start-before-playhead check.

The reviewer did not independently run the native app. Post-fix evidence comes from
the local regression and full-app acceptance commands above, not a second review.

## Rebuild

```powershell
node D:\opt\lampaua-desktop\scripts\build-win-mpv-test.cjs
node D:\opt\lampaua-desktop\scripts\verify-mpv-desktop.cjs --exe D:\opt\lampaua-desktop\dist\mpv-desktop-test\lampaua-desktop-x64-1.5.24-mpv.2-portable.exe
node C:\Users\stpuh\AppData\Local\node\corepack\v1\yarn\4.9.4\yarn.js lint
```

The builder uses the existing `.cache/mpv-prototype` SDK/tool cache. It is a pinned
local rebuild flow, not a cold-machine dependency installer. Retain that cache or
provision the same inputs before rebuilding. Native sources are maintained under
`third_party/electron-mpv-video`, not copied back from the cache.

- Electron 43.7.5 official ZIP SHA256:
  `7acfa0646793f912ff983c8db8c3a145dc18ee40fe3d11a01840fd59cb76e5a2`.
  Cached electron.exe, ffmpeg.dll and vulkan-1.dll were byte/hash compared with it;
  their hashes are enforced by the builder.
- Vendor commit: `4944079b4133715848ea3c3bdaf99742b8c68406`, MIT, plus local fixes.
- Shinchiro baseline x64 SDK `mpv-dev-x86_64-20261008-git-36bf3d5290.7z`, SHA256:
  `1e94b722d9d1b701406250c73ee37d73cd0045cdf47bdd7a54f2bea1b513465f`.
- libmpv DLL SHA256:
  `bde5eb098b65b0908be4176c2f331bab25a101881a9232b8beef0c0d3ab8ad87`.
- Node 24.15.0, node-gyp 12.4.0, Python 3.12.14, VS2026/MSVC 14.51.36231,
  electron-builder 26.15.3, installed vendor TypeScript/Rolldown tooling.

The addon links a static MSVC runtime; its inspected imports require Windows DLLs
and the bundled libmpv. libmpv additionally requires the bundled Vulkan loader.
electron-builder warns that its optional Yarn discovery cannot find a `yarn`
command in PATH; copied dependency resolution, afterPack and runtime tests pass.

## Limits

No real TorrServer torrent, physical audio, long-duration viewing, A/V sync,
high-resolution performance, hardware decoding or physical GPU/device-loss test.
Synthetic AVI/Xvid success does not mean every AVI variant will play. Windows
hardware decoding remains disabled by the pinned native defaults. Native decoding
runs inside Electron, not a separately isolated utility process.

No production-ready or public-redistribution claim. Exact libmpv/FFmpeg license
compliance and a runtime update policy remain gates before any public release.
No change was made to production dependencies, version or release workflows.
