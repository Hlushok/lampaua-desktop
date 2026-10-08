"""Offline regression tests for source archive receipts and revision safety."""

import argparse
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from capture_source import capture, digest, run
from freeze_version import freeze
from package_build import validate_sources


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

    def test_partial_sparse_clone_materializes_omitted_blobs(self):
        (self.source / "omitted.txt").write_bytes(b"must be included\n" * 10000)
        (self.source / ".gitattributes").write_text("omitted.txt export-ignore\n")
        self.initialize_git()
        origin = self.root / "origin.git"
        run("git", "clone", "--bare", str(self.source), str(origin))
        run("git", "-C", str(origin), "config", "uploadpack.allowFilter", "true")
        sparse = self.root / "sparse"
        run("git", "clone", "--filter=blob:none", "--no-checkout", origin.as_uri(), str(sparse))
        run("git", "-C", str(sparse), "sparse-checkout", "set", "--no-cone", "/code.c")
        run("git", "-C", str(sparse), "checkout")
        missing = run("git", "-C", str(sparse), "rev-list", "--objects", "--missing=print", "HEAD")
        self.assertTrue(any(line.startswith("?") for line in missing.splitlines()))
        self.args.source = str(sparse)

        def local_transport(*args, **kwargs):
            if args[-3:] == ("remote", "get-url", "origin"):
                return self.args.repository
            return run(*args, **kwargs)

        # Keep the regression fully offline; only the recorded public URL is
        # mocked, not the partial-clone object transport or archive operation.
        with patch("capture_source.run", side_effect=local_transport):
            result = capture(self.args)
        with tarfile.open(Path(self.args.output) / result["archive"]) as bundle:
            self.assertEqual(bundle.extractfile("example/omitted.txt").read(), (self.source / "omitted.txt").read_bytes())

    def test_source_only_dependency_is_required(self):
        output = self.root / "metadata"
        projects = output / "projects"
        projects.mkdir(parents=True)
        for name, dependencies, has_source in (("gcc", [], False), ("mpv", ["glad"], False), ("glad", [], True)):
            (projects / f"{name}.json").write_text(json.dumps({"hasSource": has_source, "dependencies": dependencies}))
        with self.assertRaisesRegex(ValueError, "Uncaptured dependency: glad"):
            validate_sources(output, [])
        (output / "glad.tar.gz").write_bytes(b"source fixture")
        receipt = {"name": "glad", "archive": "glad.tar.gz", "sha256": digest(output / "glad.tar.gz")}
        self.assertEqual(validate_sources(output, [receipt]), ["gcc", "glad", "mpv"])
        (projects / "cppwinrt.json").write_text(json.dumps({"hasSource": True, "dependencies": []}))
        with self.assertRaisesRegex(ValueError, "Uncaptured dependency: cppwinrt"):
            validate_sources(output, [receipt], ["cppwinrt"])

    def test_frozen_versions_survive_shallow_history(self):
        version = "v0.41.0-42-g012345678"
        receipt = self.root / "mpv.json"
        receipt.write_text(json.dumps({"sourceVersion": version}))
        common = self.source / "common"
        common.mkdir()
        (common / "meson.build").write_text('git_cmd = [sys.argv[1], "describe"]\n')
        freeze("mpv", self.source, receipt)
        self.assertEqual((self.source / "lampaua-source-version.txt").read_text().strip(), version)
        self.assertIn("sys.exit(0)", (common / "meson.build").read_text())
        freeze("ffmpeg", self.source, receipt)
        self.assertEqual((self.source / "FF_VERSION").read_text().strip(), version)


if __name__ == "__main__":
    unittest.main()
