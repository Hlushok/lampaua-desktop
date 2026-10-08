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
