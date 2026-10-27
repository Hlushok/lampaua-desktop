"""Verify availability, digest and platform of a pinned public build container."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from package_build import variant_paths


def download(url, headers):
    try:
        with urlopen(Request(url, headers=headers), timeout=60) as response:
            data = response.read(4 * 1024 * 1024 + 1)
    except HTTPError as error:
        raise ValueError(f"Pinned container metadata unavailable: HTTP {error.code}; "
                         "review the candidate container pin, never fall back to latest") from error
    if len(data) > 4 * 1024 * 1024:
        raise ValueError("Unexpectedly large container metadata")
    return data


def verify_image(image, get=download):
    match = re.fullmatch(r"ghcr\.io/(shinchiro/archlinux)@(sha256:[a-f0-9]{64})", image)
    if not match:
        raise ValueError("Expected a pinned public donor container")
    repository, digest = match.groups()
    token = json.loads(get(
        f"https://ghcr.io/token?scope=repository:{repository}:pull&service=ghcr.io", {}))["token"]
    headers = {"Authorization": f"Bearer {token}", "Accept": ", ".join((
        "application/vnd.oci.image.index.v1+json", "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json"))}

    def checked(kind, checksum):
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", checksum):
            raise ValueError("Unpinned container descriptor")
        data = get(f"https://ghcr.io/v2/{repository}/{kind}/{checksum}", headers)
        if "sha256:" + hashlib.sha256(data).hexdigest() != checksum:
            raise ValueError("Container metadata checksum mismatch")
        return json.loads(data)

    manifest = checked("manifests", digest)
    if "manifests" in manifest:
        candidates = [item for item in manifest["manifests"]
                      if item.get("platform", {}).get("os") == "linux"
                      and item["platform"].get("architecture") == "amd64"]
        if len(candidates) != 1:
            raise ValueError("Expected exactly one Linux amd64 container manifest")
        manifest = checked("manifests", candidates[0]["digest"])
    config = checked("blobs", manifest["config"]["digest"])
    if config.get("os") != "linux" or config.get("architecture") != "amd64":
        raise ValueError("Build container must be Linux amd64")
    return image


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--variant", choices=("baseline", "d3d11", "d3d11-next"), required=True)
    args = parser.parse_args()
    config_path, _ = variant_paths(Path(__file__).resolve().parents[2], args.variant)
    image = verify_image(json.loads(config_path.read_text(encoding="utf-8"))["container"])
    print(f"Verified pinned Linux amd64 container: {image}")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write(f"image={image}\n")
