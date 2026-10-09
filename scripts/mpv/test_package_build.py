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

    def package_fixture(self, cwd, different_owner=False):
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
                package_build.package(self.work, self.root)
                if different_owner:
                    # Trust is command-local, not a global relaxation for other Git calls.
                    unsafe = original_run(["git", "-C", str(self.root), "rev-parse", "HEAD"],
                                          text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    self.assertNotEqual(unsafe.returncode, 0)
        finally:
            os.chdir(previous)
        manifest = json.loads((self.root / "dist/libmpv-own/manifest.json").read_text())
        self.assertEqual(manifest["repositoryCommit"], self.revision)
        self.assertTrue((self.root / "dist/libmpv-own/lampaua-libmpv-x64-sources.tar.gz").is_file())

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
