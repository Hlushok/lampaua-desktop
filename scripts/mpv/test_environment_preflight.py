"""The refreshed candidate image must pass before source/compiler builds."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

try:
    import preflight_environment as preflight
except ModuleNotFoundError:
    preflight = None


class EnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(preflight, "Environment preflight not implemented")
        self.commands = []

    def command(self, args, **kwargs):
        self.commands.append(args)
        name = Path(args[0]).name
        if args[1:] == ["-E", "capabilities"]:
            return json.dumps({"version": {"string": "4.4.3"}, "generators": [{"name": "Ninja"}]})
        if name == "meson":
            return "1.10.0\n"
        if name == "ninja":
            return "1.13.0\n"
        if name == "environment-smoke":
            return "environment-smoke-ok\n"
        return "fixture tool version\n"

    def check(self, runner=None, locate=None, python_version=(3, 12, 14)):
        with patch.object(preflight.platform, "system", return_value="Linux"), \
                patch.object(preflight.platform, "machine", return_value="x86_64"), \
                patch.object(preflight.sys, "version_info", python_version):
            return preflight.check_environment(runner=runner or self.command,
                locate=locate or (lambda name: f"/usr/bin/{name}"))

    def test_available_tools_and_real_smoke_commands_are_required(self):
        report = self.check()
        self.assertTrue(report["passed"])
        self.assertTrue(report["smoke"])
        self.assertIn("cmake", report["tools"])
        self.assertTrue(any("--build" in args for args in self.commands))
        self.assertTrue(any(Path(args[0]).name == "environment-smoke" for args in self.commands))

    def test_missing_tool_fails_before_compile(self):
        report = self.check(locate=lambda name: None if name == "meson" else f"/usr/bin/{name}")
        self.assertFalse(report["passed"])
        self.assertIn("meson", report["error"])
        self.assertFalse(any("--build" in args for args in self.commands))

    def test_old_meson_fails_before_compile(self):
        def run(args, **kwargs):
            return "1.2.0" if Path(args[0]).name == "meson" else self.command(args, **kwargs)
        report = self.check(runner=run)
        self.assertFalse(report["passed"])
        self.assertIn("Meson", report["error"])

    def test_missing_ninja_generator_fails(self):
        def run(args, **kwargs):
            if args[1:] == ["-E", "capabilities"]:
                return json.dumps({"version": {"string": "4.4.3"}, "generators": []})
            return self.command(args, **kwargs)
        self.assertFalse(self.check(runner=run)["passed"])

    def test_old_cmake_fails(self):
        def run(args, **kwargs):
            if args[1:] == ["-E", "capabilities"]:
                return json.dumps({"version": {"string": "3.28.0"}, "generators": [{"name": "Ninja"}]})
            return self.command(args, **kwargs)
        self.assertFalse(self.check(runner=run)["passed"])

    def test_tool_timeout_fails(self):
        def run(args, **kwargs):
            raise subprocess.TimeoutExpired(args, 60)
        self.assertFalse(self.check(runner=run)["passed"])

    def test_compiler_error_is_not_a_successful_preflight(self):
        def run(args, **kwargs):
            if "--build" in args:
                raise subprocess.CalledProcessError(1, args, output="compiler rejected C++20")
            return self.command(args, **kwargs)
        report = self.check(runner=run)
        self.assertFalse(report["passed"])
        self.assertIn("compiler rejected C++20", report["error"])

    def test_wrong_binary_output_fails(self):
        def run(args, **kwargs):
            return "wrong executable" if Path(args[0]).name == "environment-smoke" else self.command(args, **kwargs)
        self.assertFalse(self.check(runner=run)["passed"])

    def test_old_python_fails_before_any_tool(self):
        self.assertFalse(self.check(python_version=(3, 11, 0))["passed"])
        self.assertFalse(self.commands)

    def test_report_is_written_on_failure_too(self):
        with tempfile.TemporaryDirectory(prefix="lampaua-env-report-") as folder:
            output = Path(folder) / "environment.json"
            config = Path(folder) / "config.json"
            config.write_text(json.dumps({"container": "fixture@sha256:" + "a" * 64}))
            with patch.object(preflight, "check_environment", return_value={"passed": False, "error": "fixture"}):
                self.assertEqual(preflight.main(["--config", str(config), "--output", str(output)]), 1)
            self.assertFalse(json.loads(output.read_text())["passed"])


if __name__ == "__main__":
    unittest.main()
