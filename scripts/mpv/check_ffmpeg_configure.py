"""Ask pinned FFmpeg to parse the recipe options before any compiler runs."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def check_options(project, bash=None):
    source = Path(project["source"]).resolve()
    command = project.get("configureCommand")
    if not isinstance(command, list) or not all(isinstance(arg, str) for arg in command):
        raise ValueError("Missing captured FFmpeg configure arguments")
    scripts = [index for index, arg in enumerate(command)
               if arg in ("<SOURCE_DIR>/configure", (source / "configure").as_posix(), str(source / "configure"))]
    if len(scripts) != 1:
        raise ValueError("Expected exactly one FFmpeg configure script")
    options = command[scripts[0] + 1:]
    if not options or any(not option.startswith("--") or option == "--help"
                          or option.startswith("--list") for option in options):
        raise ValueError("Unexpected FFmpeg configure argument or early-exit option")
    bash = bash or ("C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else shutil.which("bash"))
    if not bash or not (source / "configure").is_file():
        raise ValueError("Missing Bash or pinned FFmpeg configure script")
    # --help must be last: configure validates preceding options, then exits
    # before dependency/compiler probes. Keep any temporary outputs off source.
    with tempfile.TemporaryDirectory(prefix="lampaua-ffmpeg-options-") as directory:
        result = subprocess.run([bash, (source / "configure").as_posix(), *options, "--help"], cwd=directory,
                                stdin=subprocess.DEVNULL, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=60)
    if result.returncode or "Usage: configure [options]" not in result.stdout:
        raise ValueError("FFmpeg recipe option preflight failed:\n" + result.stdout[-4000:])
    report = {"passed": True, "optionCount": len(options)}
    print(f"FFmpeg configure accepted {len(options)} recipe options before compilation", flush=True)
    return report
