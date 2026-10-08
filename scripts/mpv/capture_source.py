"""Capture an ExternalProject input before patches or compilation change it."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile


def run(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def source_version(source, name):
    if name == "mpv":
        base = ["git", "-C", str(source), "describe", "--abbrev=9", "--tags", "--dirty", "--match", "v0.*"]
        try:
            return run(*base)
        except subprocess.CalledProcessError:
            version = (source / "MPV_VERSION").read_text().strip().replace("-UNKNOWN", "")
            return f"v{version}-dev-g{run(*base, '--always')}"
    if name == "ffmpeg":
        return run("bash", str(source / "ffbuild/version.sh"), str(source))
    return None


def snapshot_git(source, destination):
    run("git", "-C", str(source), "diff", "--exit-code", "HEAD")
    revision = run("git", "-C", str(source), "rev-parse", "HEAD")
    repository = run("git", "-C", str(source), "remote", "get-url", "origin")
    if not repository.startswith("https://") or "@" in repository.split("//", 1)[1].split("/", 1)[0]:
        raise ValueError(f"Non-public repository URL: {repository}")
    # upload-pack does not lazily fetch omitted sparse/partial-clone blobs.
    # archive materializes every HEAD blob before the local shallow transport.
    materialized = destination.parent / f"{destination.name}-materialized.tar"
    run("git", "-C", str(source), "archive", "HEAD", "--format=tar", f"--output={materialized}")
    materialized.unlink()
    run("git", "clone", "--depth", "1", "--no-local", source.as_uri(), str(destination))
    run("git", "-C", str(destination), "remote", "set-url", "origin", repository)
    if run("git", "-C", str(destination), "rev-parse", "HEAD") != revision:
        raise ValueError("Source changed during capture")
    submodules = []
    modules = source / ".gitmodules"
    if modules.exists():
        paths = subprocess.run(("git", "-C", str(source), "config", "--file", str(modules), "--get-regexp", r"^submodule\..*\.path$"),
                               stdout=subprocess.PIPE, text=True)
        # A valid config with no matching keys has exit code 1.
        if paths.returncode != 1:
            paths.check_returncode()
        for entry in paths.stdout.splitlines():
            relative = entry.split(" ", 1)[1]
            child = source / relative
            if (child / ".git").exists():
                submodules.append({"path": relative, **snapshot_git(child, destination / relative)})
    return {"revision": revision, "repository": repository, "submodules": submodules}


def capture(args):
    source = Path(args.source).resolve()
    output = Path(args.output).resolve()
    if not source.is_dir() or not any(source.iterdir()):
        raise ValueError(f"Missing source tree: {source}")
    if not args.name.replace("-", "").replace("_", "").isalnum():
        raise ValueError("Invalid component name")
    output.mkdir(parents=True, exist_ok=True)
    receipt = output / f"{args.name}.json"
    if receipt.exists():
        existing = json.loads(receipt.read_text(encoding="utf-8"))
        if digest(output / existing["archive"]) != existing["sha256"]:
            raise ValueError("Existing source archive changed")
        if args.repository and run("git", "-C", str(source), "rev-parse", "HEAD") != existing["revision"]:
            raise ValueError("Refusing to replace a captured source revision")
        return existing
    record = {"name": args.name, "url": args.url, "urlHash": args.url_hash}
    with tempfile.TemporaryDirectory(prefix="lampaua-source-") as temporary:
        tree = Path(temporary) / args.name
        if args.repository:
            version = source_version(source, args.name)
            record.update(snapshot_git(source, tree))
            if version:
                record["sourceVersion"] = version
        else:
            shutil.copytree(source, tree, symlinks=True)
        archive = output / f"{args.name}.tar.gz"
        with tarfile.open(archive, "w:gz", compresslevel=3) as bundle:
            bundle.add(tree, arcname=args.name)
        record.update(archive=archive.name, sha256=digest(archive), size=archive.stat().st_size)
    receipt.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return record


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("name", "source", "output"):
        parser.add_argument(f"--{key}", required=True)
    for key in ("repository", "url", "url-hash"):
        parser.add_argument(f"--{key}", default="")
    print(json.dumps(capture(parser.parse_args()), indent=2))
