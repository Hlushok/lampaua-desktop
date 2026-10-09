import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from split_source_bundle import RELEASE_FILE_LIMIT, split_bundle


class SplitSourceBundleTests(unittest.TestCase):
    def test_parts_reassemble_exact_bytes_and_checksums(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "sources.tar.gz"
            data = bytes(range(251)) * 5
            source.write_bytes(data)
            result = split_bundle(source, root / "parts", 700)
            self.assertEqual(result["sourceAsset"], source.name)
            self.assertEqual(result["sourceSha256"], hashlib.sha256(data).hexdigest())
            self.assertEqual([part["asset"] for part in result["sourceParts"]],
                             ["sources.tar.gz.001", "sources.tar.gz.002"])
            joined = b""
            for part in result["sourceParts"]:
                content = (root / "parts" / part["asset"]).read_bytes()
                self.assertEqual(part["size"], len(content))
                self.assertEqual(part["sha256"], hashlib.sha256(content).hexdigest())
                self.assertLess(part["size"], RELEASE_FILE_LIMIT)
                joined += content
            self.assertEqual(joined, data)
            self.assertEqual(source.read_bytes(), data)
            self.assertEqual(json.loads((root / "parts/source-parts.json").read_text()), result)

    def test_rejects_empty_archive_and_invalid_part_sizes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "sources.tar.gz"
            source.write_bytes(b"")
            with self.assertRaisesRegex(ValueError, "empty"):
                split_bundle(source, root / "parts")
            source.write_bytes(b"source")
            for size in (0, -1, RELEASE_FILE_LIMIT, RELEASE_FILE_LIMIT + 1, 1.5, True):
                with self.subTest(size=size), self.assertRaisesRegex(ValueError, "Part size"):
                    split_bundle(source, root / "parts", size)
            self.assertFalse((root / "parts").exists())

    def test_existing_outputs_are_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "sources.tar.gz"
            source.write_bytes(b"source")
            output = root / "parts"
            output.mkdir()
            prior = output / "sources.tar.gz.001"
            prior.write_bytes(b"previous verified part")
            with self.assertRaises(FileExistsError):
                split_bundle(source, output, 3)
            self.assertEqual(prior.read_bytes(), b"previous verified part")

    def test_failed_split_removes_only_its_new_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "sources.tar.gz"
            source.write_bytes(b"complete source archive")
            output = root / "parts"
            original_open = Path.open

            def open_fixture(path, *args, **kwargs):
                if path == source and args == ("rb",):
                    return io.BytesIO(b"short")
                return original_open(path, *args, **kwargs)

            with patch.object(Path, "open", open_fixture), self.assertRaisesRegex(ValueError, "changed"):
                split_bundle(source, output, 10)
            self.assertFalse(output.exists())
            self.assertEqual(source.read_bytes(), b"complete source archive")


if __name__ == "__main__":
    unittest.main()
