"""Preserve version-generation inputs when replaying shallow source archives."""

import argparse
import json
from pathlib import Path


def freeze(name, source, receipt):
    version = json.loads(receipt.read_text())["sourceVersion"]
    if not version or "\n" in version or "\r" in version:
        raise ValueError("Invalid recorded source version")
    if name == "ffmpeg":
        (source / "FF_VERSION").write_text(version + "\n")
    elif name == "mpv":
        path = source / "common/meson.build"
        text = path.read_text()
        marker = 'git_cmd = [sys.argv[1],'
        if text.count(marker) != 1:
            raise ValueError("Unexpected MPV version generator")
        code = ('recorded = os.path.join(sys.argv[2], "lampaua-source-version.txt")\n'
                'if os.path.isfile(recorded):\n'
                '    with open(recorded, encoding="UTF-8") as stream:\n'
                '        sys.stdout.write(stream.read().strip())\n'
                '    sys.exit(0)\n')
        path.write_text(text.replace(marker, code + marker))
        (source / "lampaua-source-version.txt").write_text(version + "\n")
    else:
        raise ValueError("Unsupported version generator")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", choices=("mpv", "ffmpeg"), required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    freeze(args.name, args.source, args.receipt)
