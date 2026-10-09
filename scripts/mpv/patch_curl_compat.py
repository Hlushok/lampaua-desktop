"""Use a real API probe instead of a development OpenSSL version number."""

import argparse
from pathlib import Path
import re


def patched_texts(source):
    code = source / "lib/vtls/openssl.c"
    cmake = source / "CMakeLists.txt"
    original = code.read_text(encoding="utf-8")
    text = cmake.read_text(encoding="utf-8")
    old = "#if OPENSSL_VERSION_NUMBER < 0x40100000L\nstatic size_t ASN1_STRING_get_length"
    new = "#ifndef LAMPAUA_HAVE_ASN1_STRING_GET_LENGTH\nstatic size_t ASN1_STRING_get_length"
    if original.count(old) == 1 and new not in original:
        updated = original.replace(old, new)
    elif original.count(new) == 1 and old not in original:
        updated = original
    else:
        raise ValueError("Unexpected curl ASN1 fallback guard")
    anchor = 'include("$ENV{LAMPAUA_MPV_SCRIPTS}/static-openssl.cmake")'
    marker = 'include("$ENV{LAMPAUA_MPV_SCRIPTS}/curl-openssl-compat.cmake")'
    matches = list(re.finditer(rf"(?m)^([ \t]*){re.escape(anchor)}$", text))
    if len(matches) != 1:
        raise ValueError("Unexpected curl static OpenSSL hook")
    match = matches[0]
    insertion = f"{match[0]}\n{match[1]}{marker}"
    if marker in text:
        if text.count(marker) != 1 or insertion not in text:
            raise ValueError("Unexpected existing curl compatibility hook")
        cmake_updated = text
    else:
        cmake_updated = text[:match.start()] + insertion + text[match.end():]
    return ((code, updated), (cmake, cmake_updated))


def patch(source):
    updates = patched_texts(source)
    for path, text in updates:
        path.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    patch(parser.parse_args().source.resolve())
