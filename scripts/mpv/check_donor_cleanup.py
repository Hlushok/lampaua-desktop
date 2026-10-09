"""Exercise the donor's detached-HEAD cleanup in disposable local repositories."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile


def run(args, cwd=None, env=None):
    return subprocess.run(args, cwd=cwd, env=env, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT)


def checked(args, **kwargs):
    result = run(args, **kwargs)
    if result.returncode:
        raise RuntimeError(result.stdout)
    return result.stdout.strip()


def check(recipes, module, cmake):
    if checked(["git", "hash-object", str(module)]) != "3f43542307ff82dffe0cfd9233b3ecfb415b7058":
        raise ValueError("Expected the official ExternalProject v3.31.6 module")
    with tempfile.TemporaryDirectory(prefix="lampaua-donor-cleanup-") as directory:
        root = Path(directory).resolve()
        origin = root / "origin"
        origin.mkdir()
        (origin / "source.c").write_text("int fixture;\n", encoding="utf-8")
        checked(["git", "init", str(origin)])
        checked(["git", "-C", str(origin), "add", "."])
        checked(["git", "-C", str(origin), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "-m", "fixture"])
        revision = checked(["git", "-C", str(origin), "rev-parse", "HEAD"])
        modules = root / "Modules"
        modules.mkdir()
        shutil.copy(module, modules / "ExternalProject.cmake")
        with zipfile.ZipFile(recipes / "cmake/CMake-v3.31.6-Modules-ExternalProject.zip") as archive:
            for name in archive.namelist():
                if not (modules / "ExternalProject" / name).resolve().is_relative_to(root):
                    raise ValueError("Unsafe module archive path")
            archive.extractall(modules / "ExternalProject")
        patch = shutil.which("patch") or "C:/Program Files/Git/usr/bin/patch.exe"
        checked([patch, "-p1", "-i", str(recipes / "packages/cmake-0001-ExternalProject-changes.patch")], cwd=root)
        bash = "C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else shutil.which("bash")
        custom = root / "custom_steps.cmake"
        helper = (recipes / "cmake/custom_steps.cmake").read_text(encoding="utf-8")
        # Windows needs an explicit Bash interpreter for generated .sh files;
        # the cleanup body and reset decision remain exactly the donor's code.
        helper = helper.replace("COMMAND ${stamp_dir}/reset_head.sh", f'COMMAND "{Path(bash).as_posix()}" ${{stamp_dir}}/reset_head.sh')
        custom.write_text(helper, encoding="utf-8")
        executor = root / "exec.sh"
        executor.write_text('#!/usr/bin/env bash\neval "$*"\n', encoding="utf-8")
        env = dict(os.environ)
        if os.name == "nt":
            env["PATH"] = "C:/Program Files/Git/bin;C:/Program Files/Git/usr/bin;" + env["PATH"]
        for pinned in (False, True):
            case = root / ("pinned" if pinned else "unfixed")
            case.mkdir()
            source = case / "source"
            binary = case / "build"
            if not all(p.resolve().is_relative_to(root) for p in (case, source, binary)):
                raise ValueError("Cleanup fixture escaped its temporary root")
            reset = f"  GIT_RESET {revision}\n" if pinned else ""
            (case / "CMakeLists.txt").write_text(
                'cmake_minimum_required(VERSION 3.20)\nproject(DonorCleanup NONE)\n'
                'cmake_policy(SET CMP0114 NEW)\n'
                f'include("{modules.as_posix()}/ExternalProject.cmake")\n'
                f'include("{custom.as_posix()}")\n'
                f'set(EXEC "{Path(bash).as_posix()}" "{executor.as_posix()}")\n'
                'ExternalProject_Add(example\n'
                f'  GIT_REPOSITORY "{origin.as_uri()}" GIT_TAG {revision}\n'
                f'{reset}  GIT_REMOTE_NAME origin SOURCE_DIR "{source.as_posix()}"\n'
                '  UPDATE_COMMAND "" CONFIGURE_COMMAND "" BUILD_COMMAND "" INSTALL_COMMAND "")\n'
                'force_rebuild_git(example)\ncleanup(example install)\n', encoding="utf-8")
            args = [cmake, "-S", str(case), "-B", str(binary)]
            if os.name == "nt":
                nmake = "C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.51.36231/bin/Hostx64/x64/nmake.exe"
                args += ["-G", "NMake Makefiles", f"-DCMAKE_MAKE_PROGRAM={nmake}"]
            checked(args, env=env)
            built = run([cmake, "--build", str(binary), "--target", "example"], env=env)
            logs = built.stdout + "\n".join(p.read_text(encoding="utf-8") for p in binary.rglob("*-err.log"))
            if pinned:
                if built.returncode:
                    raise RuntimeError(logs)
                if checked(["git", "-C", str(source), "rev-parse", "HEAD"]) != revision:
                    raise ValueError("Cleanup changed the pinned revision")
                print("Pinned detached-HEAD post-install cleanup passed")
            else:
                if not built.returncode or "HEAD does not point to a branch" not in logs:
                    raise RuntimeError("Expected detached-HEAD cleanup failure:\n" + logs)
                print("Original @{u} cleanup failure reproduced before compilation")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recipes", type=Path, required=True)
    parser.add_argument("--externalproject", type=Path, required=True)
    parser.add_argument("--cmake", required=True)
    args = parser.parse_args()
    check(args.recipes.resolve(), args.externalproject.resolve(), args.cmake)
