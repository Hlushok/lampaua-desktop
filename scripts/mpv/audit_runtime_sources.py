"""Verify an own-build source bundle and preserve its original license notices."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tarfile

from package_build import validate_sources
from preflight_sources import load_lock, verify


def collect_notices(archive, component, output):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", component):
        raise ValueError("Invalid component name")
    destination = output / component
    destination.mkdir(parents=True, exist_ok=False)
    notices = []
    with tarfile.open(archive, "r|*") as bundle:
        for member in bundle:
            path = PurePosixPath(member.name)
            if not member.isfile() or ".git" in path.parts:
                continue
            if not re.fullmatch(r"(?:licen[cs]e|copying|copyright|notice)(?:[._ -].*)?", path.name, re.I):
                continue
            if member.size > 4 * 1024**2:
                raise ValueError(f"Unexpectedly large notice: {component}: {member.name}")
            with bundle.extractfile(member) as stream:
                data = stream.read()
            name = f"{len(notices) + 1:04d}_" + re.sub(r"[^A-Za-z0-9._-]", "_", path.name)
            target = destination / name
            target.write_bytes(data)
            notices.append({"source": member.name, "file": f"{component}/{name}",
                            "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)})
    return notices


def audit(sources, manifest_path, root, output):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest != json.loads((sources / "manifest.json").read_text(encoding="utf-8")):
        raise ValueError("Source and SDK build manifests differ")
    config = json.loads((root / "build/libmpv-source-build.json").read_text(encoding="utf-8"))
    if manifest["configuration"] != config:
        raise ValueError("Source configuration differs from the app's pinned build")
    receipts = manifest["components"]
    by_name = {record["name"]: record for record in receipts}
    if len(by_name) != len(receipts):
        raise ValueError("Duplicate source receipts")
    captured = [json.loads(path.read_text(encoding="utf-8")) for path in sources.glob("*.json")]
    actual = {record["name"]: record for record in captured if "name" in record and "archive" in record}
    if actual != by_name:
        raise ValueError("Source receipts differ from the SDK build manifest")
    pins = load_lock(root / "build" / config["sourceLock"])
    # Packaging records actual download targets, including source-less GCC
    # stages that are not source-lock entries. Replay their recorded graph.
    closure = validate_sources(sources, receipts, manifest["dependencyClosure"])
    if closure != manifest["dependencyClosure"]:
        raise ValueError("Source dependency closure differs from the SDK")
    projects = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in (sources / "projects").glob("*.json")}
    pinned = verify(sources, projects, pins)
    expected = {
        "build-recipes": ("revision", config["recipesCommit"]),
        "rust-standard-library": ("url", f"rustup:{config['rustToolchain']}:rust-src"),
        "windows-metadata": ("url", f"https://github.com/microsoft/windows-rs/tree/{config['windowsMetadataCommit']}"),
    }
    for name, (key, value) in expected.items():
        if by_name[name].get(key) != value:
            raise ValueError(f"Extra source pin mismatch: {name}")
    with tarfile.open(sources / by_name["subrandr"]["archive"], "r:gz") as bundle:
        with bundle.extractfile("subrandr/Cargo.lock") as stream:
            cargo_digest = hashlib.sha256()
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                cargo_digest.update(block)
            cargo_hash = cargo_digest.hexdigest()
    if cargo_hash != by_name["subrandr-crates"].get("cargoLockSha256"):
        raise ValueError("Vendored crates do not match the captured Cargo lock")
    for record in receipts:
        if (sources / record["archive"]).stat().st_size != record["size"]:
            raise ValueError(f"Source archive size mismatch: {record['name']}")
    cache = (sources / "CMakeCache.txt").read_text(encoding="utf-8")
    for key, value in {"GCC_ARCH": "x86-64", "TARGET_ARCH": "x86_64-w64-mingw32", "COMPILER_TOOLCHAIN": "gcc"}.items():
        if not re.search(rf"(?m)^{key}:[A-Z]+={re.escape(value)}$", cache):
            raise ValueError(f"Unexpected build option: {key}")
    output.mkdir(parents=True, exist_ok=False)
    components = []
    for record in receipts:
        notices = collect_notices(sources / record["archive"], record["name"], output)
        components.append({**record, "notices": notices})
        print(f"{record['name']}: verified source, {len(notices)} notice files", flush=True)
    report = {"repositoryCommit": manifest["repositoryCommit"], "dllSha256": manifest["dllSha256"],
              "pinnedInputs": len(pinned), "components": components,
              "withoutNoticeFiles": [record["name"] for record in components if not record["notices"]]}
    (output / "inventory.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="New directory for original notices and inventory")
    args = parser.parse_args()
    result = audit(args.sources, args.manifest, args.root, args.output)
    print(json.dumps({key: value for key, value in result.items() if key != "components"}, indent=2))
