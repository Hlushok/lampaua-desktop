"""Package an own-build SDK with its captured inputs and build evidence."""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

from capture_source import digest


def source_closure(projects, roots):
    visited = set()

    def visit(name):
        if name not in projects:
            # ExternalProject dependencies can address a step target, e.g.
            # gcc-install, instead of its parent project.
            parents = [p for p in projects if name.startswith(p + "-")]
            if not parents:
                raise ValueError(f"Unknown source dependency: {name}")
            name = max(parents, key=len)
        if name in visited:
            return
        visited.add(name)
        item = projects[name]
        for dependency in item["dependencies"]:
            visit(dependency)

    for root in roots:
        visit(root)
    return sorted(visited)


def validate_sources(sources, receipts, downloaded=()):
    names = {item["name"] for item in receipts}
    projects = {p.stem: json.loads(p.read_text()) for p in (sources / "projects").glob("*.json")}
    # Custom ExternalProject steps can add inputs outside _EP_DEPENDS (the
    # compiler's final stage is one). Check actual download stamps as well.
    closure = source_closure(projects, ["gcc", "mpv", *(name for name in downloaded if name in projects)])
    for name in closure:
        if projects[name]["hasSource"] and name not in names:
            raise ValueError(f"Uncaptured dependency: {name}")
    for item in receipts:
        if digest(sources / item["archive"]) != item["sha256"]:
            raise ValueError(f"Changed source archive: {item['name']}")
    return closure


def package(work, root):
    sources = work / "sources"
    receipts = [json.loads(path.read_text()) for path in sorted(sources.glob("*.json"))]
    names = {item["name"] for item in receipts}
    for required in ("mpv", "ffmpeg", "gcc", "gcc-binutils", "mingw-w64", "subrandr-crates", "rust-standard-library", "windows-metadata"):
        if required not in names:
            raise ValueError(f"Missing source receipt: {required}")
    downloaded = {p.name.removesuffix("-download") for p in (work / "build").rglob("*-download")}
    closure = validate_sources(sources, receipts, downloaded)
    destination = root / "dist/libmpv-own"
    sdk_dirs = list((work / "build").glob("mpv-dev-x86_64-*-git-*"))
    if len(sdk_dirs) != 1:
        raise ValueError("Expected exactly one SDK")
    sdk = sdk_dirs[0]
    dll = sdk / "libmpv-2.dll"
    prefix = work / "build/install/bin/cross-objdump"
    pe = subprocess.check_output([str(prefix), "-p", str(dll)], text=True)
    (destination / "dll-pe.txt").write_text(pe)
    config = json.loads((root / "build/libmpv-source-build.json").read_text())
    from preflight_sources import load_lock, verify, verify_extras
    projects = {p.stem: json.loads(p.read_text()) for p in (sources / "projects").glob("*.json")}
    verify(sources, projects, load_lock(root / "build" / config["sourceLock"]))
    verify_extras(sources, projects, config)
    for name in ("mpv", "ffmpeg"):
        component = next(item for item in receipts if item["name"] == name)
        if component["revision"] != config[name + "Commit"]:
            raise ValueError(f"Wrong {name} revision in built SDK")
    manifest = {"configuration": config, "dependencyClosure": closure, "components": receipts, "dllSha256": digest(dll),
                "repositoryCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()}
    (sources / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    shutil.copytree(root / "scripts/mpv", sources / "build-scripts", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(work / "recipes", sources / "configured-recipes", ignore=shutil.ignore_patterns(".git"))
    shutil.copy(work / "build/CMakeCache.txt", sources)
    shutil.copytree(work / "build/cmake", sources / "cmake-modules")
    shutil.copy(root / "build/libmpv-source-build.json", sources)
    shutil.copy(root / "build" / config["sourceLock"], sources)
    shutil.copy(root / "docs/libmpv-own-build.md", sources / "README.md")
    shutil.copy(sources / "manifest.json", destination / "manifest.json")
    archive = destination / "lampaua-libmpv-x64-sources.tar.gz"
    with tarfile.open(archive, "w:gz", compresslevel=1) as bundle:
        bundle.add(sources, arcname="lampaua-libmpv-sources")
    subprocess.run(["7z", "a", "-t7z", "-mx=5", str(destination / "lampaua-libmpv-x64-sdk.7z"), "."], cwd=sdk, check=True)
    files = [{"file": p.name, "sha256": digest(p), "size": p.stat().st_size}
             for p in sorted(destination.iterdir()) if p.is_file()]
    (destination / "checksums.json").write_text(json.dumps(files, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    package(args.work.resolve(), args.root.resolve())
