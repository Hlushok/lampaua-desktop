"""Offline regression tests for source archive receipts and revision safety."""

import argparse
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

from capture_source import capture, digest, run


class SourceCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lampaua-capture-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "LICENSE").write_text("test license\n")
        (self.source / "code.c").write_text("int example;\n")
        self.args = argparse.Namespace(name="example", source=str(self.source),
                                      output=str(self.root / "archives"), repository="", url="https://example.invalid/source.tar.gz", url_hash="SHA256=test")

    def initialize_git(self):
        run("git", "init", str(self.source))
        run("git", "-C", str(self.source), "config", "user.name", "Source Test")
        run("git", "-C", str(self.source), "config", "user.email", "source@example.invalid")
        run("git", "-C", str(self.source), "add", ".")
        run("git", "-C", str(self.source), "commit", "-m", "fixture")
        self.args.repository = "https://example.invalid/source.git"
        run("git", "-C", str(self.source), "remote", "add", "origin", self.args.repository)

    def test_tarball_preserves_license_and_hash(self):
        result = capture(self.args)
        archive = Path(self.args.output) / result["archive"]
        self.assertEqual(digest(archive), result["sha256"])
        with tarfile.open(archive) as bundle:
            self.assertEqual(bundle.extractfile("example/LICENSE").read(), (self.source / "LICENSE").read_bytes())

    def test_existing_receipt_is_not_overwritten(self):
        expected = capture(self.args)
        self.assertEqual(capture(self.args), expected)
        self.assertEqual(json.loads((Path(self.args.output) / "example.json").read_text()), expected)

    def test_modified_archive_rejected(self):
        result = capture(self.args)
        (Path(self.args.output) / result["archive"]).write_bytes(b"changed")
        with self.assertRaises(ValueError):
            capture(self.args)

    def test_git_snapshot_can_be_reused_offline(self):
        self.initialize_git()
        result = capture(self.args)
        extracted = self.root / "extracted"
        with tarfile.open(Path(self.args.output) / result["archive"]) as bundle:
            bundle.extractall(extracted, filter="data")
        repo = extracted / "example"
        self.assertEqual(run("git", "-C", str(repo), "rev-parse", "HEAD"), result["revision"])
        self.assertEqual(run("git", "-C", str(repo), "remote", "get-url", "origin"), self.args.repository)
        self.assertEqual(run("git", "-C", str(repo), "status", "--porcelain"), "")

    def test_changed_revision_rejected(self):
        self.initialize_git()
        capture(self.args)
        (self.source / "code.c").write_text("int changed;\n")
        run("git", "-C", str(self.source), "commit", "-am", "changed")
        with self.assertRaises(ValueError):
            capture(self.args)

    def test_dirty_git_source_rejected(self):
        self.initialize_git()
        (self.source / "code.c").write_text("int uncommitted;\n")
        with self.assertRaises(subprocess.CalledProcessError):
            capture(self.args)


if __name__ == "__main__":
    unittest.main()
