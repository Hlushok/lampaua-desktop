# Vendored electron-mpv-video

Source: https://github.com/yscoder/electron-mpv-video
Commit: `4944079b4133715848ea3c3bdaf99742b8c68406`. License: MIT.

The source subset retains the reviewed native teardown/nonblocking-render and
shared-texture lifetime fixes in the earlier prototype patch. Desktop-specific
changes add owner authorization, HTTP-only input, bounded speed/track controls
and sanitized metadata. Binaries and SDKs remain build inputs, not source.

The Ytdl/IPTV/SISI follow-up adds bounded, validated per-open HTTP headers. Native
opens replace the entire header list, including an empty list for the next source;
pipeline restoration retains only the current session's explicit headers.
Only main-derived DASH/HLS inputs enable references, force their lavf demuxer and
retain the nested HTTP/HTTPS transport whitelist. Other sources keep references
disabled. The built-in ytdl subprocess fallback is disabled; resolution remains
with the existing server module.

The native DASH follow-up uses 1 MiB curl range requests; other inputs reset
this cap. This bounds requests but is not a general fix for real-stream failures.
Native error logs expose only a validated HTTP status,
not URLs or provider text. HTTP failures map to Lampa's network-error category.
The optional test-only diagnostic sink records lifecycle stages and safe codes.

The mpv.5 Desktop adapter preserves Ytdl's browser dash.js route instead of
rewriting its manifest into a native source. Its nested progressive bootstrap
must receive a real VIDEO element in either plugin load order. Generic .mpd,
IPTV and SISI inputs retain the native route. The complete test app now uses the
already pinned production AC3/EAC3 Electron runtime from
build/electron-runtime-ac3-eac3.json, rather than the older official prototype
runtime. The existing donor runtime, ffmpeg.dll and archive hashes are verified;
no new Electron fork or server-module changes are involved.

The mpv.6 follow-up recognizes extensionless `/lite/iptvportal/api/stream` inputs
by inspecting only the encoded HTTP/HTTPS target for a manifest extension. It
does not rewrite the signed URL, perform an extra request or allow new protocols.
Malformed/non-HTTP targets retain automatic format detection. Native TS and the
existing nested HTTP/HTTPS whitelist are unchanged.

The 2026-10-21 UI-freeze follow-up moves software frame rendering into a native
AsyncWorker. Only one frame per player may be in flight; teardown waits for it,
and main never forwards a completed frame after the owner starts closing.
Runtime commands use libmpv's async API with one request in flight to preserve
header/format/load/control order. The bounded queue retains payload storage and
reports failed replies through command-error instead of blocking Electron.
Failed requests cancel the pending queue so loadfile cannot use stale headers
after a source-preparation error. Explicit destruction returns a promise:
software render-context cleanup and core termination run in a CleanupWorker,
with the native owner referenced until completion. OpenGL resources remain on
their owning thread; core termination still runs on the worker.
The SDK, libmpv DLL, Electron pins and input whitelist are unchanged. Window/app
shutdown has deadlines for slow outstanding native work. This is not a claim
that software decoding or HDR conversion can sustain every 4K stream.
Windows now defaults to auto-copy hardware decoding, which returns CPU-visible
frames for the software renderer and falls back to software when unsupported.
The existing MPV_HWDEC environment override remains available for diagnostics.
