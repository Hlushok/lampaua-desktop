"""Registry preflight never floats to latest or trusts an unchecked manifest."""
import hashlib
import json
import unittest

from verify_container_image import verify_image


class ContainerImageTests(unittest.TestCase):
    def fixture(self, platform=None, index=False):
        config = json.dumps(platform or {"os": "linux", "architecture": "amd64"}).encode()
        key = lambda data: "sha256:" + hashlib.sha256(data).hexdigest()
        manifest = json.dumps({"config": {"digest": key(config)}}).encode()
        image_manifest = json.dumps({"manifests": [
            {"digest": key(manifest), "platform": {"os": "linux", "architecture": "amd64"}}
        ]}).encode() if index else manifest
        image = "ghcr.io/shinchiro/archlinux@" + key(image_manifest)
        data = {"manifests/" + key(image_manifest): image_manifest,
                "manifests/" + key(manifest): manifest, "blobs/" + key(config): config}
        calls = []
        def get(url, headers):
            calls.append(url)
            if url.startswith("https://ghcr.io/token?"):
                return b'{"token":"fixture-token"}'
            self.assertEqual(headers["Authorization"], "Bearer fixture-token")
            return data[url.removeprefix("https://ghcr.io/v2/shinchiro/archlinux/")]
        return image, data, calls, get

    def test_verified_linux_amd64_manifest_and_index(self):
        for index in (False, True):
            image, _, calls, get = self.fixture(index=index)
            self.assertEqual(verify_image(image, get), image)
            self.assertFalse(any("latest" in url for url in calls))

    def test_changed_manifest_or_blob_is_rejected(self):
        for kind in ("manifests/", "blobs/"):
            image, data, _, get = self.fixture()
            path = next(path for path in data if path.startswith(kind))
            data[path] += b" "
            with self.assertRaisesRegex(ValueError, "checksum"):
                verify_image(image, get)

    def test_non_linux_amd64_is_rejected(self):
        image, _, _, get = self.fixture({"os": "linux", "architecture": "arm64"})
        with self.assertRaisesRegex(ValueError, "Linux amd64"):
            verify_image(image, get)

    def test_only_pinned_donor_images_are_allowed(self):
        for image in ("ghcr.io/shinchiro/archlinux:latest", "https://example.invalid/image",
                      "ghcr.io/other/image@sha256:" + "a" * 64):
            with self.subTest(image=image), self.assertRaisesRegex(ValueError, "pinned"):
                verify_image(image, lambda *_: self.fail("Unexpected network request"))


if __name__ == "__main__":
    unittest.main()
