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
- libmpv: own baseline-x64 build, SDK lampaua-libmpv-x64-sdk.7z.
- Build recipes: https://github.com/shinchiro/mpv-winbuild-cmake,
  commit b2856ee6deed6957380b32465f359e67f67fafd8.
- mpv source: https://github.com/mpv-player/mpv,
  commit 36bf3d529059a947d6700adefeab3b421e537c19.
- FFmpeg source: https://github.com/FFmpeg/FFmpeg,
  commit 5d4755f7dd03d84f006d5a0ef7e3c114f52b3d77.

The selected libmpv contains GPL components and FFmpeg configured with
--enable-gpl and --enable-version3. Do not describe this binary as LGPL-only.
Its linked dependencies retain their respective licenses.

Original component notices and the source inventory are included under
licenses/libmpv. The inventory records captured source/build inputs and manual
follow-up for header-based notices and attribution. It does
not replace or relicense original source files. Electron's Vulkan loader and
Chromium/Electron notices remain with their original runtime distribution.

The exact corresponding-source archive is distributed as
lampaua-libmpv-x64-sources.tar.gz.001 and .002 alongside the SDK in this release.
Join the parts in that order and verify sourceSha256 in build/libmpv-runtime.json
before extraction. The archive contains all captured dependency sources,
vendored crates, build recipes, patches, scripts and configuration for this DLL.

See docs/release-maintenance.md for the source-compliance and release gates.
The source of our native addon, integration, build recipes and dependency lock
is public at the exact application release tag. A link to upstream alone is not
a substitute for preserving the corresponding source of bundled binary inputs.
