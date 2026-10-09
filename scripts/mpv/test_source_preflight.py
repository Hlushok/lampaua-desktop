"""Offline checks for pinned inputs and source-only build ordering."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from capture_source import digest
from prepare_build import pin_recipe
from preflight_sources import plan, verify, verify_extras


class SourcePreflightTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lampaua-preflight-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.revision = "a" * 40
        self.pin = {"repository": "https://example.invalid/source.git", "revision": self.revision}

    def test_recipe_pins_tag_and_existing_reset(self):
        path = self.root / "source.cmake"
        path.write_text('ExternalProject_Add(example\n  GIT_REPOSITORY https://example.invalid/source.git\n'
                        '  GIT_TAG main\n  GIT_RESET old # donor pin\n)\n')
        pin_recipe(path, self.pin)
        updated = path.read_text()
        self.assertIn(f"GIT_TAG {self.revision}\n", updated)
        self.assertIn(f"GIT_RESET {self.revision}\n", updated)
        pin_recipe(path, self.pin)
        self.assertEqual(path.read_text(), updated)

    def test_recipe_identity_and_full_revision_are_required(self):
        path = self.root / "source.cmake"
        original = 'ExternalProject_Add(example\n  GIT_REPOSITORY https://other.invalid/source.git\n)\n'
        path.write_text(original)
        for pin in (self.pin, {**self.pin, "revision": "main"}):
            with self.assertRaises(ValueError):
                pin_recipe(path, pin)
            self.assertEqual(path.read_text(), original)

    def test_explicit_origin_without_reset_gets_a_pinned_reset(self):
        path = self.root / "source.cmake"
        path.write_text('ExternalProject_Add(example\n  GIT_REPOSITORY https://example.invalid/source.git\n'
                        '  GIT_REMOTE_NAME origin\n)\n')
        pin_recipe(path, self.pin)
        self.assertIn(f"GIT_RESET {self.revision}\n", path.read_text())

    def fixture(self):
        projects = {
            "gcc": {"hasSource": False, "dependencies": []},
            "mpv": {"hasSource": False, "dependencies": ["curl-install"]},
            "curl": {"hasSource": True, "dependencies": [], "repository": self.pin["repository"],
                     "revision": self.revision, "url": "", "urlHash": ""},
        }
        return projects, {"curl": self.pin}

    def test_plan_rejects_missing_or_floating_pins(self):
        projects, pins = self.fixture()
        self.assertEqual(plan(projects, pins), ["curl"])
        with self.assertRaisesRegex(ValueError, "Unpinned"):
            plan(projects, {})
        projects["curl"]["revision"] = "master"
        with self.assertRaisesRegex(ValueError, "mismatch"):
            plan(projects, pins)

    def test_step_alias_cycle_is_visited_only_once(self):
        projects, pins = self.fixture()
        projects["gcc"]["dependencies"] = ["gcc-install"]
        self.assertEqual(plan(projects, pins), ["curl"])

    def test_url_inputs_need_matching_url_and_hash(self):
        projects, pins = self.fixture()
        item = {"url": "https://example.invalid/input.tar.gz", "urlHash": "SHA256=" + "b" * 64}
        projects["curl"].update(repository="", revision="", **item)
        pins["curl"] = item
        self.assertEqual(plan(projects, pins), ["curl"])
        pins["curl"] = {**item, "urlHash": ""}
        with self.assertRaises(ValueError):
            plan(projects, pins)

    def test_receipts_must_match_pin_and_archive(self):
        projects, pins = self.fixture()
        archive = self.root / "curl.tar.gz"
        archive.write_bytes(b"fixture")
        record = {"name": "curl", **self.pin, "archive": archive.name, "sha256": digest(archive)}
        receipt = self.root / "curl.json"
        receipt.write_text(json.dumps(record))
        verify(self.root, projects, pins)
        receipt.write_text(json.dumps({**record, "revision": "c" * 40}))
        with self.assertRaisesRegex(ValueError, "mismatch"):
            verify(self.root, projects, pins)
        receipt.write_text(json.dumps(record))
        archive.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "archive"):
            verify(self.root, projects, pins)

    def test_rust_metadata_and_crates_are_required_before_compilation(self):
        config = {"rustToolchain": "nightly-2026-10-08", "windowsMetadataCommit": self.revision}
        projects = {"subrandr": {"source": str(self.root)}}
        (self.root / "Cargo.lock").write_text("locked crates")
        for name, url in (("rust-standard-library", "rustup:nightly-2026-10-08:rust-src"),
                          ("windows-metadata", f"https://github.com/microsoft/windows-rs/tree/{self.revision}"),
                          ("subrandr-crates", None)):
            archive = self.root / f"{name}.tar.gz"
            archive.write_bytes(name.encode())
            record = {"name": name, "archive": archive.name, "sha256": digest(archive), "url": url,
                      "cargoLockSha256": digest(self.root / "Cargo.lock")}
            filename = "subrandr-crates.tar.json" if name == "subrandr-crates" else f"{name}.json"
            (self.root / filename).write_text(json.dumps(record))
        verify_extras(self.root, projects, config)
        (self.root / "Cargo.lock").write_text("changed")
        with self.assertRaisesRegex(ValueError, "Cargo lock mismatch"):
            verify_extras(self.root, projects, config)
        (self.root / "windows-metadata.json").unlink()
        with self.assertRaisesRegex(ValueError, "Uncaptured"):
            verify_extras(self.root, projects, config)

    def test_source_step_does_not_run_dependent_compiler(self):
        cmake = os.environ.get("LAMPAUA_CMAKE") or shutil.which("cmake")
        self.assertIsNotNone(cmake)
        scripts = Path(__file__).resolve().parent
        module = self.root / "capture-source.cmake"
        module.write_text((scripts / "capture-source.cmake").read_text().replace(
            "COMMAND python3", f'COMMAND "{Path(sys.executable).as_posix()}"'))
        fixture = self.root / "fixture"
        fixture.mkdir()
        (fixture / "source.c").write_text("int example;\n")
        source = (self.root / "downloaded").as_posix()
        (self.root / "CMakeLists.txt").write_text(
            'cmake_minimum_required(VERSION 3.20)\nproject(SourceOnly NONE)\n'
            'cmake_policy(SET CMP0114 NEW)\ninclude(ExternalProject)\n'
            f'include("{module.as_posix()}")\n'
            'ExternalProject_Add(compiler DOWNLOAD_COMMAND "" UPDATE_COMMAND ""\n'
            '  CONFIGURE_COMMAND ${CMAKE_COMMAND} -E false\n'
            '  BUILD_COMMAND ${CMAKE_COMMAND} -E false INSTALL_COMMAND "")\n'
            'ExternalProject_Add(example DEPENDS compiler\n'
            '  URL https://example.invalid/input.tar.gz URL_HASH SHA256=' + "b" * 64 + '\n'
            f'  SOURCE_DIR "{source}"\n'
            f'  DOWNLOAD_COMMAND ${{CMAKE_COMMAND}} -E copy_directory "{fixture.as_posix()}" "{source}"\n'
            '  UPDATE_COMMAND "" CONFIGURE_COMMAND ${CMAKE_COMMAND} -E false\n'
            '  BUILD_COMMAND ${CMAKE_COMMAND} -E false INSTALL_COMMAND "")\n'
            'lampaua_capture_source(example)\n')
        env = {**os.environ, "LAMPAUA_MPV_SCRIPTS": scripts.as_posix(),
               "LAMPAUA_MPV_SOURCES": (self.root / "archives").as_posix()}
        args = [cmake, "-S", str(self.root), "-B", str(self.root / "build")]
        if os.name == "nt":
            nmake = Path("C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.51.36231/bin/Hostx64/x64/nmake.exe")
            self.assertTrue(nmake.is_file())
            args += ["-G", "NMake Makefiles", f"-DCMAKE_MAKE_PROGRAM={nmake.as_posix()}"]
        configured = subprocess.run(args, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertEqual(configured.returncode, 0, configured.stdout)
        built = subprocess.run([cmake, "--build", str(self.root / "build"), "--target", "example-lampaua-source"],
                               env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertEqual(built.returncode, 0, built.stdout)
        self.assertTrue((self.root / "archives/example.json").is_file())
        self.assertFalse(list((self.root / "build").rglob("compiler-configure")))

    def test_compile_phase_rejects_conflicting_core_pin_before_cmake(self):
        scripts = Path(__file__).resolve().parent
        shutil.copytree(scripts, self.root / "scripts/mpv", ignore=shutil.ignore_patterns("__pycache__"))
        build = self.root / "build"
        build.mkdir()
        config = {"recipesRepository": "https://example.invalid/recipes.git", "recipesCommit": self.revision,
                  "rustToolchain": "nightly-2026-10-08", "windowsMetadataCommit": self.revision,
                  "sourceLock": "lock.json", "mpvCommit": "b" * 40, "ffmpegCommit": self.revision}
        (build / "libmpv-source-build.json").write_text(json.dumps(config))
        names = ("mpv", "ffmpeg", "curl", "openssl", "subrandr")
        pins = {name: {"repository": f"https://example.invalid/{name}.git", "revision": self.revision}
                for name in names}
        (build / "lock.json").write_text(json.dumps({"version": 1, "components": pins}))
        projects = self.root / ".cache/libmpv-own/sources/projects"
        projects.mkdir(parents=True)
        sources = projects.parent
        for name in ("gcc", *names):
            source = self.root / "inputs" / name
            source.mkdir(parents=True)
            item = {"hasSource": name != "gcc", "dependencies": [], "source": str(source), **pins.get(name, {})}
            (projects / f"{name}.json").write_text(json.dumps(item))
            if name != "gcc":
                archive = sources / f"{name}.tar.gz"
                archive.write_bytes(name.encode())
                record = {"name": name, **pins[name], "archive": archive.name, "sha256": digest(archive)}
                (sources / f"{name}.json").write_text(json.dumps(record))
        curl = self.root / "inputs/curl"
        (curl / "lib/vtls").mkdir(parents=True)
        (curl / "CMakeLists.txt").write_text('find_package(OpenSSL REQUIRED)\n')
        (curl / "lib/vtls/openssl.c").write_text(
            '#if OPENSSL_VERSION_NUMBER < 0x40100000L\n'
            'static size_t ASN1_STRING_get_length(const ASN1_STRING *str) {}\n#endif\n')
        header = self.root / "inputs/openssl/include/openssl/asn1.h.in"
        header.parent.mkdir(parents=True)
        header.write_text("int ASN1_STRING_length(const ASN1_STRING *str);\n")
        cargo = self.root / "inputs/subrandr/Cargo.lock"
        cargo.write_text("locked crates\n")
        for name, url in (("rust-standard-library", "rustup:nightly-2026-10-08:rust-src"),
                          ("windows-metadata", f"https://github.com/microsoft/windows-rs/tree/{self.revision}"),
                          ("subrandr-crates", None)):
            archive = sources / f"{name}.tar.gz"
            archive.write_bytes(name.encode())
            record = {"name": name, "archive": archive.name, "sha256": digest(archive), "url": url,
                      "cargoLockSha256": digest(cargo)}
            filename = "subrandr-crates.tar.json" if name == "subrandr-crates" else f"{name}.json"
            (sources / filename).write_text(json.dumps(record))
        binaries = self.root / "bin"
        binaries.mkdir()
        python = binaries / "python3"
        python.write_text(f'#!/usr/bin/env bash\nexec "{Path(sys.executable).as_posix()}" "$@"\n')
        cmake = binaries / "cmake"
        cmake.write_text('#!/usr/bin/env bash\nprintf invoked > compiler-invoked\nexit 99\n')
        python.chmod(0o755)
        cmake.chmod(0o755)
        bash = "C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else shutil.which("bash")
        env = {**os.environ, "LAMPAUA_MPV_PHASE": "compile",
               "PATH": str(binaries) + os.pathsep + os.environ["PATH"]}
        result = subprocess.run([bash, "scripts/mpv/build-libmpv.sh"], cwd=self.root, env=env,
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Conflicting mpv pin", result.stdout)
        self.assertFalse((self.root / "compiler-invoked").exists())
        # Otherwise-valid sources reach the fake compiler when the core pins
        # agree, so the rejection above is not caused by an incomplete fixture.
        config["mpvCommit"] = self.revision
        (build / "libmpv-source-build.json").write_text(json.dumps(config))
        allowed = subprocess.run([bash, "scripts/mpv/build-libmpv.sh"], cwd=self.root, env=env,
                                 text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertEqual(allowed.returncode, 99, allowed.stdout)
        self.assertIn("Verified 5 pinned source inputs", allowed.stdout)
        self.assertTrue((self.root / "compiler-invoked").is_file())


if __name__ == "__main__":
    unittest.main()
