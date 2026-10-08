"""Attach static OpenSSL metadata after the existing required package lookup."""

import argparse
from pathlib import Path
import re


def patch(source):
    path = source / "CMakeLists.txt"
    text = path.read_text(encoding="utf-8")
    marker = 'include("$ENV{LAMPAUA_MPV_SCRIPTS}/static-openssl.cmake")'
    pattern = r"(?m)^([ \t]*)find_package\(OpenSSL [^\r\n]*\)$"
    matches = list(re.finditer(pattern, text))
    if len(matches) != 1:
        raise ValueError(f"Unexpected OpenSSL lookup in {path}")
    match = matches[0]
    insertion = f"{match[0]}\n{match[1]}{marker}"
    if marker in text:
        if text.count(marker) != 1 or insertion not in text:
            raise ValueError(f"Unexpected existing OpenSSL hook in {path}")
        return
    updated = text[:match.start()] + insertion + text[match.end():]
    path.write_text(updated, encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    patch(parser.parse_args().source.resolve())
