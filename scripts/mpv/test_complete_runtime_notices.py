import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from complete_runtime_notices import complete


class CompleteNoticesTest(unittest.TestCase):
    def fixture(self, root):
        data = b"Original permission notice\n"
        archive = root / "source.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            member = tarfile.TarInfo("source/header.h")
            member.size = len(data)
            bundle.addfile(member, io.BytesIO(data))
        item = {"sourceComponent": "source", "source": "source/header.h",
                "file": "source/header.h", "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest()}
        previous = root / "previous.json"
        previous.write_text(json.dumps({"manualReview": [
            {"component": "source", "files": [item]}]}))
        notices = root / "notices"
        notices.mkdir()
        inventory = {"withoutNoticeFiles": ["source"], "components": [
            {"name": "source", "archive": archive.name,
             "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}]}
        (notices / "inventory.json").write_text(json.dumps(inventory))
        return previous, notices, item

    def test_original_bytes_and_review_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            previous, notices, _ = self.fixture(root)
            self.assertEqual(complete(root, previous, notices), 1)
            self.assertEqual((notices / "source/header.h").read_bytes(), b"Original permission notice\n")
            self.assertEqual(json.loads((notices / "inventory.json").read_text())["manualReview"],
                             json.loads(previous.read_text())["manualReview"])

    def test_corrupt_archive_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            previous, notices, _ = self.fixture(root)
            (root / "source.tar.gz").write_bytes(b"corrupt")
            with self.assertRaisesRegex(ValueError, "checksum"):
                complete(root, previous, notices)
            self.assertFalse((notices / "source/header.h").exists())

    def test_changed_notice_and_escape_rejected(self):
        for field, value, error in [("sha256", "0" * 64, "changed"),
                                    ("file", "../outside.h", "inside")]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                previous, notices, _ = self.fixture(root)
                document = json.loads(previous.read_text())
                document["manualReview"][0]["files"][0][field] = value
                previous.write_text(json.dumps(document))
                with self.assertRaisesRegex(ValueError, error):
                    complete(root, previous, notices)
                self.assertFalse((root / "outside.h").exists())


if __name__ == "__main__":
    unittest.main()
