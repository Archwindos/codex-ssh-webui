"""Pairing CLI fixtures only. No SSH, real capability, model or production file."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('device_pairing', Path(__file__).with_name('device-pairing.py'))
pairing = importlib.util.module_from_spec(spec); spec.loader.exec_module(pairing)
TEST_UID = 42424


class PairingTests(unittest.TestCase):
    def test_missing_approval_and_invalid_args_have_no_filesystem_or_entropy_access(self):
        with patch.object(pairing, 'check_scope', side_effect=AssertionError('no scope access')), patch.object(pairing.os, 'open') as opened, patch.object(pairing.secrets, 'token_bytes') as entropy:
            for argv in [[], ['create'], ['--approved', 'remove'], ['--approved', 'create', '--root', '/tmp']]:
                with self.assertRaises(pairing.Refused): pairing.main(argv)
            opened.assert_not_called(); entropy.assert_not_called()

    def test_linux_script_location_and_private_parents_required(self):
        with patch.object(pairing.platform, 'system', return_value='Linux'), \
             patch.object(pairing, '__file__', str(pairing.ROOT / 'scripts/device-pairing.py')), patch.object(pairing.Path, 'resolve', lambda p: p), patch.object(pairing, 'private_directory') as private:
            pairing.check_scope(); self.assertEqual([call.args[0] for call in private.call_args_list], [pairing.ROOT, pairing.ROOT / 'runtime'])
            with patch.object(pairing.platform, 'system', return_value='Windows'):
                with self.assertRaisesRegex(pairing.Refused, 'linux_required'): pairing.check_scope()
            with patch.object(pairing, '__file__', str(pairing.ROOT / 'other/device-pairing.py')):
                with self.assertRaisesRegex(pairing.Refused, 'issuer_location'): pairing.check_scope()
        with patch.object(pairing.platform, 'system', return_value='Linux'), patch.object(pairing.Path, 'resolve', return_value=pairing.ROOT / 'elsewhere/device-pairing.py'):
            with self.assertRaisesRegex(pairing.Refused, 'issuer_location'): pairing.check_scope()

    def test_repository_root_is_derived_from_script_even_from_another_working_directory(self):
        path = Path(pairing.__file__).resolve(); original_cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                spec = importlib.util.spec_from_file_location('pairing_other_cwd', path)
                module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
                self.assertEqual(module.ROOT, path.parent.parent)
            finally:
                os.chdir(original_cwd)

    def test_private_directory_rejects_links_wrong_owner_mode_and_outside_root(self):
        target = pairing.ROOT / 'runtime/device-pairings'
        good = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=TEST_UID)
        with patch.object(pairing.os, 'geteuid', return_value=TEST_UID, create=True), patch.object(pairing.Path, 'resolve', lambda p: p), patch.object(pairing.Path, 'stat', return_value=good):
            pairing.private_directory(target)
            for changed in [SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=TEST_UID), SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=TEST_UID + 1), SimpleNamespace(st_mode=stat.S_IFREG | 0o700, st_uid=TEST_UID)]:
                with patch.object(pairing.Path, 'stat', return_value=changed):
                    with self.assertRaisesRegex(pairing.Refused, 'directory_not_private'): pairing.private_directory(target)
            with self.assertRaisesRegex(pairing.Refused, 'directory_scope'): pairing.private_directory(pairing.ROOT.parent / 'outside')
        with patch.object(pairing.Path, 'resolve', return_value=pairing.ROOT.parent / 'linked'):
            with self.assertRaisesRegex(pairing.Refused, 'directory_scope'): pairing.private_directory(target)

    def test_token_is_32_bytes_43_chars_ten_minutes_and_only_hash_is_persisted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'runtime').mkdir()
            with patch.object(pairing, 'ROOT', root), patch.object(pairing, 'check_scope'), patch.object(pairing, 'private_directory'), \
                 patch.object(pairing.time, 'time', return_value=1700000000.125), patch.object(pairing.secrets, 'token_bytes', return_value=bytes(range(32))) as entropy:
                result = pairing.main(['--approved', 'create'])
            entropy.assert_called_once_with(32)
            self.assertEqual(set(result), {'pairingUrl', 'expiresAt'})
            token = result['pairingUrl'].split('#pair=')[1]
            self.assertEqual(len(token), 43); self.assertEqual(len(base64.urlsafe_b64decode(token + '=')), 32)
            digest = hashlib.sha256(token.encode()).hexdigest()
            files = list((root / 'runtime/device-pairings').iterdir()); self.assertEqual([p.name for p in files], [digest + '.json'])
            data = files[0].read_bytes(); self.assertNotIn(token.encode(), data)
            record = json.loads(data)
            self.assertEqual(record, {'schemaVersion': 1, 'tokenHash': digest, 'createdAt': 1700000000125, 'expiresAt': 1700000600125})
            self.assertEqual(record['expiresAt'], result['expiresAt'])

    def test_custom_port_is_loopback_only_and_invalid_ports_never_touch_filesystem(self):
        with patch.object(pairing, 'check_scope', side_effect=AssertionError('must reject before scope')), patch.object(pairing.os, 'open') as opened:
            for port in [True, 0, 1023, 65536, '8443', 'https://example.com']:
                with self.assertRaisesRegex(pairing.Refused, 'port_invalid'): pairing.create(port)
            opened.assert_not_called()
        with patch.object(pairing, 'create', return_value={}) as create:
            pairing.main(['--approved', 'create', '--port', '9443']); create.assert_called_once_with(9443)
        stream = Mock(); stream.__enter__ = Mock(return_value=stream); stream.__exit__ = Mock(return_value=False)
        with patch.object(pairing, 'check_scope'), patch.object(pairing, 'private_directory'), patch.object(pairing.Path, 'mkdir'), \
             patch.object(pairing.os, 'open', return_value=7), patch.object(pairing.os, 'fdopen', return_value=stream), patch.object(pairing.os, 'fsync'), \
             patch.object(pairing.secrets, 'token_bytes', return_value=b'p' * 32):
            self.assertTrue(pairing.create(9443)['pairingUrl'].startswith('http://127.0.0.1:9443/#pair='))

    def test_collision_does_not_overwrite_or_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'runtime').mkdir()
            with patch.object(pairing, 'ROOT', root), patch.object(pairing, 'check_scope'), patch.object(pairing, 'private_directory'), patch.object(pairing.secrets, 'token_bytes', return_value=b'x' * 32) as entropy:
                pairing.create(); before = {p: p.read_bytes() for p in (root / 'runtime/device-pairings').iterdir()}
                with self.assertRaises(FileExistsError): pairing.create()
                self.assertEqual(entropy.call_count, 2)
                self.assertTrue(all(path.read_bytes() == data for path, data in before.items()))

    def test_create_requests_exclusive_private_file_and_invalid_clock_or_entropy_never_write(self):
        stream = Mock(); stream.__enter__ = Mock(return_value=stream); stream.__exit__ = Mock(return_value=False)
        with patch.object(pairing, 'check_scope'), patch.object(pairing, 'private_directory'), patch.object(pairing.Path, 'mkdir'), \
             patch.object(pairing.os, 'open', return_value=7) as opened, patch.object(pairing.os, 'fdopen', return_value=stream), patch.object(pairing.os, 'fsync'), patch.object(pairing.secrets, 'token_bytes', return_value=b'x' * 32):
            pairing.create(); args = opened.call_args.args
            self.assertEqual(args[2], 0o600); self.assertTrue(args[1] & pairing.os.O_EXCL); self.assertTrue(args[1] & pairing.os.O_CREAT)
            opened.reset_mock()
            with patch.object(pairing.time, 'time', return_value=0):
                with self.assertRaisesRegex(pairing.Refused, 'clock_invalid'): pairing.create()
            with patch.object(pairing.secrets, 'token_bytes', return_value=b'weak'):
                with self.assertRaisesRegex(pairing.Refused, 'entropy_invalid'): pairing.create()
            opened.assert_not_called()


if __name__ == '__main__':
    unittest.main()
