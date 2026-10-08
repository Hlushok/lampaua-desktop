# Own Windows x64 libmpv Build

This is a separate, manually dispatched build. It never publishes a release,
changes auto-updates, installs the app, or replaces the previously tested DLL.
The existing runtime manifest remains unchanged until the new DLL passes QA.

The workflow's `ngtcp2` target is a diagnostic build of the compiler and QUIC
backend only. It preserves CMake probe logs but does not produce a libmpv SDK.
Only the default `mpv` target can supply a runtime for application acceptance.

## Inputs And Outputs

`build/libmpv-source-build.json` pins the recipe commit, mpv, FFmpeg, dated Rust
toolchain and build container digest. GCC targets baseline x86-64, not v3.
No upstream source or binary cache is restored. Other dependencies are resolved
by the pinned recipes and their exact downloaded trees are captured before
patching. Their full revisions and archive hashes are recorded in manifest.json.
The first own build establishes these dependency snapshots; a branch name alone
is not a reproducibility pin.

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

## Rebuild

Use the container digest from the configuration. From a clean app checkout run:

```bash
bash scripts/mpv/build-libmpv.sh
```

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

## Acceptance

Verify source receipts, exported C API, DLL architecture and external imports.
Rebuild the Electron addon and app against this SDK. Run contract tests and
isolated portable QA, including AVI/Xvid, AC3/EAC3, IPTV, seeking, subtitles,
repeated playback, exit and the separate YouTube browser DASH route. Publish
only after the new DLL is accepted and the complete source/notices package has
been checked. Preserve the old tested DLL and portable build as rollback inputs.
