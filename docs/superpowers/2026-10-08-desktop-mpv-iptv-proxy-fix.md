# MPV Test: Extensionless IPTV Portal HLS

## Scope

Local full-app follow-up to mpv.5. No server, IPTV module, Ytdl module, production
version, push, tag or release changes. Keep the test profile and existing pinned
Electron 44.4.4 AC3/EAC3 runtime.

## Evidence

The user's test-profile journal recorded two auto-format opens ending in
`unrecognized file format` at 16:51:20 and 16:51:39 UTC. No decoder had started.
Read-only probes of the two most recent sports channels (Arena Sport 1 HD and
Nova Sport 1 HD) returned HTTP 200, application/vnd.apple.mpegurl and #EXTM3U.
The signed playback path is `/lite/iptvportal/api/stream`, without an extension.
Both encoded target URLs end in .m3u8. Diagnostic URLs, target values, signatures
and profile data remain ignored local inputs, not report or Git content.

A local extensionless HLS proxy fixture reproduced the same failure in mpv.5:
`run-1791478686206/results.json`, time=0, error code=3,
message=`unrecognized file format`. The new IPC contract failed with auto != hls
before the implementation was changed.

## Fix

The main service recognizes this exact IPTV portal path and inspects its encoded
HTTP/HTTPS target to select the existing HLS/DASH format. The signed playback
URL itself is never rewritten. Non-manifest targets, malformed targets, non-HTTP
targets and unrelated paths retain auto detection. No fetch, additional request,
renderer-controlled format argument or new protocol is introduced.

The existing forced lavf HLS path and nested HTTP/HTTPS whitelist remain intact.
Unit coverage includes the new HTTPS and legacy HTTP site, exact URL preservation,
ordinary TS, malformed input and local-file target rejection. The full-app suite
adds an extensionless signed proxy fixture; existing native HLS local-reference
rejection, IPTV TS, YouTube browser DASH and SISI header tests remain in place.

## Verification

After TypeScript compilation, all eleven contracts and Yarn lint passed.
The fixed local proxy playback started H.264/AAC, but that short test run's final
production-profile metadata comparison failed during unrelated concurrent profile
changes. Do not count that run as complete acceptance; rerun the final suite.

The fixed unpacked mpv.6 app played both recent sports channels in sequence:
Arena Sport 1 HD reached 11.50 seconds with a 1920-pixel video width; Nova Sport
1 HD reached 6.04 seconds with a 1920-pixel video width. Neither reported a
playback error. The Nova screenshot was visually inspected and showed the actual
broadcast. Evidence: `diag-1791478862057/results.json`. This verifies these two
channels, not every IPTV provider or stream.

The full portable build completed successfully. Artifact:
`lampaua-desktop-x64-1.5.24-mpv.6-portable.exe`, 134351583 bytes, SHA-256
`e69ec653311a6422d9c074e3fe7d7cf46e2cd559ac5174825a621c5dd8932169`.
All eleven contracts and Yarn lint also passed against the final staging.
Final portable smoke passed: `run-1791479125553/results.json`, 51 records and
23 playback checks. The extensionless signed HLS fixture played H.264/AAC;
YouTube browser DASH, native DASH, IPTV HLS/TS, protected SISI headers, network
cancellation, stress cycles and offline recovery passed. The app exited cleanly
and the production profile metadata comparison passed. This supersedes the
incomplete earlier short fixture run without weakening that comparison.

The test artifact remains local and unsigned. No push, tag, public release or
production installation was performed.
