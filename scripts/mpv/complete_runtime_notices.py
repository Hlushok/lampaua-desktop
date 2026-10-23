"""Replay reviewed header notices against the exact new source archives."""

import argparse
import hashlib
import json
from pathlib import Path
import tarfile


def complete(sources, previous, notices):
    inventory_path = notices / "inventory.json"
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    reviews = json.loads(previous.read_text(encoding="utf-8"))["manualReview"]
    if set(inventory["withoutNoticeFiles"]) != {item["component"] for item in reviews}:
        raise ValueError("Unreviewed components require a fresh manual review")
    components = {item["name"]: item for item in inventory["components"]}
    pending = []
    for review in reviews:
        for item in review["files"]:
            archive = sources / components[item["sourceComponent"]]["archive"]
            with archive.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if digest != components[item["sourceComponent"]]["sha256"]:
                raise ValueError("Source archive checksum mismatch")
            with tarfile.open(archive) as bundle:
                member = bundle.getmember(item["source"])
                if not member.isfile() or member.size != item["size"]:
                    raise ValueError("Reviewed notice size/type changed")
                with bundle.extractfile(member) as stream:
                    data = stream.read()
            if hashlib.sha256(data).hexdigest() != item["sha256"]:
                raise ValueError("Reviewed notice changed; manual review required")
            target = (notices / item["file"]).resolve()
            if not target.is_relative_to(notices.resolve()):
                raise ValueError("Notice must stay inside output")
            pending.append((target, data))
    for target, data in pending:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    inventory["manualReview"] = reviews
    inventory_path.write_text(json.dumps(inventory, indent=2) + "\n", encoding="utf-8")
    return len(pending)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, required=True)
    parser.add_argument("--previous-inventory", type=Path, required=True)
    parser.add_argument("--notices", type=Path, required=True)
    args = parser.parse_args()
    print(f"Verified {complete(args.sources, args.previous_inventory, args.notices)} original reviewed files")
