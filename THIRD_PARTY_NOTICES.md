# Third-Party Components

LampaUa Desktop 2.x is distributed under GPL-3.0-or-later. Retain all original
copyright and license notices. This is an unofficial fork, not an official
release of Lampa, Electron or mpv.

## Application Sources

- Base desktop client: https://github.com/Kolovatoff/lampa-desktop
- LampaUa modifications: https://github.com/Hlushok/lampaua-desktop
- Codec-runtime integration donor: https://github.com/ARST113/lampa-desktop
- MPV integration: https://github.com/yscoder/electron-mpv-video,
  commit 4944079b4133715848ea3c3bdaf99742b8c68406, MIT. Its license and
  LampaUa patch provenance are included under src/mpv-runtime.

## Windows x64 Runtime

- Electron 44.4.4 AC3/EAC3: https://github.com/ARST113/electron,
  tag v44.4.4-ac3-eac3. Electron/Chromium license files remain in the package.
- libmpv: https://github.com/shinchiro/mpv-winbuild-cmake, tag 20261008,
  asset mpv-dev-x86_64-20261008-git-36bf3d5290.7z.
- mpv source: https://github.com/mpv-player/mpv, commit 36bf3d5290.
- FFmpeg source: https://github.com/FFmpeg/FFmpeg, commit 5d4755f7d.

The selected libmpv contains GPL components and FFmpeg configured with
--enable-gpl and --enable-version3. Do not describe this binary as LGPL-only.
Its linked dependencies retain their respective licenses.

See docs/release-maintenance.md for the source-compliance and release gates.
The source of our native addon, integration, build recipes and dependency lock
is public at the exact application release tag. A link to upstream alone is not
a substitute for preserving the corresponding source of bundled binary inputs.
