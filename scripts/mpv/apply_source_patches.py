"""Apply pinned source patches and retain independently verifiable effective sources."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile

from capture_source import digest, run
from freeze_version import freeze


def git(source, *arguments):
    options = ["-c", "core.autocrlf=false"]
    if os.name == "nt":
        options += ["-c", "core.filemode=false"]
    return run("git", *options, "-C", str(source), *arguments)


def relative_path(value):
    if not isinstance(value, str) or not value or "\\" in value or ":" in value:
        raise ValueError("Expected a portable relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or path.as_posix() != value:
        raise ValueError("Source path escapes its root")
    return path


def within(root, value):
    path = root / relative_path(value)
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Source path resolves outside its root")
    return path


def load_config(path):
    config = json.loads(path.read_text(encoding="utf-8"))
    config["_patchRoot"] = path.resolve().parent
    return config


def patch_series(component, config):
    if component != "mpv":
        raise ValueError("Only MPV source patches are supported")
    patches = config.get("sourcePatches", {}).get(component, [])
    if not isinstance(patches, list) or not patches:
        raise ValueError("Missing pinned source patches")
    root = Path(config["_patchRoot"])
    for patch in patches:
        if set(patch) != {"file", "sha256", "upstreamCommit", "baseRevision"}:
            raise ValueError("Unexpected source patch metadata")
        for key, length in (("sha256", 64), ("upstreamCommit", 40), ("baseRevision", 40)):
            if not re.fullmatch(r"[0-9a-f]{%d}" % length, str(patch[key])):
                raise ValueError(f"Invalid patch {key}")
        if patch["baseRevision"] != config["mpvCommit"]:
            raise ValueError("Patch base differs from the pinned MPV revision")
        file = within(root, patch["file"])
        if not file.is_file() or digest(file) != patch["sha256"]:
            raise ValueError("Source patch checksum mismatch")
    return patches


def base_record(receipts, component, config):
    path = receipts / f"{component}.json"
    if not path.is_file():
        raise ValueError("Missing base source receipt")
    record = json.loads(path.read_text(encoding="utf-8"))
    archive = within(receipts, record["archive"])
    if record.get("revision") != config["mpvCommit"]:
        raise ValueError("Captured source revision differs from the patch base")
    if not archive.is_file() or digest(archive) != record["sha256"]:
        raise ValueError("Base source archive checksum mismatch")
    return record


def tree_entries(source):
    entries = []
    for item in sorted(source.rglob("*")):
        relative = item.relative_to(source)
        if ".git" in relative.parts:
            continue
        name = relative.as_posix()
        relative_path(name)
        if item.is_symlink():
            if not item.resolve().is_relative_to(source.resolve()):
                raise ValueError("Source symlink escapes the source tree")
            entries.append((name, "link", item.readlink().as_posix()))
        elif item.is_file():
            entries.append((name, "file", digest(item)))
        elif not item.is_dir():
            raise ValueError("Unsupported source file type")
    return entries


def entries_hash(entries):
    # File content, path and symlink targets are portable across capture hosts.
    # The archive checksum independently covers permissions and tar metadata.
    data = json.dumps(sorted(entries), ensure_ascii=True, separators=(",", ":")).encode("ascii")
    return hashlib.sha256(data).hexdigest()


def tree_hash(source):
    return entries_hash(tree_entries(source))


def archive_tree_hash(archive, component):
    entries, seen = [], set()
    with tarfile.open(archive) as bundle:
        for item in bundle:
            path = relative_path(item.name)
            if path.parts[0] != component or ".git" in path.parts or item.name in seen:
                raise ValueError("Invalid effective source archive member")
            seen.add(item.name)
            if item.isdir():
                continue
            name = PurePosixPath(*path.parts[1:]).as_posix()
            if len(path.parts) < 2:
                raise ValueError("Invalid effective source archive root")
            if item.isfile():
                result = hashlib.sha256()
                with bundle.extractfile(item) as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        result.update(block)
                entries.append((name, "file", result.hexdigest()))
            elif item.issym():
                target = PurePosixPath(item.linkname)
                if target.is_absolute() or "\\" in item.linkname or ":" in item.linkname:
                    raise ValueError("Unsafe effective source symlink")
                depth = len(path.parts) - 2
                for part in target.parts:
                    depth += -1 if part == ".." else 1
                    if depth < 0:
                        raise ValueError("Effective source symlink escapes its root")
                entries.append((name, "link", item.linkname))
            else:
                raise ValueError("Unsupported effective archive member type")
    return entries_hash(entries)


def expected_identity(config, base, patches):
    suffix = config.get("sourceVersionSuffix", "")
    if suffix != "-lampaua-d3d11":
        raise ValueError("Unexpected candidate source version suffix")
    return {"baseRevision": base["revision"], "baseArchiveSha256": base["sha256"],
            "patches": patches, "sourceVersionSuffix": suffix,
            "sourceVersion": base["sourceVersion"] + suffix}


def verify_patches(receipts, config):
    patches = patch_series("mpv", config)
    base = base_record(receipts, "mpv", config)
    path = receipts / "mpv-effective.json"
    if not path.is_file():
        raise ValueError("Missing effective source receipt")
    record = json.loads(path.read_text(encoding="utf-8"))
    for key, value in expected_identity(config, base, patches).items():
        if record.get(key) != value:
            raise ValueError(f"Effective source receipt mismatch: {key}")
    archive = within(receipts, record["archive"])
    if not archive.is_file() or digest(archive) != record["sha256"]:
        raise ValueError("Effective source archive checksum mismatch")
    if archive_tree_hash(archive, "mpv") != record["effectiveTreeSha256"]:
        raise ValueError("Effective source tree checksum mismatch")
    return record


def apply_tree(source, component, config, receipts, patches):
    for patch in patches:
        path = within(Path(config["_patchRoot"]), patch["file"])
        git(source, "apply", "--check", str(path))
        git(source, "apply", str(path))
    freeze(component, source, receipts / f"{component}.json", config["sourceVersionSuffix"])


def apply_patches(source, component, config, receipt_dir):
    source, receipts = source.resolve(), receipt_dir.resolve()
    patches = patch_series(component, config)
    base = base_record(receipts, component, config)
    identity = expected_identity(config, base, patches)
    try:
        if Path(git(source, "rev-parse", "--show-toplevel")).resolve() != source:
            raise ValueError("Source must be its own Git worktree")
        if git(source, "rev-parse", "HEAD") != base["revision"]:
            raise ValueError("Source HEAD differs from the captured base")
        existing = verify_patches(receipts, config) if (receipts / "mpv-effective.json").exists() else None
        if existing and tree_hash(source) == existing["effectiveTreeSha256"]:
            return existing
        if git(source, "status", "--porcelain", "--untracked-files=all", "--ignored"):
            raise ValueError("Refusing to patch dirty or unrecorded source files")
        # Validate the whole patch series before touching the actual build source.
        with tempfile.TemporaryDirectory(prefix="lampaua-patched-") as temporary:
            staged = Path(temporary) / component
            shutil.copytree(source, staged, symlinks=True)
            apply_tree(staged, component, config, receipts, patches)
            effective_hash = tree_hash(staged)
            if existing and effective_hash != existing["effectiveTreeSha256"]:
                raise ValueError("Replayed sources differ from preflight")
            if not existing:
                archive = receipts / f"{component}-effective.tar.gz"
                def exclude_git(info):
                    return None if ".git" in PurePosixPath(info.name).parts else info
                with tarfile.open(archive, "w:gz", compresslevel=3) as bundle:
                    bundle.add(staged, arcname=component, filter=exclude_git)
                existing = {"name": "mpv-effective", **identity, "effectiveTreeSha256": effective_hash,
                            "archive": archive.name, "sha256": digest(archive),
                            "size": archive.stat().st_size}
            apply_tree(source, component, config, receipts, patches)
            if tree_hash(source) != effective_hash:
                raise ValueError("Build source changed while applying patches")
            (receipts / "mpv-effective.json").write_text(json.dumps(existing, indent=2) + "\n", encoding="utf-8")
            return existing
    except subprocess.CalledProcessError as error:
        raise ValueError("Source patch validation or application failed") from error


def preflight_patches(receipts, config):
    """Replay the captured base in disposable storage, before any compiler runs."""
    base = base_record(receipts, "mpv", config)
    with tempfile.TemporaryDirectory(prefix="lampaua-patch-preflight-") as temporary:
        with tarfile.open(within(receipts, base["archive"])) as bundle:
            bundle.extractall(temporary, filter="data")
        return apply_patches(Path(temporary) / "mpv", "mpv", config, receipts)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--component", choices=("mpv",), required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--receipts", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(apply_patches(args.source, args.component, load_config(args.config), args.receipts), indent=2))
