# MPV Test: Real YouTube Range Requests And SISI Hang Investigation

## Scope

Current candidate: `1.5.24-mpv.5`. Restore the existing Ytdl browser DASH path
and use the same pinned Electron 44.4.4 AC3/EAC3 runtime as the installed
production 1.5.24. The following mpv.4 diagnosis is historical evidence, not a
verified explanation of the user's working production behavior.

Local follow-up to `1.5.24-mpv.3`, after the user's real-stream report. The
full Windows x64 app `1.5.24-mpv.4` is a diagnostic candidate, not an accepted
delivery: the original video's seek test still fails. No push, tag, release, production
installation, Lampac edit or VPS change. Preserve the separate test profile.

## Diagnosis

The image reports YouTube's generic decoding error. A read-only live probe using
a copy of the existing test profile reproduced it with the real Ytdl module.
The manifest was HTTP 200, with H.264/AAC `SegmentBase` representations and
same-origin `/ytdl/track/` URLs carrying the copied profile's UID, but no auth
token. Native DASH opening failed before
decoding: the first track returned HTTP 503.

The differentiator is the Range end, not the User-Agent. A bounded request
`bytes=0-1023` returned HTTP 206 for both audio and video. An open-ended `bytes=0-`
request returned HTTP 503 and the site's maintenance HTML, including when using
the same browser User-Agent. Enabling 1 MiB curl requests in the same pinned
libmpv DLL opened both tracks and detected the DASH format. This establishes the
observed transport incompatibility, not the internal reason the proxy rejects
that request. No server configuration was changed.

The previous fixture suite used `SegmentTemplate` files on a permissive loopback
server. It did not reproduce this server behavior. The updated fixture server
rejects unbounded DASH track requests. The old mpv.3 EXE fails this regression.

## Changes

- DASH opens use `curl-max-request-size=1048576`; other inputs reset it to zero.
  The existing HTTP/HTTPS and nested-protocol policies remain unchanged.
- Native error logging forwards only validated HTTP 400-599 status codes, not
  arbitrary log text, URLs or credentials. HTTP errors map to Lampa's network
  error category instead of always reporting a decoding error. The native
  bridge drains buffered logs before assigning the final error: libmpv delivers
  the curl error log after its matching `end-file` event in this runtime.
- A test-only lifecycle journal records open format, load/end, destroy stages
  and safe error codes. It rotates at 1 MiB and cannot interrupt playback if
  disk writes fail. Location: `%APPDATA%\LampaUaDesktopMpvTest\logs\mpv-test.jsonl`.
- Regression coverage includes redaction/rotation/write failure, HTTP error
  classification, bounded DASH requests and cancelled unresponsive MP4/HLS.

References: [mpv curl transport](https://github.com/mpv-player/mpv/blob/master/stream/stream_curl.c),
[curl request size option](https://github.com/mpv-player/mpv/blob/master/DOCS/man/options.rst).

## SISI

Windows Application Hang event 1002 confirms the test app stopped responding at
14:19 on 2026-10-08 (Europe/Kiev). The corresponding AppHangB1 report exists;
its archived dump is inaccessible with the current Windows permissions. No ACL
or system settings were changed.

The old mpv.3 cancels an HTTP MP4 source that never responds and starts the next
source in 2333 ms. The first mpv.4 unpacked run also cancels an unresponsive HLS
segment. These tests do not reproduce the user's exact SISI freeze. Its provider,
source and triggering action have not been supplied. Do not claim this freeze
is fixed. The new journal is intended to capture the next failure's stage.

## Authorization And Original Video

The user's provided authorization was used only for HTTPS `kinohub.uk` requests
in an isolated diagnostic run. `/ytdl/access` returned HTTP 200, `ok: true`,
group 3 and required group 3. Both manifest track URLs carried the token.
The code was not persisted in reports, source, Git, app settings or raw live
URL/manifest evidence. The production profile was not changed.

The exact video from the screenshot,
[Hej, sokoly - Nahrash band](https://www.youtube.com/watch?v=0vR6J2KGQEY),
opened at 1920x1080 with H.264/AAC and advanced past one second. Pause worked.
After an absolute seek to 45 seconds, playback stayed at 45 for the 50-second
test window, with no renderer error. Authorization therefore does not resolve
this remaining seek failure. Evidence: `diag-1791467183270/results.json` and
`diag-1791467487868/results.json` (sanitized, local and ignored).

An earlier unauthenticated native reproduction also blocked inside
`mpv_terminate_destroy` after seeking. Moving only termination to an async
worker kept Node responsive but did not finish termination within 65 seconds;
adding a 15-second network timeout did not resolve it either. Those experimental
changes were removed, including their temporary async IPC test. Do not treat
them as a fix or infer that they reproduce the user's exact SISI hang.

## Verification

### Follow-Up Transport Probes

The pinned runtime reports `mpv v0.41.0-1107-g36bf3d529` and FFmpeg
`N-127242-g5d4755f7d`. All following probes used the user's authorized stream
without saving raw URLs, manifest XML or the authorization code.

- Curl forced to HTTP/1.1 still received HTTP 503 after seeking, and termination
  did not finish before the 65-second child-process timeout
  (`diag-1791469714995/results.json`).
- FFmpeg HTTP initially rejected the TLS chain. A diagnostic-only export of
  Windows public trust roots allowed HTTPS verification to succeed; TLS was
  never disabled. With bounded FFmpeg requests, playback opened, but seek still
  stalled with partial-file warnings. Termination completed
  (`diag-1791470288426/results.json`). No CA export or alternate backend was
  integrated into the app.
- Opening the same video/audio tracks directly, without the DASH demuxer, also
  received HTTP 503 and then corrupt-packet warnings; termination completed
  (`diag-1791473350929/results.json`). Thus the failing transfers are not
  exclusive to the DASH demuxer.
- Browser requests reproduced the server response: eight complete 1-MiB video
  ranges returned HTTP 206, while the range beginning at byte 12467951 returned
  HTTP 503 twice (`diag-1791473487999/results.json`).
- At that same start offset, 1 KiB, 64 KiB and 256 KiB requests returned complete
  HTTP 206 responses, while 512 KiB and 1 MiB failed. Aligned neighboring 1-MiB
  requests also failed (`diag-1791473620620/results.json`). This is an observed
  size-sensitive failure at one region, not a universal safe limit.
- A complete DASH playback/seek probe capped at 256 KiB still received HTTP 503
  on another transfer and timed out during termination
  (`diag-1791473785630/results.json`). The smaller limit was therefore rejected
  and was not added to the app.

Range size is not video resolution, but smaller requests can constrain transport
throughput. Do not promise 4K reliability or lower the selected video quality as
a workaround. The remaining investigation needs the upstream transfer failure
and native cancellation addressed separately. Server logs have been requested
for read-only investigation; no server or Desktop transport changes were made
in this follow-up.

- [x] Reproduce real YouTube failure and compare bounded/open-ended requests.
- [x] Confirm old portable fails the bounded-range regression.
- [x] Run all eleven contract tests and TypeScript/native compilation.
- [ ] Verify real YouTube playback, pause and seek in the new full app.
- [x] Verify portable IPTV/SISI fixtures and network recovery; real seek remains blocked.
- [ ] Record artifact hash, lint/syntax/staging results and local commit.

Native and TypeScript compilation, all eleven contract scripts, changed-script
syntax checks, Yarn lint and staged file/dependency verification pass. A direct
native HTTP 404 probe now returns `HTTP 404`, rather than `loading failed`.

The full portable fixture suite passed (`run-1791463456660/results.json`), as
did real playback/pause/seek of a different YouTube song. These are not proof
that the screenshot video is fixed. A sequential network-only rerun
(`run-1791467601528/results.json`) also passed: cancelled MP4 recovered in
1863 ms, stalled HLS in 1554 ms and a partially received MP4 that had started
playback in 1927 ms. No remote publication or completion commit was made.

## Artifact

- File: `dist/mpv-desktop-test/lampaua-desktop-x64-1.5.24-mpv.4-portable.exe`.
- Size: `126393164` bytes.
- SHA256: `a9db9757fe50348790cc05438f97172307583afcd4bde442a3f6bf033b930102`.
- Unsigned full-app portable; separate default test profile, no production-data
  migration and no autoUpdater.
- Root production `package.json`, lockfile and release workflows are unchanged.

Evidence remains local under `.cache/mpv-desktop-test/evidence`. Live diagnostic
URLs and copied authenticated test data are ignored and must not be committed.

## mpv.5: Preserve Working Production Playback

The user confirmed that the installed/GitHub 1.5.24 plays YouTube. Earlier
diagnostics did not reproduce the exact installed environment or its profile;
HTTP failures from those probes are not grounds to modify the server or module.
Stop server investigation and repair only the Desktop integration.

Read-only comparison found that installed `C:/Program Files/LampaUa` and local
production `dist/win-unpacked` have the same app.asar SHA256
`78de9cb471beeb0a1592c54546e9a33204cc011414b8f26ba3417ef2f5136006`.
Installed FFmpeg matches the existing pinned AC3/EAC3 runtime, not the official
43.7.5 prototype input. The new test builder uses the already existing
`build/electron-runtime-ac3-eac3.json` (Electron 44.4.4), validates the archive,
runtime files and runtime version, and builds the addon against 44.4.4 headers.
No new Electron fork, production dependency/version change or server edit.

Ytdl manifests are no longer rewritten into native MPV sources. The existing
plugin initializes dash.js on a real VIDEO element, including its nested
progressive bootstrap call. A scoped, finally-reset guard excludes that call
from MPV for either plugin load order. Quality URLs and authentication are
unchanged; 2160p routing is covered without a forced 360p fallback. Generic .mpd,
IPTV and SISI remain native. A plugin exception must not disable subsequent
native playback.

The local Ytdl plugin remains unchanged, SHA256
`9facdcaa0ad1bff12567a64917ea3fb2355c31f9a87648ec8aa96b618fc9f16d`.
Its functions are read-only inputs to the test harness, not module edits.

Control runs showed real 720p playback/pause/seek with both stock browser DASH
(`diag-1791475712887`) and mpv.4 (`diag-1791475824431`). Diagnostic 1080p seek
failed in both engines. This does not invalidate the user's working installed
app: the diagnostic profile and forced quality are different. Do not claim
full 4K performance, a server root cause or a verified fix for an unidentified
real SISI provider hang.

The new full-app regression checks browser DASH switching 720p -> 1080p, separate
audio/video, pause/seek and no native surface; a failed DASH segment must allow
closing and immediate native playback. Generic native DASH still checks bounded
requests and the existing local-reference rejection policy.

Artifact (local candidate, unsigned):
`dist/mpv-desktop-test/lampaua-desktop-x64-1.5.24-mpv.5-portable.exe`,
134357915 bytes, SHA256
`85ba1fb59635873fe8a16a049b5739003904d58980046c14a1fbd1f1c43ef921`.
All eleven contracts, lint, syntax and diff checks passed before final portable
acceptance. Record final portable/real-stream evidence below after verification.

Final portable fixture acceptance passed, exit 0:
`run-1791477162825/results.json` (`ok: true`, 50 records, 22 playback observations).
Browser DASH quality switching and pause/seek passed without a 360p fallback or
native surface. Recovery from a failed DASH segment took 1138 ms. Generic native
DASH, protected SISI MP4/HLS, IPTV, AC3/EAC3 and AVI/Xvid fixtures passed; native
network recovery took 1131/1387/1204 ms. Repeated starts, 20 callback stress cycles,
offline recovery and production-profile metadata equality passed. This remains
fixture coverage, not proof for every real provider. One prior unpacked run
completed media checks but failed the production-profile snapshot during a
concurrent change; it was not counted as accepted.

Real authenticated portable test passed in `diag-1791477451186/results.json`:
access HTTP 200, allowed=true, group=3, requiredGroup=3. Both track URLs carried
authorization. The original screenshot video's 720p DASH rendered on a VIDEO
element (1280px width), pause was stable, seek to 45s resumed at 45.664206s and
the post-seek screenshot showed the actual video. No native MPV events occurred
on the YouTube path. This validates 720p only; it is not a 1080p/4K seek claim.

The original video's authenticated 1080p startup and pause/resume passed in
`diag-1791477783143/results.json`: actual VIDEO width 1920, continuous playback
reached 16.471493s, error=null. Seeking was not exercised in that run; earlier
1080p seek failures remain explicitly unresolved. Authorization was allowed
for group 3. The final EXE and unchanged Ytdl script hashes were rechecked.

Authenticated real 4K startup and pause/resume also passed in
`diag-1791477898724/results.json`, exit 0. The module offered 2160p for
"Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film". Its
manifest specified 3840x2160, 60fps, AV1 with separate AAC audio. The actual
VIDEO width was 3840, and playback reached 11.307044s with error=null during
the short post-resume observation. Both track URLs carried authorization;
access was allowed for group 3. This proves real 4K startup/short playback,
not sustained throughput or seeking. No module or server changes were made.

The user requested the complete local test app for their own test. Deliver the
existing verified mpv.5 portable above, not a standalone player and not a public
release. Keep production installation/profile untouched and updater disabled.
