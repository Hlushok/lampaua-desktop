# Own Windows x64 libmpv Build

This is a separate, manually dispatched build. It never publishes a release,
changes auto-updates, installs the app, or replaces the previously tested DLL.
The existing runtime manifest remains unchanged until the new DLL passes QA.

The workflow's `ngtcp2` target is a diagnostic build of the compiler and QUIC
backend only. It preserves CMake probe logs but does not produce a libmpv SDK.
Only the default `mpv` target can supply a runtime for application acceptance.
The local ngtcp2/curl patch supplements Windows CMake's OpenSSL detection with
the selected installation's static pkg-config dependencies. They are linked
after libssl/libcrypto; QUIC/API checks remain enabled and are never preset.
The curl patch also probes ASN1_STRING_get_length against the selected Windows
OpenSSL headers and library. Older 4.1-dev snapshots use curl's existing fallback
when that API is absent; a version number alone no longer decides availability.

## Inputs And Outputs

`build/libmpv-source-build.json` pins the recipe commit, mpv, FFmpeg, dated Rust
toolchain and build container digest. GCC targets baseline x86-64, not v3.
`build/libmpv-source-lock.json` fixes every required Git revision and URL/hash
input observed in the build graph. Windows metadata has a fixed commit too.
No upstream source or binary cache is restored. Download and source capture run
as independent step targets before GCC. Preflight rejects unpinned dependencies,
wrong receipts, changed archives and unexpected curl patch layouts before the
long compilation starts. The actual Windows compiler/API/link tests still run
during configuration; source preflight is not a substitute for full compilation.
The app checkout's commit is also checked before downloads or compilation. Git
trust is scoped to that exact directory and command, not a global wildcard.
Full revisions and archive hashes are recorded in manifest.json.
Cargo dependencies are vendored with the pinned subrandr Cargo.lock during
preflight, then built offline. Rust sources, Windows metadata and the vendor
archive are checked before GCC as well as during final packaging.
Actions displays contract tests, source preflight and compilation as separate
steps. They share the same fresh job workspace; the compile step rechecks the
source receipts before using them. Direct script invocation still runs all phases.

The SDK artifact contains libmpv-2.dll, import library and API headers. The source
artifact preserves the unpatched source archives, minimal Git metadata where
needed for version generation, initialized submodules, Rust standard-library
sources, vendored Cargo dependencies, Windows metadata input, original recipes,
configured recipes, patches, scripts, CMake configuration and component receipts.
Sparse/partial Git inputs are materialized before capture. Recorded MPV/FFmpeg
version strings are reapplied at the patch step so shallow archives do not change
embedded versions. Completeness is checked against the GCC/MPV dependency graph,
including source-only/header inputs, not against configure log presence.
License files are retained in the source trees. Third-party notices in the app
must be checked against the resulting component inventory before distribution.
After safely extracting the verified bundle, audit_runtime_sources.py checks
its manifests, every receipt/archive, source pins, dependency closure, Cargo lock
and baseline CPU options. It copies original license/notice bytes into a new
directory and emits inventory.json. Review any withoutNoticeFiles entries;
filename-based notice discovery alone is not a license-compliance conclusion.

## Source Delivery

The complete source bundle exceeds GitHub's 2 GiB per-release-file limit. Keep
the original archive intact and split its bytes into 1.5 GiB parts after checking
it against the build artifact's checksums.json:

```bash
python scripts/mpv/split_source_bundle.py dist/libmpv-own/lampaua-libmpv-x64-sources.tar.gz --output dist/libmpv-source-parts
```

The output directory must be new. The command emits .001/.002 files and a
source-parts.json descriptor with each part's size and SHA-256, plus the original
archive's SHA-256. Copy these fields into build/libmpv-runtime.json only after
the build and source inventory have been verified. Upload the SDK and both
parts to the draft release before CI uses those runtime pins.

prepare-libmpv.ps1 checks the ordered filenames, sizes and hashes, downloads
missing parts, then streams them into the original archive and checks its full
hash. A failed assembly does not replace an existing verified archive. The old
single-source-asset format still works. Release CI distributes the parts, not
the oversized assembled archive. None of this changes the app or its updater.

For manual assembly, concatenate .001 and .002 in that order using binary I/O,
then verify the SHA-256 against sourceSha256 before extracting. The parts are
not separately extractable archives. The corresponding sources and build
instructions remain available independently of the Windows installer.

Preserve Verified libmpv Inputs is a separate, manually dispatched workflow for
an already successful own-build run. Supply its exact app commit and SDK/source/
DLL hashes. It verifies and audits the artifact, splits the original sources,
then stores the SDK and both parts in the existing version's draft release.
It does not compile, move tags, publish, replace existing assets or change update
metadata. Download its notice inventory and review entries without discovered
notice files before accepting the runtime. A filename scan is not a legal audit.

## Rebuild

Use the container digest from the configuration. From a clean app checkout run:

```bash
bash scripts/mpv/build-libmpv.sh
```

For an offline check of donor cleanup semantics, use `check_donor_cleanup.py`
with `--recipes` pointing to the pinned recipe tree, `--externalproject` to the
official ExternalProject v3.31.6 module, and `--cmake` to the CMake executable.
It reproduces the old detached-HEAD/upstream-reset failure, then verifies pinned
post-install cleanup on fresh temporary repositories only.

For an exact source replay, unpack each component archive, retain its Git
metadata, and use the recorded revisions rather than current branches. Restore
the source trees into SINGLE_SOURCE_LOCATION before configuring CMake. Regenerate
the configured recipes using prepare_build.py and the included original recipes;
set LAMPAUA_MPV_SCRIPTS and LAMPAUA_MPV_SOURCES for the new location. The original
CMakeCache is evidence, not a relocatable cache to copy into the replay. URL-based
projects need their captured trees remapped into the source directories reported
by the newly configured ExternalProject graph. Suppress their download/extraction
commands in the replay recipes before configuring; otherwise ExternalProject
extraction deletes and replaces the restored tree. Restore vendored crates
and Windows.winmd from this bundle. Use the recorded Rust toolchain, GCC recipe
and CMakeCache build options. Do not invoke the donor's floating `update` target.
Host build tools are identified by the pinned container; the container is still
needed separately. The source bundle is not itself a preconfigured offline VM.

If final packaging fails after MPV was built, CI preserves the SDK and captured
inputs as lampaua-libmpv-unpackaged-x64. This is a diagnostic artifact, not an
accepted runtime or a release. It allows inspecting the built DLL and repairing
packaging without losing the completed compiler/media build.

## Acceptance

Verify source receipts, exported C API, DLL architecture and external imports.
Rebuild the Electron addon and app against this SDK. Run contract tests and
isolated portable QA, including AVI/Xvid, AC3/EAC3, IPTV, seeking, subtitles,
repeated playback, exit and the separate YouTube browser DASH route. Publish
only after the new DLL is accepted and the complete source/notices package has
been checked. Preserve the old tested DLL and portable build as rollback inputs.
