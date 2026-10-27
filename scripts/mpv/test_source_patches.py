"""Offline source-patch provenance, replay and candidate isolation contracts."""

import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

from capture_source import digest, run

try:
    from apply_source_patches import apply_patches, verify_patches
except ModuleNotFoundError:
    apply_patches = verify_patches = None


class SourcePatchTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(apply_patches, "Source-patch helper is not implemented")
        self.temporary = tempfile.TemporaryDirectory(prefix="lampaua-source-patch-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "common").mkdir()
        (self.source / "common/meson.build").write_text(
            "import os, sys\ngit_cmd = [sys.argv[1], 'describe']\n", encoding="utf-8", newline="\n")
        (self.source / "code.c").write_text("int before;\n", encoding="utf-8", newline="\n")
        (self.source / "LICENSE").write_text("source license\n", encoding="utf-8")
        run("git", "init", "--quiet", str(self.source))
        run("git", "-C", str(self.source), "config", "core.autocrlf", "false")
        run("git", "-C", str(self.source), "add", ".")
        run("git", "-C", str(self.source), "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
            "commit", "--quiet", "-m", "base")
        self.base = run("git", "-C", str(self.source), "rev-parse", "HEAD")
        self.receipts = self.root / "sources"
        self.receipts.mkdir()
        self.archive = self.receipts / "mpv.tar.gz"
        with tarfile.open(self.archive, "w:gz") as bundle:
            bundle.add(self.source, arcname="mpv")
        self.record = {"name": "mpv", "revision": self.base, "sourceVersion": "v0.41-test",
                       "archive": self.archive.name, "sha256": digest(self.archive)}
        (self.receipts / "mpv.json").write_text(json.dumps(self.record), encoding="utf-8")
        self.build = self.root / "build"
        self.build.mkdir()
        self.patch = self.build / "change.patch"
        self.patch.write_text(
            "diff --git a/code.c b/code.c\n--- a/code.c\n+++ b/code.c\n@@ -1 +1 @@\n-int before;\n+int after;\n",
            encoding="utf-8", newline="\n")
        self.config = {"mpvCommit": self.base, "sourceVersionSuffix": "-lampaua-d3d11",
                       "_patchRoot": self.build, "sourcePatches": {"mpv": [{"file": "change.patch",
                       "sha256": digest(self.patch), "upstreamCommit": "b" * 40, "baseRevision": self.base}]}}

    def apply(self, source=None, config=None):
        return apply_patches(source or self.source, "mpv", config or self.config, self.receipts)

    def fresh_source(self):
        target = self.root / "fresh"
        shutil.copytree(self.source, target)
        return target

    def test_applied_sources_have_matching_archive_and_repeatable_receipt(self):
        baseline_archive = self.archive.read_bytes()
        result = self.apply()
        self.assertEqual(result["baseRevision"], self.base)
        self.assertEqual(result["patches"][0]["sha256"], digest(self.patch))
        self.assertEqual(len(result["effectiveTreeSha256"]), 64)
        self.assertEqual((self.source / "code.c").read_text(), "int after;\n")
        self.assertEqual((self.source / "lampaua-source-version.txt").read_text().strip(), "v0.41-test-lampaua-d3d11")
        self.assertEqual(self.archive.read_bytes(), baseline_archive)
        self.assertEqual(digest(self.receipts / result["archive"]), result["sha256"])
        with tarfile.open(self.receipts / result["archive"]) as bundle:
            self.assertEqual(bundle.extractfile("mpv/code.c").read(), b"int after;\n")
            self.assertFalse(any(".git" in Path(item.name).parts for item in bundle))
        self.assertEqual(self.apply(), result)
        verify_patches(self.receipts, self.config)

    def test_fresh_clean_source_replays_the_preflight_receipt(self):
        fresh = self.fresh_source()
        expected = self.apply()
        self.assertEqual(self.apply(fresh), expected)
        self.assertEqual((fresh / "code.c").read_text(), "int after;\n")

    def test_wrong_hash_and_wrong_base_leave_source_unchanged(self):
        for key, value in (("sha256", "0" * 64), ("baseRevision", "c" * 40)):
            config = copy.deepcopy(self.config)
            config["sourcePatches"]["mpv"][0][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.apply(config=config)
            self.assertEqual((self.source / "code.c").read_text(), "int before;\n")

    def test_patch_paths_cannot_escape_config_directory(self):
        for name in ("../change.patch", "/tmp/change.patch", "C:/change.patch", "..\\change.patch"):
            config = copy.deepcopy(self.config)
            config["sourcePatches"]["mpv"][0]["file"] = name
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.apply(config=config)

    def test_tracked_and_untracked_dirty_source_are_rejected(self):
        code = self.source / "code.c"
        code.write_text("user edit\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            self.apply()
        code.write_text("int before;\n", encoding="utf-8", newline="\n")
        (self.source / "private.txt").write_text("user file\n")
        with self.assertRaises(ValueError):
            self.apply()

    def test_changed_effective_tree_and_archive_are_rejected(self):
        result = self.apply()
        (self.source / "code.c").write_text("changed\n")
        with self.assertRaises(ValueError):
            self.apply()
        (self.receipts / result["archive"]).write_bytes(b"changed archive")
        with self.assertRaises(ValueError):
            verify_patches(self.receipts, self.config)

    def test_existing_receipt_rejects_a_different_patch_series(self):
        self.apply()
        config = copy.deepcopy(self.config)
        config["sourcePatches"]["mpv"][0]["upstreamCommit"] = "d" * 40
        with self.assertRaises(ValueError):
            self.apply(config=config)

    def test_partial_patch_failure_does_not_mutate_real_source(self):
        self.patch.write_text(self.patch.read_text() +
            "diff --git a/missing.c b/missing.c\n--- a/missing.c\n+++ b/missing.c\n@@ -1 +1 @@\n-old\n+new\n",
            encoding="utf-8", newline="\n")
        self.config["sourcePatches"]["mpv"][0]["sha256"] = digest(self.patch)
        with self.assertRaises(ValueError):
            self.apply()
        self.assertEqual((self.source / "code.c").read_text(), "int before;\n")
        self.assertFalse((self.receipts / "mpv-effective.json").exists())

    def test_corrupt_base_archive_is_rejected(self):
        self.archive.write_bytes(b"tampered")
        with self.assertRaises(ValueError):
            self.apply()

    def test_missing_effective_receipt_is_not_silently_accepted(self):
        with self.assertRaises(ValueError):
            verify_patches(self.receipts, self.config)

    def test_preflight_materializes_base_without_mutating_build_source(self):
        from apply_source_patches import preflight_patches
        result = preflight_patches(self.receipts, self.config)
        self.assertEqual(result["name"], "mpv-effective")
        self.assertEqual((self.source / "code.c").read_text(), "int before;\n")
        self.assertEqual(self.apply(), result)

    @unittest.skipUnless(os.name == "nt", "Windows cannot represent POSIX executable bits")
    def test_linux_capture_permissions_do_not_hide_real_windows_source_changes(self):
        run("git", "-C", str(self.source), "update-index", "--chmod=+x", "code.c")
        run("git", "-C", str(self.source), "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
            "commit", "--quiet", "-m", "executable source")
        run("git", "-C", str(self.source), "config", "core.filemode", "true")
        self.base = run("git", "-C", str(self.source), "rev-parse", "HEAD")
        self.config["mpvCommit"] = self.base
        self.config["sourcePatches"]["mpv"][0]["baseRevision"] = self.base
        with tarfile.open(self.archive, "w:gz") as bundle:
            bundle.add(self.source, arcname="mpv")
        self.record.update(revision=self.base, sha256=digest(self.archive))
        (self.receipts / "mpv.json").write_text(json.dumps(self.record))
        self.apply()
        (self.source / "code.c").write_bytes(b"actual edit\n")
        with self.assertRaises(ValueError):
            self.apply()


    def native_config(self):
        files = {
            "include/mpv/client.h": "#define MPV_CLIENT_API_VERSION MPV_MAKE_VERSION(2, 6)\n",
            "include/mpv/render_d3d11.h": "mpv_d3d11_init_params mpv_d3d11_fbo\n",
            "video/out/d3d11/libmpv_d3d11.c": "libmpv_gpu_context_d3d11\n",
        }
        for name, text in files.items():
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8", newline="\n")
        run("git", "-C", str(self.source), "add", ".")
        run("git", "-C", str(self.source), "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
            "commit", "--quiet", "-m", "upstream native D3D11")
        self.base = run("git", "-C", str(self.source), "rev-parse", "HEAD")
        with tarfile.open(self.archive, "w:gz") as bundle:
            bundle.add(self.source, arcname="mpv")
        self.record.update(revision=self.base, sha256=digest(self.archive))
        (self.receipts / "mpv.json").write_text(json.dumps(self.record), encoding="utf-8")
        config = copy.deepcopy(self.config)
        config.update(mpvCommit=self.base, nativeD3d11=True, sourcePatches={"mpv": []})
        return config

    def test_upstream_native_d3d11_preserves_effective_sources_without_backport(self):
        config = self.native_config()
        result = self.apply(config=config)
        self.assertTrue(result["nativeD3d11"])
        self.assertEqual(result["patches"], [])
        self.assertEqual((self.source / "code.c").read_text(), "int before;\n")
        self.assertEqual(verify_patches(self.receipts, config), result)
        self.assertEqual(self.apply(config=config), result)

    def test_empty_series_requires_explicit_native_mode_and_native_mode_forbids_backport(self):
        config = copy.deepcopy(self.config)
        config["sourcePatches"]["mpv"] = []
        with self.assertRaises(ValueError):
            self.apply(config=config)
        config["sourcePatches"] = self.config["sourcePatches"]
        config["nativeD3d11"] = True
        with self.assertRaises(ValueError):
            self.apply(config=config)
        self.assertEqual((self.source / "code.c").read_text(), "int before;\n")

    def test_native_mode_requires_render_header_backend_and_api_26(self):
        for name, value in (("include/mpv/render_d3d11.h", ""),
                            ("video/out/d3d11/libmpv_d3d11.c", ""),
                            ("include/mpv/client.h", "#define MPV_CLIENT_API_VERSION MPV_MAKE_VERSION(2, 5)\n")):
            with self.subTest(name=name):
                config = self.native_config()
                # Commit and capture the invalid fixture so dirty-source rejection
                # cannot hide a missing-backend/API validation bug.
                (self.source / name).write_text(value, encoding="utf-8")
                run("git", "-C", str(self.source), "add", ".")
                run("git", "-C", str(self.source), "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                    "commit", "--quiet", "-m", "invalid native fixture")
                config["mpvCommit"] = run("git", "-C", str(self.source), "rev-parse", "HEAD")
                with tarfile.open(self.archive, "w:gz") as bundle:
                    bundle.add(self.source, arcname="mpv")
                self.record.update(revision=config["mpvCommit"], sha256=digest(self.archive))
                (self.receipts / "mpv.json").write_text(json.dumps(self.record))
                with self.assertRaises(ValueError):
                    self.apply(config=config)
                self.assertFalse((self.receipts / "mpv-effective.json").exists())


class CandidateBuildContracts(unittest.TestCase):
    root = Path(__file__).resolve().parents[2]

    def test_native_candidate_changes_only_reviewed_core_pins(self):
        from apply_source_patches import load_config, patch_series
        from preflight_sources import load_lock, validate_config
        accepted = load_config(self.root / "build/libmpv-source-build.d3d11.json")
        native = load_config(self.root / "build/libmpv-source-build.d3d11-next.json")
        pins = load_lock(self.root / "build" / native["sourceLock"])
        old_pins = load_lock(self.root / "build" / accepted["sourceLock"])
        validate_config(native, pins)
        self.assertEqual(set(pins), set(old_pins))
        self.assertEqual({name for name in pins if pins[name] != old_pins[name]}, {"mpv", "ffmpeg"})
        self.assertEqual(native["recipesCommit"], "1f8d2e76255abc48f0456d9be99b4cab9c6566e6")
        self.assertEqual(native["mpvCommit"], "82667e3cb116969ec930897a6bf22395e8cd2c36")
        self.assertEqual(native["ffmpegCommit"], "86444dd36834875f274f57705762c5448379d644")
        self.assertEqual(patch_series("mpv", native), [])
        for key in ("container", "rustToolchain", "target", "cpu", "windowsMetadataCommit"):
            self.assertEqual(native[key], accepted[key], key)

    def test_candidate_retains_source_pins_and_only_refreshes_approved_container(self):
        from apply_source_patches import load_config, patch_series
        baseline = json.loads((self.root / "build/libmpv-source-build.json").read_text())
        candidate = load_config(self.root / "build/libmpv-source-build.d3d11.json")
        for key, value in baseline.items():
            if key != "container":
                self.assertEqual(candidate[key], value, key)
        self.assertEqual(baseline["container"],
            "ghcr.io/shinchiro/archlinux@sha256:2b81f07c567b051455b9539770a71b53dd3add5f9ef52eca95ac01a2272e9fdf")
        self.assertEqual(candidate["container"],
            "ghcr.io/shinchiro/archlinux@sha256:4a65616f389fa2a76955876a3e380284d3057cc04bfcac986008f20a710a0b76")
        self.assertEqual(candidate["sourceVersionSuffix"], "-lampaua-d3d11")
        patches = patch_series("mpv", candidate)
        self.assertEqual(len(patches), 1)
        self.assertEqual(patches[0]["upstreamCommit"], "4255130de410e0cbdab694b951085409d466b704")
        self.assertEqual(patches[0]["sha256"], "24c70218104aeae57ecf733b3ac6787314aaa8e7e1bf332f7bb4bec185ac4217")

    def test_candidate_recipe_command_is_explicit_and_baseline_is_unchanged(self):
        from prepare_build import source_patch_command
        baseline = source_patch_command("mpv", {})
        self.assertIn("freeze_version.py", baseline)
        self.assertNotIn("apply_source_patches", baseline)
        candidate = source_patch_command("mpv", {"sourcePatches": {"mpv": [{}]}})
        self.assertIn("apply_source_patches.py", candidate)
        self.assertIn('--config "$ENV{LAMPAUA_MPV_CONFIG}"', candidate)
        self.assertIn('--receipts "$ENV{LAMPAUA_MPV_SOURCES}"', candidate)
        self.assertEqual(source_patch_command("ffmpeg", {"sourcePatches": {"mpv": [{}]}}),
                         source_patch_command("ffmpeg", {}))

    def test_unknown_variant_fails_before_creating_or_downloading_inputs(self):
        bash = "C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else shutil.which("bash")
        with tempfile.TemporaryDirectory(prefix="lampaua-variant-test-") as directory:
            result = subprocess.run([bash, str(self.root / "scripts/mpv/build-libmpv.sh")], cwd=directory,
                env={**os.environ, "LAMPAUA_MPV_VARIANT": "unexpected"},
                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Unsupported build variant", result.stdout)
            self.assertFalse((Path(directory) / ".cache").exists())

    def test_variant_paths_cannot_select_production_output(self):
        from package_build import variant_paths
        self.assertEqual(variant_paths(self.root, "baseline"),
            (self.root / "build/libmpv-source-build.json", self.root / "dist/libmpv-own"))
        self.assertEqual(variant_paths(self.root, "d3d11"),
            (self.root / "build/libmpv-source-build.d3d11.json", self.root / "dist/libmpv-own-d3d11"))
        self.assertEqual(variant_paths(self.root, "d3d11-next"),
            (self.root / "build/libmpv-source-build.d3d11-next.json", self.root / "dist/libmpv-own-d3d11-next"))
        with self.assertRaises(ValueError):
            variant_paths(self.root, "../baseline")

    def test_candidate_recipe_requires_backend_and_packages_new_header(self):
        from prepare_build import enable_d3d11_recipe
        with tempfile.TemporaryDirectory(prefix="lampaua-recipe-test-") as directory:
            recipe = Path(directory) / "mpv.cmake"
            recipe.write_text('ExternalProject_Add(mpv\n        -Dlibmpv=true\n'
                '    -Dspirv-cross=enabled\n)\n'
                '    COMMAND ${CMAKE_COMMAND} -E copy <SOURCE_DIR>/include/mpv/render_gl.h    '
                '${CMAKE_CURRENT_BINARY_DIR}/mpv-dev/include/mpv/render_gl.h\n')
            enable_d3d11_recipe(recipe)
            actual = recipe.read_text()
            self.assertIn('-Dd3d11=enabled', actual)
            self.assertIn('-Dshaderc=enabled', actual)
            self.assertIn('<SOURCE_DIR>/include/mpv/render_d3d11.h', actual)
            self.assertIn('${CMAKE_CURRENT_BINARY_DIR}/mpv-dev/include/mpv/render_d3d11.h', actual)


if __name__ == "__main__":
    unittest.main()
