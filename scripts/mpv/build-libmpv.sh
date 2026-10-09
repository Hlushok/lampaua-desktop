#!/usr/bin/env bash
set -euo pipefail
root="$(pwd)"
export LAMPAUA_MPV_SCRIPTS="$root/scripts/mpv"
export LAMPAUA_MPV_SOURCES="$root/.cache/libmpv-own/sources"
work="$root/.cache/libmpv-own"
target="${LAMPAUA_MPV_TARGET:-mpv}"
phase="${LAMPAUA_MPV_PHASE:-all}"
case "$target" in
  mpv|ngtcp2) ;;
  *) printf 'Unsupported build target: %s\n' "$target" >&2; exit 1 ;;
esac
case "$phase" in
  all|inputs|compile) ;;
  *) printf 'Unsupported build phase: %s\n' "$phase" >&2; exit 1 ;;
esac
report_failure() {
  if [ -d "$work/build" ]; then
    find "$work/build" -name '*-err.log' -type f -size +0c -print -exec tail -n 80 {} \;
    find "$work/build" -path '*ngtcp2*/CMakeConfigureLog.yaml' -type f -print -exec tail -n 160 {} \;
  fi
}
trap report_failure ERR
python3 "$LAMPAUA_MPV_SCRIPTS/package_build.py" --work "$work" --root "$root" --check-repository
mkdir -p "$work" "$LAMPAUA_MPV_SOURCES" "$root/dist/libmpv-own"
readarray -t pins < <(python3 - <<'PY'
import json, sys
sys.stdout.reconfigure(newline="\n")
p = json.load(open('build/libmpv-source-build.json'))
for key in ('recipesRepository', 'recipesCommit', 'rustToolchain', 'windowsMetadataCommit', 'sourceLock'):
    print(p[key])
PY
)
# No upstream binary/source caches are restored in this workflow.
export RUSTUP_HOME="$work/rust/.rustup"
export CARGO_HOME="$work/rust/.cargo"
export PATH="$CARGO_HOME/bin:$PATH"
export GIT_COMMITTER_NAME="LampaUa Build"
export GIT_COMMITTER_EMAIL="build@lampaua.invalid"
if [ "$phase" != compile ]; then
  git clone "${pins[0]}" "$work/recipes"
  git -C "$work/recipes" checkout --detach "${pins[1]}"
  python3 "$LAMPAUA_MPV_SCRIPTS/capture_source.py" --name build-recipes \
    --source "$work/recipes" --repository "${pins[0]}" --output "$LAMPAUA_MPV_SOURCES"
  curl --fail --location --retry 3 https://sh.rustup.rs -o "$work/rustup-init.sh"
  sh "$work/rustup-init.sh" -y --no-modify-path --profile minimal \
    --default-toolchain "${pins[2]}" --target x86_64-pc-windows-gnu --component rust-src
  rustc -Vv > "$LAMPAUA_MPV_SOURCES/rust-version.txt"
  rust_root="$(rustc --print sysroot)"
  python3 "$LAMPAUA_MPV_SCRIPTS/capture_source.py" --name rust-standard-library \
    --source "$rust_root/lib/rustlib/src/rust" --url "rustup:${pins[2]}:rust-src" --output "$LAMPAUA_MPV_SOURCES"
  cp "$work/rustup-init.sh" "$LAMPAUA_MPV_SOURCES/"

  metadata_commit="${pins[3]}"
  mkdir -p "$LAMPAUA_MPV_SOURCES/windows-metadata"
  curl --fail --location --retry 3 \
    "https://raw.githubusercontent.com/microsoft/windows-rs/$metadata_commit/crates/libs/default/Windows.winmd" \
    -o "$LAMPAUA_MPV_SOURCES/windows-metadata/Windows.winmd"
  printf '%s\n' "$metadata_commit" > "$LAMPAUA_MPV_SOURCES/windows-metadata/commit.txt"
  for license in license-apache-2.0 license-mit; do
    curl --fail --location --retry 3 \
      "https://raw.githubusercontent.com/microsoft/windows-rs/$metadata_commit/$license" \
      -o "$LAMPAUA_MPV_SOURCES/windows-metadata/$license"
  done
  python3 "$LAMPAUA_MPV_SCRIPTS/capture_source.py" --name windows-metadata \
    --source "$LAMPAUA_MPV_SOURCES/windows-metadata" \
    --url "https://github.com/microsoft/windows-rs/tree/$metadata_commit" --output "$LAMPAUA_MPV_SOURCES"

  python3 "$LAMPAUA_MPV_SCRIPTS/prepare_build.py" --recipes "$work/recipes" \
    --scripts "$LAMPAUA_MPV_SCRIPTS" --config "$root/build/libmpv-source-build.json"
  cmake -S "$work/recipes" -B "$work/build" -G Ninja \
    -DCOMPILER_TOOLCHAIN=gcc -DGCC_ARCH=x86-64 -DTARGET_ARCH=x86_64-w64-mingw32 \
    -DSINGLE_SOURCE_LOCATION="$work/trees" -DRUSTUP_LOCATION="$work/rust" \
    -DMAKEJOBS=2 -DENABLE_CCACHE=OFF
  python3 "$LAMPAUA_MPV_SCRIPTS/preflight_sources.py" --sources "$LAMPAUA_MPV_SOURCES" \
    --lock "$root/build/${pins[4]}" --plan > "$work/preflight-targets.txt"
  readarray -t source_targets < "$work/preflight-targets.txt"
  cmake --build "$work/build" --target "${source_targets[@]}" --parallel 2
  bash "$LAMPAUA_MPV_SCRIPTS/vendor-rust.sh" "$work/trees/subrandr"
fi
python3 "$LAMPAUA_MPV_SCRIPTS/preflight_sources.py" --sources "$LAMPAUA_MPV_SOURCES" \
  --lock "$root/build/${pins[4]}" --config "$root/build/libmpv-source-build.json"
if [ "$phase" = inputs ]; then
  exit 0
fi
cmake --build "$work/build" --target gcc --parallel 1
cmake --build "$work/build" --target "$target" --parallel 1
if [ "$target" = mpv ]; then
  python3 "$LAMPAUA_MPV_SCRIPTS/package_build.py" --work "$work" --root "$root"
fi
