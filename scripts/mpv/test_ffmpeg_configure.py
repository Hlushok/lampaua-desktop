"""Validate the real configure arguments without starting a compiler."""
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from check_ffmpeg_configure import check_options
from prepare_build import update_native_ffmpeg_recipe


class FfmpegConfigureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lampaua-ffmpeg-options-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "configure").write_text(
            '#!/usr/bin/env bash\nfor arg; do\ncase "$arg" in\n'
            '  --enable-gpl|--extra-libs=*) ;;\n'
            '  --help) printf "Usage: configure [options]\\n"; exit 0 ;;\n'
            '  *) printf "Unknown option %s\\n" "$arg"; exit 1 ;;\n'
            'esac\ndone\nprintf compiler-invoked > compiler-invoked\nexit 99\n',
            encoding="utf-8", newline="\n")
        self.bash = "C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else shutil.which("bash")

    def project(self, *options):
        return {"source": str(self.source), "configureCommand": [
            "/build/exec", "CONF=1", "<SOURCE_DIR>/configure", *options]}

    def test_valid_options_and_spaces_are_passed_as_individual_arguments(self):
        report = check_options(self.project("--enable-gpl", "--extra-libs=-lstdc++ -lfoo"), self.bash)
        self.assertEqual(report["optionCount"], 2)
        self.assertTrue(report["passed"])
        self.assertEqual(list(self.source.iterdir()), [self.source / "configure"])

    def test_removed_option_is_rejected_before_compiler(self):
        with self.assertRaisesRegex(ValueError, "Unknown option --enable-opengl"):
            check_options(self.project("--enable-gpl", "--enable-opengl"), self.bash)

    def test_help_and_list_cannot_skip_later_option_validation(self):
        for option in ("--help", "-h", "--list-decoders"):
            with self.subTest(option=option), self.assertRaises(ValueError):
                check_options(self.project(option, "--enable-opengl"), self.bash)

    def test_missing_or_ambiguous_configure_command_is_rejected(self):
        for command in (None, [], ["/build/exec", "--enable-gpl"],
                        ["<SOURCE_DIR>/configure", "<SOURCE_DIR>/configure"],
                        ["<SOURCE_DIR>/configure"], ["<SOURCE_DIR>/configure", "bare-arg"]):
            with self.subTest(command=command), self.assertRaises(ValueError):
                check_options({"source": str(self.source), "configureCommand": command}, self.bash)

    def test_candidate_recipe_removes_only_the_obsolete_ffmpeg_flag(self):
        recipe = self.root / "ffmpeg.cmake"
        before = 'ExternalProject_Add(ffmpeg\n        --enable-openal\n        --enable-opengl\n        --enable-vaapi\n)\n'
        recipe.write_text(before, encoding="utf-8")
        update_native_ffmpeg_recipe(recipe)
        self.assertEqual(recipe.read_text(), before.replace('        --enable-opengl\n', ''))
        with self.assertRaises(ValueError):
            update_native_ffmpeg_recipe(recipe)


if __name__ == "__main__":
    unittest.main()
