"""Offline checks for static OpenSSL dependency ordering and guarded patches."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from patch_static_openssl import patch


class StaticOpenSSLTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lampaua-openssl-test-")
        self.addCleanup(self.temporary.cleanup)
        self.source = Path(self.temporary.name)
        self.file = self.source / "CMakeLists.txt"

    def test_patch_keeps_real_quic_probe(self):
        original = ('if(ENABLE_OPENSSL)\n  find_package(OpenSSL 1.1.1 REQUIRED)\nendif()\n'
                    'check_symbol_exists(SSL_set_quic_tls_cbs "openssl/ssl.h" HAVE_SSL_SET_QUIC_TLS_CBS)\n')
        self.file.write_text(original)
        patch(self.source)
        updated = self.file.read_text()
        self.assertIn('find_package(OpenSSL 1.1.1 REQUIRED)\n  include(', updated)
        self.assertIn(original.splitlines()[-1], updated)
        self.assertNotIn("set(HAVE_SSL", updated)
        patch(self.source)
        self.assertEqual(self.file.read_text(), updated)

    def test_curl_patch_keeps_required_openssl(self):
        self.file.write_text("if(CURL_USE_OPENSSL)\n  find_package(OpenSSL REQUIRED)\nendif()\n")
        patch(self.source)
        self.assertIn('find_package(OpenSSL REQUIRED)\n  include(', self.file.read_text())

    def test_changed_source_layout_is_rejected_without_writing(self):
        for text in ("project(other)\n", "find_package(OpenSSL REQUIRED)\nfind_package(OpenSSL REQUIRED)\n"):
            self.file.write_text(text)
            with self.assertRaisesRegex(ValueError, "OpenSSL lookup"):
                patch(self.source)
            self.assertEqual(self.file.read_text(), text)

    def test_malformed_existing_hook_is_rejected_without_writing(self):
        lookup = "find_package(OpenSSL REQUIRED)\n"
        marker = 'include("$ENV{LAMPAUA_MPV_SCRIPTS}/static-openssl.cmake")\n'
        for text in (lookup + "# " + marker, marker + lookup,
                     lookup + marker + lookup, lookup + marker + marker):
            self.file.write_text(text)
            with self.assertRaisesRegex(ValueError, "OpenSSL"):
                patch(self.source)
            self.assertEqual(self.file.read_text(), text)

    def test_cmake_appends_private_libraries_after_crypto(self):
        cmake = os.environ.get("LAMPAUA_CMAKE") or shutil.which("cmake")
        self.assertIsNotNone(cmake, "CMake is required for the static dependency contract")
        scripts = Path(__file__).resolve().parent.as_posix()
        modules = self.source / "modules"
        modules.mkdir()
        include = (self.source / "openssl/include").as_posix()
        (modules / "FindPkgConfig.cmake").write_text(
            'set(PkgConfig_FOUND TRUE)\n'
            'function(pkg_check_modules prefix)\n'
            '  set(${prefix}_STATIC_LIBRARIES ssl crypto z brotlienc brotlidec brotlicommon zstd ws2_32 bcrypt PARENT_SCOPE)\n'
            '  set(${prefix}_STATIC_LDFLAGS_OTHER "-pthread" PARENT_SCOPE)\n'
            'endfunction()\n'
            'function(pkg_get_variable result module variable)\n'
            f'  set(${{result}} "{include}" PARENT_SCOPE)\n'
            'endfunction()\n')
        self.file.write_text(
            'cmake_minimum_required(VERSION 3.20)\nproject(StaticTLS NONE)\n'
            f'list(PREPEND CMAKE_MODULE_PATH "{modules.as_posix()}")\n'
            'set(WIN32 TRUE)\nset(MINGW TRUE)\n'
            f'set(OPENSSL_INCLUDE_DIR "{include}")\n'
            'set(OPENSSL_SSL_LIBRARIES ssl.a)\nset(OPENSSL_CRYPTO_LIBRARIES crypto.a)\n'
            'set(OPENSSL_LIBRARIES ssl.a crypto.a)\n'
            'add_library(OpenSSL::Crypto INTERFACE IMPORTED)\n'
            'add_library(OpenSSL::SSL INTERFACE IMPORTED)\n'
            'set_property(TARGET OpenSSL::SSL PROPERTY INTERFACE_LINK_LIBRARIES OpenSSL::Crypto)\n'
            f'include("{scripts}/static-openssl.cmake")\n'
            'set(dependencies "z;brotlienc;brotlidec;brotlicommon;zstd;ws2_32;bcrypt;-pthread")\n'
            'if(NOT OPENSSL_LIBRARIES STREQUAL "ssl.a;crypto.a;${dependencies}")\n'
            '  message(FATAL_ERROR "Static libraries have the wrong order: ${OPENSSL_LIBRARIES}")\nendif()\n'
            'get_target_property(actual OpenSSL::Crypto INTERFACE_LINK_LIBRARIES)\n'
            'if(NOT actual STREQUAL dependencies)\n'
            '  message(FATAL_ERROR "Imported target lost static dependencies: ${actual}")\nendif()\n')
        result = subprocess.run([cmake, "-S", str(self.source), "-B", str(self.source / "build")],
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertEqual(result.returncode, 0, result.stdout)
        metadata = modules / "FindPkgConfig.cmake"
        metadata.write_text(metadata.read_text().replace(include, include + "-wrong"))
        rejected = subprocess.run([cmake, "-S", str(self.source), "-B", str(self.source / "wrong-metadata")],
                                  text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("metadata does not match", rejected.stdout)


if __name__ == "__main__":
    unittest.main()
