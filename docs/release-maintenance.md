# LampaUa Desktop 2.x: Release Maintenance

## Architecture And Boundaries

Version 1.5.24 (ordinary and AC3/EAC3) closes series 1.x. Version 2.0.0 promotes
the locally accepted mpv.6 integration. The owner subsequently approved building
our own libmpv DLL from preserved sources and repeating playback QA before
publication. Preserve the previously accepted binary as a rollback input. The
runtime pins must identify the DLL actually tested and packaged for release.

Sources have distinct roles:

- Kolovatoff/lampa-desktop: base app, existing sync-upstream.yml merges main.
- ARST113/lampa-desktop: selective codec-integration reference, not a wholesale merge.
- ARST113/electron: pinned Windows x64 Electron/Chromium AC3/EAC3 binary.
- yscoder/electron-mpv-video: vendored source at the recorded commit plus local patches.
- shinchiro/mpv-winbuild-cmake: pinned build recipes for the baseline-x64 libmpv runtime.
- Hlushok/lampaua-desktop: app identity, integrations, patches, QA and release channel.

MPV is enabled only by the staged package flag lampauaMpv on Windows x64.
The test flag lampauaMpvTest additionally isolates the profile and disables the
updater. Never enable the test flag in a stable installer. Other architectures
retain the browser engine. Ytdl's browser dash.js route remains separate from
native HLS/DASH and protected media playback.

## Reproducible Build

Use Node 24, Yarn 4.9.4, Python, Visual Studio C++ build tools and 7-Zip.
No private stream URL, authorization code, user profile or local SDK installation
may be required by CI. yarn.lock pins the native/TypeScript/bundler tools.

1. Run yarn install --immutable.
2. Run yarn build-win. The builder prepares and hashes the pinned Electron and
   libmpv archives, creates an MSVC import library, compiles the addon for the
   pinned Electron ABI, compiles TypeScript and stages the full app.
3. Inspect dist/release-x64: NSIS installer, portable and updater metadata.
4. Run yarn build-win-legacy for Windows ia32/arm64, then
   node scripts/merge-windows-updates.cjs. It verifies SHA-512 and sizes before
   merging metadata; Windows x64 MPV is the primary entry.
5. Linux/macOS use their existing build jobs and do not bundle this Windows DLL.

The Windows installer keeps com.lampaua.desktop, LampaUa and its existing profile.
Do not import the MPV test profile during an update. Existing saved player choices
must survive; inner playback is the default only when no choice exists.

## Update Each Component Independently

For base desktop changes, inspect the upstream diff and preserve our branding,
fixed HTTPS/HTTP addresses, UA Player handoff, donation, release metadata and
MPV feature gates. A successful upstream merge alone does not test playback.

For Electron, update its manifest and the builder's verified executable/Vulkan
input hashes, hash the archive and ffmpeg.dll, recompile the
native addon and repeat browser/native codec tests. Do not swap only ffmpeg.dll.

For electron-mpv-video, record the new vendor commit, review the diff and reapply
only needed local security, lifetime, header and manifest-format fixes. Update
PROVENANCE.md and run all contracts. Do not overwrite the subtree blindly.

For libmpv, pin the SDK/DLL hashes and source revisions, preserve corresponding
source and notices, regenerate the import library and repeat all media tests.
Do not select x86-64-v3 unless deliberately dropping baseline CPU support.
The donor prunes old daily releases. Preserve the exact SDK as a release asset;
the manifest's verified mirror prevents later builds depending on a deleted
daily tag. The mirror becomes publicly usable only after the draft/source gate
is cleared. Update the mirror when deliberately selecting a new SDK.

## Verification And Publication Gates

Before publishing:

1. node syntax checks, all MPV/external-player contracts, yarn lint and clean
   git diff --check must pass. CI must build from a clean checkout.
2. Run scripts/verify-mpv-desktop.cjs --release --exe ABSOLUTE_PORTABLE_PATH.
   It uses an explicit isolated user-data directory and compares the primary
   profile metadata. Never delete the user's profile to make a test pass.
3. Verify real YouTube, IPTV and protected-stream behavior without committing
   credentials. Short fixture tests are not a claim of sustained 4K throughput.
4. Check update metadata points to the x64 MPV installer and includes other
   architectures. Keep full-download updating; do not enable differential
   updating without separately testing it.
5. Verify ordinary and AC3/EAC3 1.5.24 share the stable appId/profile/channel;
   test installation upgrades only in a disposable Windows environment.
   Do not overwrite the user's installed app without their separate request.
6. Preserve the corresponding source of bundled libmpv/FFmpeg and linked
   dependencies, build configuration and licenses. GPL-3.0-or-later was approved
   by the owner for 2.x; changing a label does not satisfy source obligations.
   An upstream URL alone is not a verified complete source bundle.
7. Prepare docs/releases/X.Y.Z.md as concise Ukrainian notes for end users:
   visible changes, platform availability, upgrade guidance and download links.
   Keep source audits, hashes, build details and publication gates in maintenance
   documents instead. The release workflow requires this file and never appends
   the technical changelog or maintainer-only warnings to the release body.
   Commit and push reviewed changes, then tag the exact commit as vX.Y.Z.
   All gh commands must specify --repo Hlushok/lampaua-desktop because gh's
   inferred repository can otherwise be the upstream donor.
8. The workflow creates a DRAFT release until the source/distribution gate and
   local acceptance are complete. Inspect all jobs and downloaded public bytes,
   then explicitly publish the draft as latest. Drafts do not update users.

## 2.0.0 Source Gate Status

The previously tested libmpv DLL is retained unchanged as a rollback input. Its
SDK does not include complete corresponding sources, and historical logs/debug
symbols could not establish all cached dependency revisions. The owner declined
contacting its author and approved an own build with preserved sources and new
playback tests. See docs/libmpv-own-build.md and build-libmpv.yml. The own build
does not automatically change the runtime pin, release assets or updater.
Source-package verification and new DLL acceptance remain publication gates.

## After Publication

Verify release tag SHA, every job, asset sizes/hashes, latest.yml version and
installer SHA-512 against downloaded bytes. Verify a clean 1.5.24 upgrade in a
disposable environment and a subsequent 2.x update. Record evidence, limitations
and changes in CHANGELOG.md. New code on main alone is not a downloadable update.
