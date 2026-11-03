"""scripts/cindy_0_1_121_cancel_hotfix.py refuses anything but the reviewed 0.1.121 build and then changes nothing.

The positive apply/restore path needs the real signed Cindy 0.1.121 installation; that evidence is in
docs/CINDY_REAL_ACCEPTANCE_AND_CANCEL_FIX.md, not here.
"""
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'scripts'))
import cindy_0_1_121_cancel_hotfix as hotfix  # noqa: E402


def asar(path, version, member=b'console.log(1)'):
    """A minimal ASAR: package.json and the bootstrap member the hotfix inspects."""
    package = json.dumps({'version': version}).encode()
    files = {'package.json': {'size': len(package), 'offset': '0'},
             '.vite': {'files': {'build': {'files': {'bootstrap-electron-DYGB3X66.js': {
                 'size': len(member), 'offset': str(len(package)),
                 'integrity': {'hash': hashlib.sha256(member).hexdigest(), 'blockSize': 4194304, 'algorithm': 'SHA256'}}}}}}}
    header = json.dumps({'files': files}).encode()
    payload = struct.pack('<I', len(header)) + header
    payload += b'\0' * (-len(payload) % 4)
    path.write_bytes(struct.pack('<3I', 4, 4 + len(payload), len(payload)) + payload + package + member)


class CancelHotfixRefusalTests(unittest.TestCase):
    def check(self, path, message):
        before = path.read_bytes()
        for action in ('check', 'apply', 'restore'):
            proc = subprocess.run([sys.executable, '-X', 'utf8', str(REPO / 'scripts' / 'cindy_0_1_121_cancel_hotfix.py'),
                                   str(path), '--action', action], capture_output=True, text=True, timeout=60)
            self.assertNotEqual(proc.returncode, 0, action)
            self.assertIn(message, proc.stderr, action)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(sorted(p.name for p in path.parent.iterdir()), [path.name])

    def test_other_versions_are_refused_without_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'app.asar'
            asar(path, '0.1.122')
            self.check(path, 'Only Cindy 0.1.121 is supported')

    def test_unreviewed_code_with_the_right_version_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'app.asar'
            asar(path, '0.1.121')
            self.check(path, 'differs from the reviewed release')

    def test_a_file_that_is_not_an_asar_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'app.asar'
            path.write_bytes(b'\x05\0\0\0' + b'\0' * 64)
            self.check(path, 'Invalid ASAR header')

    def test_patch_keeps_member_length(self):
        # The hotfix pads its shorter replacement so every other payload offset stays valid.
        self.assertGreaterEqual(hotfix.PADDING, 0)
        self.assertEqual(len(hotfix.OLD) + len(hotfix.OLD_TERMINAL), len(hotfix.NEW) + len(hotfix.NEW_TERMINAL) + hotfix.PADDING)


if __name__ == '__main__':
    unittest.main()
