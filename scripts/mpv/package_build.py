"""Package an own-build SDK with its captured inputs and build evidence."""

import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

from capture_source import digest
from apply_source_patches import load_config, verify_patches, within


def variant_paths(root, variant):
    if variant == "baseline":
        return root / "build/libmpv-source-build.json", root / "dist/libmpv-own"
    if variant == "d3d11":
        return root / "build/libmpv-source-build.d3d11.json", root / "dist/libmpv-own-d3d11"
    raise ValueError(f"Unsupported build variant: {variant}")


def repository_revision(root):
    # The Actions container can own files differently from checkout. Trust only
    # this known app checkout for this read, without changing global Git config.
    root = root.resolve()
    return subprocess.check_output(["git", "-c", f"safe.directory={root.as_posix()}",
                                    "-C", str(root), "rev-parse", "--verify", "HEAD^{commit}"], text=True).strip()


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


def package(work, root, variant="baseline"):
    config_path, destination = variant_paths(root, variant)
    config = load_config(config_path)
    sources = work / "sources"
    receipts = [json.loads(path.read_text()) for path in sorted(sources.glob("*.json"))]
    names = {item["name"] for item in receipts}
    for required in ("mpv", "ffmpeg", "gcc", "gcc-binutils", "mingw-w64", "subrandr-crates", "rust-standard-library", "windows-metadata"):
        if required not in names:
            raise ValueError(f"Missing source receipt: {required}")
    downloaded = {p.name.removesuffix("-download") for p in (work / "build").rglob("*-download")}
    closure = validate_sources(sources, receipts, downloaded)
    effective = verify_patches(sources, config) if variant == "d3d11" else None
    sdk_dirs = list((work / "build").glob("mpv-dev-x86_64-*-git-*"))
    if len(sdk_dirs) != 1:
        raise ValueError("Expected exactly one SDK")
    sdk = sdk_dirs[0]
    if effective and not (sdk / "include/mpv/render_d3d11.h").is_file():
        raise ValueError("Candidate SDK is missing the installed D3D11 render header")
    api_version = None
    if effective:
        client = sdk / "include/mpv/client.h"
        api = re.search(r"(?m)^#define\s+MPV_CLIENT_API_VERSION\s+MPV_MAKE_VERSION\(\s*(\d+)\s*,\s*(\d+)\s*\)",
                        client.read_text(encoding="utf-8") if client.is_file() else "")
        if not api or tuple(map(int, api.groups())) != (2, 6):
            raise ValueError("Candidate SDK requires the pinned client API 2.6")
        api_version = (2 << 16) | 6
    dll = sdk / "libmpv-2.dll"
    prefix = work / "build/install/bin/cross-objdump"
    pe = subprocess.check_output([str(prefix), "-p", str(dll)], text=True)
    (destination / "dll-pe.txt").write_text(pe)
    from preflight_sources import load_lock, verify, verify_extras
    projects = {p.stem: json.loads(p.read_text()) for p in (sources / "projects").glob("*.json")}
    verify(sources, projects, load_lock(root / "build" / config["sourceLock"]))
    verify_extras(sources, projects, config)
    for name in ("mpv", "ffmpeg"):
        component = next(item for item in receipts if item["name"] == name)
        if component["revision"] != config[name + "Commit"]:
            raise ValueError(f"Wrong {name} revision in built SDK")
    public_config = {key: value for key, value in config.items() if not key.startswith("_")}
    manifest = {"configuration": public_config, "dependencyClosure": closure, "components": receipts, "dllSha256": digest(dll),
                "repositoryCommit": repository_revision(root)}
    if effective:
        manifest.update(baseRevision=effective["baseRevision"], patches=effective["patches"],
                        effectiveTreeSha256=effective["effectiveTreeSha256"], clientApiVersion=api_version)
    (sources / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    shutil.copytree(root / "scripts/mpv", sources / "build-scripts", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(work / "recipes", sources / "configured-recipes", ignore=shutil.ignore_patterns(".git"))
    shutil.copy(work / "build/CMakeCache.txt", sources)
    shutil.copytree(work / "build/cmake", sources / "cmake-modules")
    shutil.copy(config_path, sources)
    if effective:
        for item in effective["patches"]:
            target = sources / item["file"]
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(within(config_path.parent, item["file"]), target)
    shutil.copy(root / "build" / config["sourceLock"], sources)
    shutil.copy(root / "docs/libmpv-own-build.md", sources / "README.md")
    shutil.copy(sources / "manifest.json", destination / "manifest.json")
    archive = destination / "lampaua-libmpv-x64-sources.tar.gz"
    with tarfile.open(archive, "w:gz", compresslevel=1) as bundle:
        bundle.add(sources, arcname="lampaua-libmpv-sources")
    sdk_archive = destination / "lampaua-libmpv-x64-sdk.7z"
    subprocess.run(["7z", "a", "-t7z", "-mx=5", str(sdk_archive), "."], cwd=sdk, check=True)
    if effective:
        # Archive hashes live outside the source bundle to avoid self-hashing.
        candidate = {key: manifest[key] for key in ("dllSha256", "clientApiVersion", "baseRevision",
                     "patches", "effectiveTreeSha256", "repositoryCommit")}
        candidate.update(sdkFile=sdk_archive.name, sdkSha256=digest(sdk_archive),
                         sourceFile=archive.name, sourceSha256=digest(archive))
        (destination / "candidate-sdk.json").write_text(json.dumps(candidate, indent=2) + "\n", encoding="utf-8")
    files = [{"file": p.name, "sha256": digest(p), "size": p.stat().st_size}
             for p in sorted(destination.iterdir()) if p.is_file()]
    (destination / "checksums.json").write_text(json.dumps(files, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--check-repository", action="store_true")
    parser.add_argument("--variant", choices=("baseline", "d3d11"), default="baseline")
    args = parser.parse_args()
    if args.check_repository:
        print(f"Build checkout revision: {repository_revision(args.root)}")
    else:
        package(args.work.resolve(), args.root.resolve(), args.variant)
