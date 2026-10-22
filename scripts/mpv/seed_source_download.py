"""Seed one pinned source archive without changing its recipe or source identity."""

import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from capture_source import digest
from preflight_sources import load_lock


FILENAME = "libopenmpt-0.7.12+release.autotools.tar.gz"
ORIGIN = "https://lib.openmpt.org/files/libopenmpt/src/" + FILENAME
MIRROR = "https://ftp.gathering.org/Scene/OpenMPT/archive/libopenmpt/src/" + FILENAME
PINNED_HASH = "SHA256=79AB3CE3672601E525B5CC944F026C80C03032F37D39CAA84C8CA3FDD75E0C98"


def fetch(url, destination):
    subprocess.run(["curl", "--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
                    "--connect-timeout", "15", "--max-time", "30", "--retry", "1",
                    "--retry-all-errors", "--retry-max-time", "60", url, "-o", str(destination)],
                   check=True, timeout=75)


def seed(work, pins, transfer=fetch):
    pin = pins.get("libopenmpt")
    if pin != {"url": ORIGIN, "urlHash": PINNED_HASH}:
        raise ValueError("Unexpected libopenmpt pin; review fallback before changing source inputs")
    directory = work / "trees/libopenmpt"
    archive = directory / FILENAME
    receipt = work / "sources/downloads/libopenmpt.json"
    if archive.exists() or receipt.exists():
        raise FileExistsError("Refusing to replace an existing source download")
    directory.mkdir(parents=True, exist_ok=True)
    expected = PINNED_HASH.split("=", 1)[1].lower()
    errors = []
    for url in (ORIGIN, MIRROR):
        with tempfile.NamedTemporaryFile(dir=directory, suffix=".partial", delete=False) as stream:
            temporary = Path(stream.name)
        try:
            transfer(url, temporary)
            if digest(temporary) != expected:
                raise ValueError("source archive SHA-256 mismatch")
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            errors.append(f"{url}: {error}")
            temporary.unlink(missing_ok=True)
            continue
        temporary.replace(archive)
        record = {"origin": ORIGIN, "downloadUrl": url, "urlHash": PINNED_HASH,
                  "sha256": expected, "size": archive.stat().st_size}
        receipt.parent.mkdir(parents=True, exist_ok=True)
        receipt.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        print(f"Verified libopenmpt download: {url}; SHA-256 {expected}", flush=True)
        return record
    raise ValueError("No verified libopenmpt archive: " + "; ".join(errors))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--lock", type=Path, required=True)
    args = parser.parse_args()
    seed(args.work.resolve(), load_lock(args.lock))
