"""Split a verified source bundle into checksum-pinned GitHub release assets."""

import argparse
import hashlib
import json
from pathlib import Path


RELEASE_FILE_LIMIT = 2 * 1024**3
DEFAULT_PART_SIZE = 1536 * 1024**2


def split_bundle(source, output, part_size=DEFAULT_PART_SIZE):
    if type(part_size) is not int or not 0 < part_size < RELEASE_FILE_LIMIT:
        raise ValueError("Part size must be positive and below 2 GiB")
    size = source.stat().st_size
    if not size:
        raise ValueError("Cannot split an empty source archive")
    output.mkdir(parents=True, exist_ok=False)
    created = []
    parts = []
    combined_hash = hashlib.sha256()
    remaining = size
    try:
        with source.open("rb") as archive:
            while remaining:
                asset = f"{source.name}.{len(parts) + 1:03d}"
                target = output / asset
                length = min(remaining, part_size)
                part_hash = hashlib.sha256()
                with target.open("xb") as part:
                    created.append(target)
                    pending = length
                    while pending:
                        chunk = archive.read(min(pending, 1024**2))
                        if not chunk:
                            raise ValueError("Source archive changed while splitting")
                        part.write(chunk)
                        part_hash.update(chunk)
                        combined_hash.update(chunk)
                        pending -= len(chunk)
                parts.append({"asset": asset, "sha256": part_hash.hexdigest(), "size": length})
                remaining -= length
            if archive.read(1):
                raise ValueError("Source archive changed while splitting")
        result = {"sourceAsset": source.name, "sourceSha256": combined_hash.hexdigest(), "sourceParts": parts}
        descriptor = output / "source-parts.json"
        with descriptor.open("x", encoding="utf-8") as stream:
            created.append(descriptor)
            json.dump(result, stream, indent=2)
            stream.write("\n")
        return result
    except BaseException:
        for path in created:
            path.unlink(missing_ok=True)
        output.rmdir()
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, required=True, help="New directory for the parts and checksums")
    parser.add_argument("--part-size", type=int, default=DEFAULT_PART_SIZE)
    args = parser.parse_args()
    print(json.dumps(split_bundle(args.source, args.output, args.part_size), indent=2))
