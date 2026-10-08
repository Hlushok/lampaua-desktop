# Desktop MPV Test: Ytdl DASH Compatibility

Historical `mpv.3` results. The current builder produces `mpv.6`; see the
[real-stream transport follow-up](2026-10-08-desktop-mpv-real-stream-fix.md).

## Scope

Local follow-up to the full-app `1.5.24-mpv.2` prototype. Preserve the ordinary
desktop build, existing external-player routes, the Ytdl module and VPS. No push,
tag or public release. Deliver a new local `1.5.24-mpv.3` portable after verification.

## Diagnosis

The existing Ytdl plugin wraps `Lampa.PlayerVideo.url`. For `/ytdl/manifest?` it
creates the fallback player, then initializes browser dash.js on that element.
dash.js requires an AUDIO/VIDEO DOM element; the MPV facade is a DIV. Consequently
the wrapper selects its 360p fallback instead of passing the manifest to libmpv.

## Work

- [x] Add a failing regression for Ytdl installed before and after the MPV adapter.
- [x] Route only Ytdl manifests through a private, decoded-before-IPC MPV source
      token. Preserve the exact HTTP/HTTPS URL, query/auth data, ordinary browser
      route, plugin delegation and external-player selection. Keep the native
      HTTP/HTTPS-only policy unchanged.
- [x] Verify native DASH with separate audio/video segments, quality switching,
      pause/seek, failure recovery and local-reference rejection in the full app.
- [x] Verify IPTV HLS and direct HTTP MPEG-TS, switching between channels and
      retaining existing external routes. Do not claim untested UDP/RTSP, DRM,
      provider authentication or arbitrary IPTV headers are supported.
- [x] Preserve SISI ("Polunychka") HTTP media headers for MP4/HLS. Reject injected,
      oversized and transport-controlled headers; clear them on the next source.
      Use synthetic protected fixtures, not real adult-site content.
- [x] Run syntax, all regression contracts, lint and staging checks; rebuild and
      verify the final portable. Record hashes and explicit remaining test limits.

## Results

Regression tests first reproduced Ytdl's fallback and missing native headers,
then passed after the fix. Both plugin load orders are covered. Full-app testing
also reproduced segment rejection: libmpv logged that `access-references=no`
blocked the first DASH initialization segment.

The main process now derives only `dash`, `hls` or `auto` from the validated URL.
Native DASH/HLS opens force the corresponding lavf demuxer and enable references
with the existing protocol whitelist still in place. Ordinary inputs reset this
state and retain references disabled. The built-in local ytdl subprocess fallback
is disabled; the existing server-side module still resolves YouTube.

References: [mpv reference handling](https://mpv.io/manual/stable/#options-access-references),
[nested lavf protocol validation](https://github.com/mpv-player/mpv/blob/master/demux/demux_lavf.c),
[HTTP header fields](https://mpv.io/manual/stable/#options-http-header-fields).

Unpacked acceptance passed, exit 0:
`.cache/mpv-desktop-test/evidence/run-1791456863704/results.json`.
Final portable acceptance passed, exit 0:
`.cache/mpv-desktop-test/evidence/run-1791457365451/results.json`.
The final suite additionally rejects a local-file reference inside a forced HLS
manifest, not just an ordinary playlist. It records `ok: true`, 40 evidence
records, 17 playback observations and seven expected failures.

The actual local Ytdl plugin's three DASH functions are parsed with Acorn and run
against the real Lampa UI. The original module is read-only; its full source SHA256
is `9facdcaa0ad1bff12567a64917ea3fb2355c31f9a87648ec8aa96b618fc9f16d`.
The backend is represented by a loopback HTTP fixture server: separate video/audio
DASH at 1280x720 and 1920x1080, HLS VOD, a non-ending HLS playlist and MPEG-TS.
Protected MP4/HLS fixtures require synthetic Referer, User-Agent and Authorization
headers. No real YouTube, IPTV-provider or adult-site media was fetched.

## Artifact

- File: `dist/mpv-desktop-test/lampaua-desktop-x64-1.5.24-mpv.3-portable.exe`.
- Size: `126388248` bytes (120.53 MiB).
- SHA256: `720ea07d9392550503cbbae4bc7e40c34f0d84552f0eb2f9b2506f83f9bb68ae`.
- Unsigned full-app portable; no separate Node, Git or mpv installation needed.
- Separate default profile: `%APPDATA%\LampaUaDesktopMpvTest`.
- Desktop autoUpdater remains disabled for this test build.
- Production `package.json`, `yarn.lock` and workflows are unchanged.

The exact final EXE self-extracted and passed the full-app suite. Original tests
also passed: H.264/AAC, AC3, EAC3, AVI/Xvid/MP3, two audio tracks, embedded
subtitles, pause/seek/volume/speed, timeline position restoration, repeated starts,
reload, both configured HTTP/HTTPS origins, offline recovery and 20 native
create/open/play/destroy cycles. The final run saved 21 seconds and resumed at
21.063 seconds. WASAPI and the audio decoder were observed, not physical sound.

Native/TypeScript compilation, MPV script syntax checks, full Yarn lint, staging
hash/dependency checks and all ten regression scripts pass. Existing external and
UA Player contracts remain green. DASH and IPTV screenshots were visually checked;
the moving-frame pixel check also passed. Production profile file metadata remains
unchanged. The acceptance process exited cleanly. A separate test-app instance
started before this run was left untouched; no new acceptance processes remained.

## Rebuild And Verify

```powershell
node scripts/create-mpv-stream-fixtures.cjs
node scripts/build-win-mpv-test.cjs
node scripts/verify-mpv-staging.js
node scripts/verify-mpv-desktop.cjs --exe D:/opt/lampaua-desktop/dist/mpv-desktop-test/lampaua-desktop-x64-1.5.24-mpv.3-portable.exe
node C:/Users/stpuh/AppData/Local/node/corepack/v1/yarn/4.9.4/yarn.js lint
```

Run from `D:\opt\lampaua-desktop`. The pinned SDK/tool cache and original media
fixtures described in the previous report are prerequisites. FFmpeg is needed
only to generate fixtures, not to run the packaged app. The full-app harness reads
the local Ytdl plugin at `../lampac/module/Ytdl/plugins/ytdl.js`; `--ytdl-plugin`
can select another read-only source. The test application's PATH contains only
Windows directories, excluding external development runtimes.

## Remaining Limits

No real YouTube, TorrServer, IPTV provider or adult site was tested. The non-ending
HLS fixture verifies startup and channel switching, not a long-running live
provider. DRM, UDP/RTSP, provider-specific authentication, extensionless manifests,
external HTTP subtitles, physical audio, long-viewing performance and hardware
device loss are not established by this suite. Do not infer that every site,
channel or AVI codec is supported. Changes and the portable remain local; no
push, tag, public release, production installation, Lampac or VPS modification.
