"""Offline checks for the byte-identical candidate source download fallback."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from capture_source import digest
import seed_source_download as download


class SourceDownloadTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lampaua-source-download-")
        self.addCleanup(self.temporary.cleanup)
        self.work = Path(self.temporary.name)
        self.data = b"pinned archive bytes"
        original = self.work / "fixture.tar.gz"
        original.write_bytes(self.data)
        self.pin = {"url": download.ORIGIN, "urlHash": "SHA256=" + digest(original).upper()}
        self.hash_patch = patch.object(download, "PINNED_HASH", self.pin["urlHash"])
        self.hash_patch.start()
        self.addCleanup(self.hash_patch.stop)
        self.calls = []

    def fetch(self, url, destination):
        self.calls.append(url)
        if url == download.ORIGIN:
            raise OSError("connection refused")
        destination.write_bytes(self.data)

    def test_unavailable_origin_uses_identical_mirror_and_records_actual_url(self):
        result = download.seed(self.work, {"libopenmpt": self.pin}, self.fetch)
        self.assertEqual(self.calls, [download.ORIGIN, download.MIRROR])
        self.assertEqual(result["downloadUrl"], download.MIRROR)
        archive = self.work / "trees/libopenmpt" / download.FILENAME
        self.assertEqual(archive.read_bytes(), self.data)
        self.assertEqual(result["sha256"], digest(archive))
        receipt = self.work / "sources/downloads/libopenmpt.json"
        self.assertEqual(json.loads(receipt.read_text()), result)

    def test_origin_is_preferred_when_available(self):
        def fetch(url, destination):
            self.calls.append(url)
            destination.write_bytes(self.data)
        result = download.seed(self.work, {"libopenmpt": self.pin}, fetch)
        self.assertEqual(self.calls, [download.ORIGIN])
        self.assertEqual(result["downloadUrl"], download.ORIGIN)

    def test_changed_pin_is_rejected_before_any_download(self):
        for key, value in (("url", "https://other.invalid/source.tar.gz"), ("urlHash", "SHA256=" + "f" * 64)):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "Unexpected libopenmpt pin"):
                download.seed(self.work, {"libopenmpt": {**self.pin, key: value}}, self.fetch)
        self.assertEqual(self.calls, [])

    def test_mirror_hash_mismatch_or_network_failure_cannot_seed_archive(self):
        for payload in (b"tampered", None):
            def fetch(url, destination):
                if payload is None:
                    raise OSError("offline")
                destination.write_bytes(payload)
            with self.subTest(payload=payload), self.assertRaisesRegex(ValueError, "No verified libopenmpt archive"):
                download.seed(self.work, {"libopenmpt": self.pin}, fetch)
            self.assertFalse((self.work / "trees/libopenmpt" / download.FILENAME).exists())
            self.assertFalse((self.work / "sources/downloads/libopenmpt.json").exists())
            self.assertFalse(list(self.work.rglob("*.partial")))

    def test_existing_archive_and_receipt_are_not_silently_replaced(self):
        download.seed(self.work, {"libopenmpt": self.pin}, self.fetch)
        with self.assertRaises(FileExistsError):
            download.seed(self.work, {"libopenmpt": self.pin}, self.fetch)

    def test_cmake_verifies_and_extracts_seed_without_contacting_unavailable_origin(self):
        source = self.work / "source.c"
        source.write_text("int example;\n")
        archive = self.work / "fixture.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            bundle.add(source, arcname="fixture/source.c")
        self.data = archive.read_bytes()
        origin = "https://example.invalid/" + download.FILENAME
        pin = {"url": origin, "urlHash": "SHA256=" + digest(archive).upper()}
        with patch.object(download, "ORIGIN", origin), patch.object(download, "PINNED_HASH", pin["urlHash"]):
            download.seed(self.work, {"libopenmpt": pin}, self.fetch)
        (self.work / "CMakeLists.txt").write_text(
            'cmake_minimum_required(VERSION 3.20)\nproject(SeededInput NONE)\ninclude(ExternalProject)\n'
            'set_property(DIRECTORY PROPERTY EP_STEP_TARGETS download)\n'
            f'ExternalProject_Add(example URL "{origin}" URL_HASH {pin["urlHash"]}\n'
            f'  DOWNLOAD_DIR "{(self.work / "trees/libopenmpt").as_posix()}"\n'
            '  TIMEOUT 1 CONFIGURE_COMMAND "" BUILD_COMMAND "" INSTALL_COMMAND "")\n')
        cmake = os.environ.get("LAMPAUA_CMAKE") or shutil.which("cmake")
        self.assertIsNotNone(cmake)
        args = [cmake, "-S", str(self.work), "-B", str(self.work / "build")]
        if os.name == "nt":
            nmake = Path("C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.51.36231/bin/Hostx64/x64/nmake.exe")
            self.assertTrue(nmake.is_file())
            args += ["-G", "NMake Makefiles", f"-DCMAKE_MAKE_PROGRAM={nmake.as_posix()}"]
        for command in (args, [cmake, "--build", str(self.work / "build"), "--target", "example-download"]):
            result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout)
        extracted = self.work / "build/example-prefix/src/example/source.c"
        self.assertEqual(extracted.read_bytes(), source.read_bytes())


if __name__ == "__main__":
    unittest.main()
