"""Apply narrowly scoped source-capture hooks to a pinned, disposable superbuild."""

import argparse
import json
from pathlib import Path
import re
import subprocess


def replace_once(path, old, new):
    text = path.read_text(encoding="utf-8")
    if text.count(old) != 1:
        raise ValueError(f"Unexpected recipe layout: {path}: {old!r}")
    path.write_text(text.replace(old, new), encoding="utf-8")


def pin_recipe(path, pin):
    text = path.read_text(encoding="utf-8")
    if "repository" not in pin:
        for key, value in (("URL", pin["url"]), ("URL_HASH", pin["urlHash"])):
            if not re.search(rf"(?m)^\s*{key} {re.escape(value)}\s*$", text):
                raise ValueError(f"Unexpected locked {key}: {path}")
        return
    revision = pin["revision"]
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("A full source revision is required")
    repos = list(re.finditer(r"(?m)^([ \t]*)GIT_REPOSITORY ([^\r\n]+)$", text))
    if len(repos) != 1 or repos[0][2] != pin["repository"]:
        raise ValueError(f"Unexpected locked repository: {path}")
    tag = rf"(?m)^([ \t]*)GIT_TAG [^\r\n]+$"
    if len(re.findall(tag, text)) > 1:
        raise ValueError(f"Multiple Git tags: {path}")
    if re.search(tag, text):
        text = re.sub(tag, lambda match: f"{match[1]}GIT_TAG {revision}", text)
    else:
        match = repos[0]
        text = text[:match.end()] + f"\n{match[1]}GIT_TAG {revision}" + text[match.end():]
    reset = r"(?m)^([ \t]*)GIT_RESET [^\r\n]+$"
    if len(re.findall(reset, text)) > 1:
        raise ValueError(f"Multiple Git resets: {path}")
    if re.search(reset, text):
        text = re.sub(reset, lambda match: f"{match[1]}GIT_RESET {revision}", text)
    else:
        text = re.sub(tag, lambda match: f"{match[0]}\n{match[1]}GIT_RESET {revision}", text)
    path.write_text(text, encoding="utf-8")


def prepare(recipes, scripts, config, lock):
    actual = subprocess.check_output(["git", "-C", str(recipes), "rev-parse", "HEAD"], text=True).strip()
    if actual != config["recipesCommit"]:
        raise ValueError("Wrong build recipe revision")
    for name, pin in lock.items():
        paths = [p for folder in ("toolchain", "packages") for p in (recipes / folder).rglob(f"{name}.cmake")]
        if len(paths) != 1:
            raise ValueError(f"Expected one recipe for locked source: {name}")
        pin_recipe(paths[0], pin)
    for name in ("mpv", "ffmpeg"):
        if lock[name]["revision"] != config[name + "Commit"]:
            raise ValueError(f"Conflicting {name} pin")
    for folder in ("toolchain", "packages"):
        replace_once(recipes / folder / "CMakeLists.txt", '    set(SOURCE_LOCATION "")',
                     '    lampaua_capture_source(${package})\n    set(SOURCE_LOCATION "")')
    replace_once(recipes / "CMakeLists.txt", "add_subdirectory(toolchain)",
                 'include("$ENV{LAMPAUA_MPV_SCRIPTS}/capture-source.cmake")\nadd_subdirectory(toolchain)')
    for name in ("mpv", "ffmpeg"):
        replace_once(recipes / "packages" / f"{name}.cmake", '    CONFIGURE_COMMAND',
                     f'    PATCH_COMMAND python3 "$ENV{{LAMPAUA_MPV_SCRIPTS}}/freeze_version.py" '
                     f'--name {name} --source <SOURCE_DIR> --receipt "$ENV{{LAMPAUA_MPV_SOURCES}}/{name}.json"\n    CONFIGURE_COMMAND')
    # Do not perform an unrelated floating release lookup while configuring.
    replace_once(recipes / "packages" / "CMakeLists.txt", "    mpv-release\n", "")
    replace_once(recipes / "packages" / "CMakeLists.txt", "    mpv-packaging\n", "")
    # Rust is installed once from a dated toolchain before configuring. Its
    # standard library sources and subrandr's vendored crates are archived too.
    # Cargo vendoring runs in source preflight, before GCC, not configuration.
    (recipes / "toolchain" / "rustup.cmake").write_text(
        'ExternalProject_Add(rustup DOWNLOAD_COMMAND "" UPDATE_COMMAND "" '
        'CONFIGURE_COMMAND "" BUILD_COMMAND "" INSTALL_COMMAND "")\n', encoding="utf-8")
    replace_once(recipes / "packages" / "subrandr.cmake", "        LD_PRELOAD=", "        CARGO_NET_OFFLINE=true\n        LD_PRELOAD=")
    # Move link-only CFLAGS to OpenSSL's static dependency metadata so GNU ld
    # sees private libraries after libssl/libcrypto.
    replace_once(recipes / "packages" / "ngtcp2.cmake", "    CONFIGURE_COMMAND",
                 '    PATCH_COMMAND ${EXEC} python3 "$ENV{LAMPAUA_MPV_SCRIPTS}/patch_static_openssl.py" --source <SOURCE_DIR>\n    CONFIGURE_COMMAND')
    replace_once(recipes / "packages" / "ngtcp2.cmake",
                 '        "-DCMAKE_C_FLAGS=\'-lz -lbrotlienc -lbrotlidec -lbrotlicommon -lzstd -lcrypt32\'"\n', "")
    replace_once(recipes / "packages" / "curl.cmake", "    UPDATE_COMMAND",
                 '    COMMAND ${EXEC} python3 "$ENV{LAMPAUA_MPV_SCRIPTS}/patch_static_openssl.py" --source <SOURCE_DIR>\n'
                 '    COMMAND ${EXEC} python3 "$ENV{LAMPAUA_MPV_SCRIPTS}/patch_curl_compat.py" --source <SOURCE_DIR>\n    UPDATE_COMMAND')
    replace_once(recipes / "packages" / "curl.cmake",
                 '        "-DCMAKE_C_FLAGS=\'-DNGHTTP3_STATICLIB -DNGHTTP2_STATICLIB -DNGTCP2_STATICLIB -lz -lbrotlienc -lbrotlidec -lbrotlicommon -lzstd -lcrypt32 -lsecur32\'"',
                 '        "-DCMAKE_C_FLAGS=\'-DNGHTTP3_STATICLIB -DNGHTTP2_STATICLIB -DNGTCP2_STATICLIB\'"')
    # Preserve the second cppwinrt input instead of downloading mutable master
    # during install. The original generated recipe is in the source bundle.
    path = recipes / "toolchain" / "cppwinrt.cmake"
    text = path.read_text(encoding="utf-8")
    pattern = r"COMMAND \$\{EXEC\} wget -O <BINARY_DIR>/Windows.winmd https://[^\s]+"
    text, count = re.subn(pattern,
                         'COMMAND ${CMAKE_COMMAND} -E copy "$ENV{LAMPAUA_MPV_SOURCES}/windows-metadata/Windows.winmd" <BINARY_DIR>/Windows.winmd', text)
    if count != 1:
        raise ValueError("Unexpected cppwinrt metadata download")
    path.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recipes", type=Path, required=True)
    parser.add_argument("--scripts", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    from preflight_sources import load_lock
    config = json.loads(args.config.read_text())
    lock = load_lock(args.config.parent / config["sourceLock"])
    prepare(args.recipes.resolve(), args.scripts.resolve(), config, lock)
