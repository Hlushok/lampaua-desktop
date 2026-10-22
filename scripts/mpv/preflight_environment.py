"""Check candidate container tools before downloading or compiling MPV inputs."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile


def run_command(args, cwd=None):
    result = subprocess.run(args, cwd=cwd, check=True, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
    return result.stdout


def version(value):
    match = re.search(r"\b(\d+)\.(\d+)(?:\.(\d+))?", value)
    if not match:
        raise ValueError(f"Unrecognized tool version: {value[:200]}")
    return tuple(int(part or 0) for part in match.groups())


def check_environment(runner=run_command, locate=shutil.which):
    report = {"schemaVersion": 1, "passed": False, "smoke": False,
              "system": platform.system(), "machine": platform.machine(),
              "python": platform.python_version(), "tools": {}}
    try:
        if sys.version_info[:2] < (3, 12):
            raise ValueError("Python >=3.12 is required for safe source archive extraction")
        if report["system"] != "Linux" or report["machine"].lower() not in ("x86_64", "amd64"):
            raise ValueError("The candidate build requires a Linux amd64 container")
        tools = {}
        for name in ("cmake", "ninja", "meson", "gcc", "g++", "make", "git", "curl",
                     "7z", "pkg-config", "patch", "tar", "bash"):
            path = locate(name)
            if not path:
                raise ValueError(f"Missing required build tool: {name}")
            tools[name] = path
            if name == "cmake":
                capabilities = json.loads(runner([path, "-E", "capabilities"]))
                text = capabilities["version"]["string"]
                if version(text) < (3, 31, 0):
                    raise ValueError("CMake >=3.31 is required")
                if not any(item["name"] == "Ninja" for item in capabilities["generators"]):
                    raise ValueError("CMake lacks the Ninja generator")
            else:
                text = runner([path, "i" if name == "7z" else "--version"]).strip()
            report["tools"][name] = {"path": path, "version": text[:2000]}
            if name == "meson" and version(text) < (1, 3, 0):
                raise ValueError("Meson >=1.3.0 is required by the pinned MPV source")
            if name == "ninja" and version(text) < (1, 10, 0):
                raise ValueError("Ninja >=1.10 is required")
        with tempfile.TemporaryDirectory(prefix="lampaua-mpv-env-") as temporary:
            source = Path(temporary)
            (source / "CMakeLists.txt").write_text(
                'cmake_minimum_required(VERSION 3.31)\n'
                'project(lampaua_environment LANGUAGES C CXX)\n'
                'set(CMAKE_CXX_STANDARD 20)\nset(CMAKE_CXX_STANDARD_REQUIRED ON)\n'
                'find_package(Threads REQUIRED)\n'
                'add_executable(environment-smoke smoke.cpp)\n'
                'target_link_libraries(environment-smoke PRIVATE Threads::Threads)\n', encoding="utf-8")
            (source / "smoke.cpp").write_text(
                '#include <filesystem>\n#include <thread>\n#include <iostream>\n'
                'static_assert(__cplusplus >= 202002L);\n'
                'int main() { int value=0; { std::jthread worker([&] { value=1; }); }\n'
                'if (value != 1 || std::filesystem::temp_directory_path().empty()) return 1;\n'
                'std::cout << "environment-smoke-ok\\n"; }\n', encoding="utf-8")
            build = source / "build"
            runner([tools["cmake"], "-S", str(source), "-B", str(build), "-G", "Ninja",
                    f"-DCMAKE_MAKE_PROGRAM={tools['ninja']}",
                    f"-DCMAKE_C_COMPILER={tools['gcc']}", f"-DCMAKE_CXX_COMPILER={tools['g++']}"])
            runner([tools["cmake"], "--build", str(build), "--parallel", "1"])
            if runner([str(build / "environment-smoke")]).strip() != "environment-smoke-ok":
                raise ValueError("Host C++20 executable returned unexpected output")
        report.update(passed=True, smoke=True)
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        if isinstance(error, subprocess.CalledProcessError) and error.output:
            report["error"] += "\n" + str(error.output)[-4000:]
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    config = json.loads(args.config.read_text(encoding="utf-8"))
    report = check_environment()
    report.update(container=config["container"], checkedAt=datetime.now(timezone.utc).isoformat())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
