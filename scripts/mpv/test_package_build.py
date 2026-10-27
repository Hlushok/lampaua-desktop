"""Packaging regressions using real Git ownership checks, without recompiling."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import package_build


class PackageBuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lampaua-package-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "app"
        self.root.mkdir()
        subprocess.run(["git", "init", "--quiet", str(self.root)], check=True)
        subprocess.run(["git", "-C", str(self.root), "-c", "user.name=Build Test",
                        "-c", "user.email=build@test.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"],
                       check=True)
        self.revision = subprocess.check_output(["git", "-C", str(self.root), "rev-parse", "HEAD"], text=True).strip()
        self.work = self.root / ".cache/work"
        self.sources = self.work / "sources"
        self.sources.mkdir(parents=True)
        for name in ("mpv", "ffmpeg", "gcc", "gcc-binutils", "mingw-w64", "subrandr-crates",
                     "rust-standard-library", "windows-metadata"):
            archive = self.sources / f"{name}.tar.gz"
            archive.write_bytes(b"source fixture")
            (self.sources / f"{name}.json").write_text(json.dumps({"name": name, "revision": self.revision,
                "archive": archive.name, "sha256": package_build.digest(archive)}))
        (self.sources / "projects").mkdir()
        sdk = self.work / "build/mpv-dev-x86_64-test-git-fixture"
        sdk.mkdir(parents=True)
        (sdk / "libmpv-2.dll").write_bytes(b"DLL fixture")
        (self.work / "build/CMakeCache.txt").write_text("GCC_ARCH:STRING=x86-64\n")
        (self.work / "build/cmake").mkdir()
        (self.work / "recipes").mkdir()
        for folder in ("build", "docs", "scripts/mpv", "dist/libmpv-own"):
            (self.root / folder).mkdir(parents=True)
        (self.root / "build/libmpv-source-build.json").write_text(json.dumps({
            "mpvCommit": self.revision, "ffmpegCommit": self.revision, "sourceLock": "lock.json"}))
        (self.root / "build/lock.json").write_text("{}")
        (self.root / "docs/libmpv-own-build.md").write_text("Build fixture\n")
        self.git_config = Path(self.temporary.name) / "empty-git-config"
        self.git_config.write_text("")

    def package_fixture(self, cwd, different_owner=False, variant="baseline", effective=None):
        original_output, original_run = subprocess.check_output, subprocess.run

        def output(command, **kwargs):
            if str(command[0]).endswith("cross-objdump"):
                return "PE fixture\n"
            return original_output(command, **kwargs)

        def run(command, **kwargs):
            if command[0] == "7z":
                Path(command[-2]).write_bytes(b"SDK fixture")
                return subprocess.CompletedProcess(command, 0)
            return original_run(command, **kwargs)

        environment = {"GIT_CONFIG_GLOBAL": str(self.git_config), "GIT_CONFIG_NOSYSTEM": "1",
                       "GIT_TEST_ASSUME_DIFFERENT_OWNER": "1" if different_owner else "0"}
        previous = Path.cwd()
        try:
            os.chdir(cwd)
            with patch.dict(os.environ, environment), patch.object(package_build, "validate_sources", return_value=[]), \
                    patch("preflight_sources.load_lock", return_value={}), patch("preflight_sources.verify"), \
                    patch("preflight_sources.verify_extras"), patch.object(subprocess, "check_output", side_effect=output), \
                    patch.object(subprocess, "run", side_effect=run):
                if different_owner:
                    unsafe = original_run(["git", "-C", str(self.root), "rev-parse", "HEAD"],
                                          text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    self.assertNotEqual(unsafe.returncode, 0)
                    self.assertIn("dubious ownership", unsafe.stderr)
                with patch.object(package_build, "verify_patches", return_value=effective) as verify_effective:
                    package_build.package(self.work, self.root, variant)
                    if variant != "baseline":
                        verify_effective.assert_called_once()
                    else:
                        verify_effective.assert_not_called()
                if different_owner:
                    # Trust is command-local, not a global relaxation for other Git calls.
                    unsafe = original_run(["git", "-C", str(self.root), "rev-parse", "HEAD"],
                                          text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    self.assertNotEqual(unsafe.returncode, 0)
        finally:
            os.chdir(previous)
        _, destination = package_build.variant_paths(self.root, variant)
        manifest = json.loads((destination / "manifest.json").read_text())
        self.assertEqual(manifest["repositoryCommit"], self.revision)
        self.assertTrue((destination / "lampaua-libmpv-x64-sources.tar.gz").is_file())
        if variant != "baseline":
            candidate = json.loads((destination / "candidate-sdk.json").read_text())
            self.assertEqual(candidate["clientApiVersion"], (2 << 16) | 6)
            self.assertEqual(candidate["sdkSha256"], package_build.digest(destination / candidate["sdkFile"]))
            self.assertEqual(candidate["sourceSha256"], package_build.digest(destination / candidate["sourceFile"]))
            for key in ("dllSha256", "baseRevision", "patches", "effectiveTreeSha256", "repositoryCommit"):
                self.assertEqual(candidate[key], manifest[key])
        return manifest

    def candidate_fixture(self, api_minor=6):
        baseline = self.root / "build/libmpv-source-build.json"
        before = baseline.read_bytes()
        patch_file = self.root / "build/patches/mpv/test.patch"
        patch_file.parent.mkdir(parents=True)
        patch_file.write_bytes(b"exact patch fixture")
        config = json.loads(before)
        config.update(sourceVersionSuffix="-lampaua-d3d11", sourcePatches={"mpv": [{
            "file": "patches/mpv/test.patch", "sha256": package_build.digest(patch_file),
            "baseRevision": self.revision, "upstreamCommit": "b" * 40}]})
        (self.root / "build/libmpv-source-build.d3d11.json").write_text(json.dumps(config))
        effective_archive = self.sources / "mpv-effective.tar.gz"
        effective_archive.write_bytes(b"effective source fixture")
        effective = {"name": "mpv-effective", "baseRevision": self.revision,
                     "effectiveTreeSha256": "e" * 64, "patches": config["sourcePatches"]["mpv"],
                     "archive": effective_archive.name, "sha256": package_build.digest(effective_archive)}
        (self.sources / "mpv-effective.json").write_text(json.dumps(effective))
        sdk = self.work / "build/mpv-dev-x86_64-test-git-fixture"
        (sdk / "include/mpv").mkdir(parents=True)
        (sdk / "include/mpv/render_d3d11.h").write_bytes(b"header fixture")
        (sdk / "include/mpv/client.h").write_text(
            f"#define MPV_CLIENT_API_VERSION MPV_MAKE_VERSION(2, {api_minor})\n")
        (self.root / "dist/libmpv-own-d3d11").mkdir()
        return before, effective

    def test_candidate_packages_both_source_trees_patches_and_public_configuration(self):
        before, effective = self.candidate_fixture()
        manifest = self.package_fixture(self.root, variant="d3d11", effective=effective)
        self.assertEqual(manifest["effectiveTreeSha256"], "e" * 64)
        self.assertNotIn("_patchRoot", manifest["configuration"])
        self.assertEqual((self.root / "build/libmpv-source-build.json").read_bytes(), before)
        self.assertFalse(list((self.root / "dist/libmpv-own").iterdir()))
        import tarfile
        with tarfile.open(self.root / "dist/libmpv-own-d3d11/lampaua-libmpv-x64-sources.tar.gz") as bundle:
            for name in ("mpv.tar.gz", "mpv-effective.tar.gz", "mpv.json", "mpv-effective.json",
                         "patches/mpv/test.patch", "libmpv-source-build.d3d11.json"):
                self.assertIn("lampaua-libmpv-sources/" + name, bundle.getnames())

    def test_candidate_rejects_old_client_api_even_if_new_header_exists(self):
        _, effective = self.candidate_fixture(api_minor=5)
        with self.assertRaisesRegex(ValueError, "API 2.6"):
            self.package_fixture(self.root, variant="d3d11", effective=effective)
        self.assertFalse(list((self.root / "dist/libmpv-own-d3d11").iterdir()))

    def test_native_candidate_keeps_empty_series_and_separate_outputs(self):
        self.candidate_fixture()
        old_config = self.root / "build/libmpv-source-build.d3d11.json"
        before = old_config.read_bytes()
        config = json.loads(before)
        config.update(nativeD3d11=True, sourcePatches={"mpv": []})
        (self.root / "build/libmpv-source-build.d3d11-next.json").write_text(json.dumps(config))
        (self.root / "dist/libmpv-own-d3d11-next").mkdir()
        effective = json.loads((self.sources / "mpv-effective.json").read_text())
        effective.update(nativeD3d11=True, patches=[])
        (self.sources / "mpv-effective.json").write_text(json.dumps(effective))
        manifest = self.package_fixture(self.root, variant="d3d11-next", effective=effective)
        self.assertTrue(manifest["nativeD3d11"])
        self.assertEqual(manifest["patches"], [])
        destination = self.root / "dist/libmpv-own-d3d11-next"
        candidate = json.loads((destination / "candidate-sdk.json").read_text())
        self.assertTrue(candidate["nativeD3d11"])
        self.assertEqual(old_config.read_bytes(), before)
        self.assertFalse(list((self.root / "dist/libmpv-own-d3d11").iterdir()))

    def test_candidate_rejects_missing_effective_receipt_before_sdk_packaging(self):
        self.candidate_fixture()
        (self.sources / "mpv-effective.json").unlink()
        with patch.object(package_build, "validate_sources", return_value=[]), \
                self.assertRaisesRegex(ValueError, "Missing effective"):
            package_build.package(self.work, self.root, "d3d11")

    def test_candidate_rejects_missing_or_changed_base_source_archive(self):
        self.candidate_fixture()
        archive = self.sources / "mpv.tar.gz"
        for data in (b"changed", None):
            with self.subTest(data=data):
                if data is None:
                    archive.unlink()
                else:
                    archive.write_bytes(data)
                with patch.object(package_build, "validate_sources", return_value=[]), \
                        self.assertRaisesRegex(ValueError, "Base source archive checksum"):
                    package_build.package(self.work, self.root, "d3d11")

    def test_packaging_handles_the_container_workspace_owner(self):
        self.package_fixture(self.root, different_owner=True)

    def test_packaging_reads_the_explicit_root_not_the_callers_directory(self):
        self.package_fixture(Path(self.temporary.name))

    def test_repository_check_fails_before_downloads_or_compilation(self):
        root = Path(self.temporary.name) / "not-a-checkout"
        scripts = Path(__file__).resolve().parent
        shutil.copytree(scripts, root / "scripts/mpv", ignore=shutil.ignore_patterns("__pycache__"))
        binaries = root / "bin"
        binaries.mkdir()
        python = binaries / "python3"
        python.write_text(f'#!/usr/bin/env bash\nexec "{Path(sys.executable).as_posix()}" "$@"\n')
        cmake = binaries / "cmake"
        cmake.write_text('#!/usr/bin/env bash\nprintf invoked > compiler-invoked\nexit 99\n')
        python.chmod(0o755)
        cmake.chmod(0o755)
        bash = "C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else shutil.which("bash")
        result = subprocess.run([bash, "scripts/mpv/build-libmpv.sh"], cwd=root,
            env={**os.environ, "PATH": str(binaries) + os.pathsep + os.environ["PATH"]},
            text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not a git repository", result.stdout)
        self.assertFalse((root / "compiler-invoked").exists())
        self.assertFalse((root / ".cache/libmpv-own/recipes").exists())


if __name__ == "__main__":
    unittest.main()
