"""Check locked source identities before starting the compiler superbuild."""

import argparse
import json
from pathlib import Path
import re

from capture_source import digest
from package_build import source_closure
from patch_static_openssl import patch as patch_static_openssl
from patch_curl_compat import patched_texts


def load_lock(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("version") != 1 or not isinstance(data.get("components"), dict):
        raise ValueError("Unsupported source lock")
    for name, pin in data["components"].items():
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", name):
            raise ValueError(f"Invalid source name: {name}")
        if "repository" in pin:
            if not re.fullmatch(r"[0-9a-f]{40}", pin.get("revision", "")):
                raise ValueError(f"Unpinned Git source: {name}")
            url = pin["repository"]
        else:
            if not re.fullmatch(r"SHA(?:1=[0-9a-fA-F]{40}|256=[0-9a-fA-F]{64}|512=[0-9a-fA-F]{128})", pin.get("urlHash", "")):
                raise ValueError(f"Unpinned URL source: {name}")
            url = pin["url"]
        if not url.startswith("https://") or "@" in url.split("//", 1)[1].split("/", 1)[0]:
            raise ValueError(f"Non-public source: {name}")
    return data["components"]


def plan(projects, pins):
    # GCC's final custom step adds compiler inputs outside _EP_DEPENDS. The
    # locked, previously observed inputs are included as additional roots.
    closure = source_closure(projects, ["gcc", "mpv", *pins])
    names = [name for name in closure if projects[name]["hasSource"]]
    for name in names:
        if name not in pins:
            raise ValueError(f"Unpinned source dependency: {name}")
        item, pin = projects[name], pins[name]
        if item.get("repository"):
            if item["repository"] != pin.get("repository") or item.get("revision") != pin.get("revision"):
                raise ValueError(f"Git source pin mismatch: {name}")
        elif not pin.get("urlHash") or any(item.get(key) != pin.get(key) for key in ("url", "urlHash")):
            raise ValueError(f"URL source pin mismatch: {name}")
    return names


def validate_config(config, pins):
    for name in ("mpv", "ffmpeg"):
        if pins.get(name, {}).get("revision") != config.get(name + "Commit"):
            raise ValueError(f"Conflicting {name} pin")
    if not re.fullmatch(r"[0-9a-f]{40}", config.get("windowsMetadataCommit", "")):
        raise ValueError("Unpinned Windows metadata commit")


def verify(sources, projects, pins):
    names = plan(projects, pins)
    for name in names:
        receipt = sources / f"{name}.json"
        if not receipt.is_file():
            raise ValueError(f"Uncaptured source: {name}")
        record = json.loads(receipt.read_text(encoding="utf-8"))
        if any(record.get(key) != value for key, value in pins[name].items()):
            raise ValueError(f"Source receipt pin mismatch: {name}")
        if digest(sources / record["archive"]) != record["sha256"]:
            raise ValueError(f"Changed source archive: {name}")
    return names


def verify_extras(sources, projects, config):
    expected = {
        "rust-standard-library": ("rust-standard-library.json", f"rustup:{config['rustToolchain']}:rust-src"),
        "windows-metadata": ("windows-metadata.json", f"https://github.com/microsoft/windows-rs/tree/{config['windowsMetadataCommit']}"),
        "subrandr-crates": ("subrandr-crates.tar.json", None),
    }
    for name, (filename, url) in expected.items():
        path = sources / filename
        if not path.is_file():
            raise ValueError(f"Uncaptured source: {name}")
        record = json.loads(path.read_text(encoding="utf-8"))
        if record.get("name") != name or (url and record.get("url") != url):
            raise ValueError(f"Extra source pin mismatch: {name}")
        if digest(sources / record["archive"]) != record["sha256"]:
            raise ValueError(f"Changed source archive: {name}")
        if name == "subrandr-crates":
            lock = Path(projects["subrandr"]["source"]) / "Cargo.lock"
            if digest(lock) != record.get("cargoLockSha256"):
                raise ValueError("Cargo lock mismatch")


def check_curl_layout(projects):
    # Validate both source hooks on a disposable copy before GCC. Actual
    # symbol/link probes still run against the built Windows OpenSSL later.
    import shutil
    import tempfile
    with tempfile.TemporaryDirectory(prefix="lampaua-curl-preflight-") as directory:
        source = Path(directory)
        original = Path(projects["curl"]["source"])
        (source / "lib/vtls").mkdir(parents=True)
        for relative in ("CMakeLists.txt", "lib/vtls/openssl.c"):
            shutil.copy(original / relative, source / relative)
        patch_static_openssl(source)
        patched_texts(source)
    header = Path(projects["openssl"]["source"]) / "include/openssl/asn1.h.in"
    present = bool(re.search(r"\bASN1_STRING_get_length\s*\(", header.read_text(encoding="utf-8")))
    print(f"curl/OpenSSL source contract valid; native ASN1 length API: {present}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, required=True)
    parser.add_argument("--lock", type=Path, required=True)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--plan", action="store_true")
    args = parser.parse_args()
    pins = load_lock(args.lock)
    projects = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in (args.sources / "projects").glob("*.json")}
    config = json.loads(args.config.read_text(encoding="utf-8")) if args.config else None
    if config:
        validate_config(config, pins)
    if args.plan:
        for name in plan(projects, pins):
            print(f"{name}-lampaua-source")
    else:
        names = verify(args.sources, projects, pins)
        if not config:
            raise ValueError("Build configuration is required for source verification")
        verify_extras(args.sources, projects, config)
        check_curl_layout(projects)
        print(f"Verified {len(names)} pinned source inputs before compilation")
