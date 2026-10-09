"""Regression for OpenSSL 4.1-dev headers without ASN1_STRING_get_length."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from patch_curl_compat import patch


class CurlCompatTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lampaua-curl-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.code = self.root / "lib/vtls/openssl.c"
        self.code.parent.mkdir(parents=True)
        self.original = ('#if OPENSSL_VERSION_NUMBER < 0x40100000L\n'
                         'static size_t ASN1_STRING_get_length(const ASN1_STRING *str)\n'
                         '{\n  const int length = ASN1_STRING_length(str);\n'
                         '  return length >= 0 ? (size_t)length : 0;\n}\n#endif\n')
        self.code.write_text(self.original)
        (self.root / "CMakeLists.txt").write_text(
            'find_package(OpenSSL REQUIRED)\n'
            'include("$ENV{LAMPAUA_MPV_SCRIPTS}/static-openssl.cmake")\n')

    def test_patch_uses_feature_probe_and_is_idempotent(self):
        patch(self.root)
        updated = self.code.read_text()
        self.assertIn("#ifndef LAMPAUA_HAVE_ASN1_STRING_GET_LENGTH", updated)
        self.assertIn("ASN1_STRING_length(str)", updated)
        self.assertIn("curl-openssl-compat.cmake", (self.root / "CMakeLists.txt").read_text())
        patch(self.root)
        self.assertEqual(self.code.read_text(), updated)

    def test_unknown_guard_is_rejected_without_writes(self):
        self.code.write_text(self.original.replace("0x40100000L", "0x40200000L"))
        original = self.code.read_text()
        with self.assertRaises(ValueError):
            patch(self.root)
        self.assertEqual(self.code.read_text(), original)
        self.assertNotIn("curl-openssl-compat", (self.root / "CMakeLists.txt").read_text())

    def test_fallback_compiles_with_old_4_1_dev_headers(self):
        fixture = self.root / "probe.c"
        prelude = ('#ifndef _MSC_VER\ntypedef unsigned long size_t;\n#endif\n'
                   'typedef struct asn1_string_st ASN1_STRING;\n'
                   '#define OPENSSL_VERSION_NUMBER 0x40100000L\n'
                   'int ASN1_STRING_length(const ASN1_STRING *str);\n')
        caller = 'size_t probe(const ASN1_STRING *str) { return ASN1_STRING_get_length(str); }\n'
        compiler = os.environ.get("LAMPAUA_CC") or shutil.which("cc")
        msvc = os.name == "nt"
        if msvc and not compiler:
            compiler = "C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.51.36231/bin/Hostx64/x64/cl.exe"
        self.assertIsNotNone(compiler)
        args = [compiler, "/nologo", "/W3", "/WX", "/c", str(fixture), f"/Fo{self.root / 'probe.obj'}"] if msvc else [
            compiler, "-Werror=implicit-function-declaration", "-c", str(fixture), "-o", str(self.root / "probe.o")]
        fixture.write_text(prelude + self.original + caller)
        original = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertNotEqual(original.returncode, 0)
        self.assertIn("ASN1_STRING_get_length", original.stdout)
        patch(self.root)
        for present in (False, True):
            declarations = ('#define LAMPAUA_HAVE_ASN1_STRING_GET_LENGTH 1\n'
                            'size_t ASN1_STRING_get_length(const ASN1_STRING *str);\n') if present else ""
            fixture.write_text(prelude + declarations + self.code.read_text() + caller)
            result = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            self.assertEqual(result.returncode, 0, result.stdout)


if __name__ == "__main__":
    unittest.main()
