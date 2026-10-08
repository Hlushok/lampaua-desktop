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
