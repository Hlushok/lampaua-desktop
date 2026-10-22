import hashlib
from copy import deepcopy
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from audit_runtime_sources import audit, collect_notices
from capture_source import digest
import audit_runtime_sources as source_audit


class RuntimeNoticeTests(unittest.TestCase):
    def test_original_bytes_paths_and_hashes_are_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "component.tar.gz"
            files = {"component/LICENSE": b"original license\r\n",
                     "component/vendor/NOTICE.txt": b"vendor attribution\n",
                     "component/../COPYING": b"GPL text\n",
                     "component/.git/NOTICE": b"not source attribution",
                     "component/code.c": b"source"}
            with tarfile.open(archive, "w:gz") as bundle:
                for name, data in files.items():
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    bundle.addfile(info, io.BytesIO(data))
            notices = collect_notices(archive, "component", root / "notices")
            self.assertEqual(len(notices), 3)
            for notice in notices:
                data = files[notice["source"]]
                self.assertEqual((root / "notices" / notice["file"]).read_bytes(), data)
                self.assertEqual(notice["sha256"], hashlib.sha256(data).hexdigest())
                self.assertTrue(notice["file"].startswith("component/"))
            self.assertFalse((root / "COPYING").exists())

    def test_invalid_component_and_existing_outputs_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, "component"):
                collect_notices(root / "unused.tar.gz", "../outside", root)
            (root / "component").mkdir()
            with self.assertRaises(FileExistsError):
                collect_notices(root / "unused.tar.gz", "component", root)

    def test_full_audit_includes_source_less_download_targets(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sources = root / "sources"
            projects = sources / "projects"
            projects.mkdir(parents=True)
            (root / "build").mkdir()
            config = {"sourceLock": "lock.json", "recipesCommit": "a" * 40,
                      "rustToolchain": "nightly-2026-10-08", "windowsMetadataCommit": "b" * 40}
            (root / "build/libmpv-source-build.json").write_text(json.dumps(config))
            names = ["gcc", "mpv", "subrandr", "subrandr-crates", "build-recipes",
                     "rust-standard-library", "windows-metadata"]
            lock = {name: {"repository": f"https://example.invalid/{name}.git", "revision": "c" * 40}
                    for name in ["gcc", "mpv", "subrandr"]}
            (root / "build/lock.json").write_text(json.dumps({"version": 1, "components": lock}))
            cargo = b"version = 3\n"
            records = []
            for name in names:
                archive = sources / f"{name}.tar.gz"
                files = {f"{name}/LICENSE": b"original attribution\n"}
                if name == "subrandr":
                    files[f"{name}/Cargo.lock"] = cargo
                with tarfile.open(archive, "w:gz") as bundle:
                    for path, data in files.items():
                        member = tarfile.TarInfo(path)
                        member.size = len(data)
                        bundle.addfile(member, io.BytesIO(data))
                record = {"name": name, "archive": archive.name, "sha256": digest(archive),
                          "size": archive.stat().st_size, **lock.get(name, {})}
                if name == "build-recipes":
                    record["revision"] = config["recipesCommit"]
                elif name == "rust-standard-library":
                    record["url"] = f"rustup:{config['rustToolchain']}:rust-src"
                elif name == "windows-metadata":
                    record["url"] = f"https://github.com/microsoft/windows-rs/tree/{config['windowsMetadataCommit']}"
                elif name == "subrandr-crates":
                    record["cargoLockSha256"] = hashlib.sha256(cargo).hexdigest()
                records.append(record)
                (sources / f"{name}.json").write_text(json.dumps(record))
            for name in ["gcc", "mpv", "subrandr", "gcc-wrapper", "winpthreads"]:
                data = {"dependencies": ["subrandr"] if name == "mpv" else [],
                        "hasSource": name in lock, **lock.get(name, {})}
                (projects / f"{name}.json").write_text(json.dumps(data))
            manifest = {"configuration": config, "components": records, "repositoryCommit": "d" * 40,
                        "dllSha256": "e" * 64,
                        "dependencyClosure": ["gcc", "gcc-wrapper", "mpv", "subrandr", "winpthreads"]}
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(manifest))
            (sources / "manifest.json").write_text(json.dumps(manifest))
            (sources / "CMakeCache.txt").write_text("GCC_ARCH:STRING=x86-64\n"
                "TARGET_ARCH:STRING=x86_64-w64-mingw32\nCOMPILER_TOOLCHAIN:STRING=gcc\n")
            with patch.object(hashlib, "file_digest", None, create=True):
                result = audit(sources, manifest_path, root, root / "notices")
            self.assertEqual(result["pinnedInputs"], 3)
            self.assertEqual(result["withoutNoticeFiles"], [])
            self.assertEqual(len(result["components"]), len(names))
            self.assertEqual(len(result["components"][0]["notices"]), 1)
            (sources / "subrandr.tar.gz").write_bytes(b"changed source")
            with self.assertRaisesRegex(ValueError, "Changed source archive"):
                audit(sources, manifest_path, root, root / "bad-notices")


class CandidateNoticeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lampaua-candidate-audit-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.sources = self.root / "sources"
        self.sources.mkdir()
        self.config_path = self.root / "build/libmpv-source-build.d3d11.json"
        self.config_path.parent.mkdir()
        patch_file = self.config_path.parent / "patches/mpv/fixture.patch"
        patch_file.parent.mkdir(parents=True)
        patch_file.write_bytes(b"preserved patch bytes\n")
        self.bundled = self.sources / "patches/mpv/fixture.patch"
        self.bundled.parent.mkdir(parents=True)
        self.bundled.write_bytes(patch_file.read_bytes())
        item = {"file": "patches/mpv/fixture.patch", "sha256": digest(patch_file),
                "baseRevision": "a" * 40, "upstreamCommit": "b" * 40}
        self.config = {"mpvCommit": "a" * 40, "sourceLock": "lock.json", "container": "fixture@sha256:" + "c" * 64,
                       "sourceVersionSuffix": "-lampaua-d3d11", "sourcePatches": {"mpv": [item]}}
        self.config_path.write_text(json.dumps(self.config))
        self.effective = {"baseRevision": "a" * 40, "patches": [item], "effectiveTreeSha256": "e" * 64}
        self.manifest = {"configuration": self.config, "components": [], "dependencyClosure": [],
                         "clientApiVersion": (2 << 16) | 6,
                         **deepcopy(self.effective)}

    def verify(self, manifest=None):
        with patch.object(source_audit, "verify_patches", return_value=self.effective) as verify:
            result = source_audit.verify_candidate_inputs(self.sources, manifest or self.manifest, self.config_path)
            verify.assert_called_once()
            self.assertEqual(verify.call_args.args[0], self.sources)
            return result

    def test_candidate_audit_verifies_effective_receipt_and_bundled_patch(self):
        report = self.verify()
        self.assertEqual(report["sourceVariant"], "d3d11")
        self.assertEqual(report["effectiveTreeSha256"], self.effective["effectiveTreeSha256"])
        self.assertEqual(report["container"], self.config["container"])

    def test_wrong_api_base_or_effective_tree_is_rejected(self):
        for key, value in (("clientApiVersion", (2 << 16) | 5),
                           ("baseRevision", "f" * 40), ("effectiveTreeSha256", "f" * 64),
                           ("patches", [])):
            with self.subTest(key=key):
                manifest = deepcopy(self.manifest)
                manifest[key] = value
                with self.assertRaises(ValueError):
                    self.verify(manifest)

    def test_changed_or_missing_bundled_patch_is_rejected(self):
        self.bundled.write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "Bundled patch"):
            self.verify()
        self.bundled.unlink()
        with self.assertRaises(FileNotFoundError):
            self.verify()

    def test_effective_source_verification_failure_is_not_ignored(self):
        with patch.object(source_audit, "verify_patches", side_effect=ValueError("Missing effective source receipt")), \
                self.assertRaisesRegex(ValueError, "Missing effective"):
            source_audit.verify_candidate_inputs(self.sources, self.manifest, self.config_path)

    def test_candidate_selects_its_configuration_before_source_graph_verification(self):
        (self.config_path.parent / "libmpv-source-build.json").write_text('{"baseline":true}')
        manifest = self.root / "manifest.json"
        manifest.write_text(json.dumps(self.manifest))
        (self.sources / "manifest.json").write_text(json.dumps(self.manifest))
        with patch.object(source_audit, "verify_patches", return_value=self.effective) as verify, \
                patch.object(source_audit, "load_lock", return_value={}), \
                patch.object(source_audit, "validate_sources", side_effect=ValueError("graph reached")), \
                self.assertRaisesRegex(ValueError, "graph reached"):
            source_audit.audit(self.sources, manifest, self.root, self.root / "notices", "d3d11")
        verify.assert_called_once()
        with self.assertRaisesRegex(ValueError, "Source configuration differs"):
            source_audit.audit(self.sources, manifest, self.root, self.root / "baseline-notices")


if __name__ == "__main__":
    unittest.main()
