# Vendored electron-mpv-video

Source: https://github.com/yscoder/electron-mpv-video
Commit: `4944079b4133715848ea3c3bdaf99742b8c68406`. License: MIT.

The source subset retains the reviewed native teardown/nonblocking-render and
shared-texture lifetime fixes in the earlier prototype patch. Desktop-specific
changes add owner authorization, HTTP-only input, bounded speed/track controls
and sanitized metadata. Binaries and SDKs remain build inputs, not source.
