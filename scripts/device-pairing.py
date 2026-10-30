"""Approved one-use device pairing issuer. The raw capability is stdout-only."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import stat
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
TTL_MS = 10 * 60 * 1000


class Refused(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Refused(code)


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise Refused('arguments_invalid')


def private_directory(path):
    require((path == ROOT or ROOT in path.parents) and path.resolve() == path, 'directory_scope')
    info = path.stat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700, 'directory_not_private')


def check_scope():
    require(platform.system() == 'Linux', 'linux_required')
    script = Path(os.path.abspath(__file__))
    require(script.resolve() == script and script == ROOT / 'scripts/device-pairing.py', 'issuer_location')
    private_directory(ROOT)
    private_directory(ROOT / 'runtime')


def create(port=8443):
    require(type(port) is int and 1024 <= port <= 65535, 'port_invalid')
    check_scope()
    directory = ROOT / 'runtime/device-pairings'
    try:
        directory.mkdir(mode=0o700)
    except FileExistsError:
        pass
    private_directory(directory)  # An existing user's directory is never chmodded.
    created_at = int(time.time() * 1000)
    require(created_at > 0, 'clock_invalid')
    entropy = secrets.token_bytes(32)
    require(isinstance(entropy, bytes) and len(entropy) == 32, 'entropy_invalid')
    token = base64.urlsafe_b64encode(entropy).rstrip(b'=').decode('ascii')
    require(re.fullmatch(r'[A-Za-z0-9_-]{43}', token) is not None, 'token_invalid')
    token_hash = hashlib.sha256(token.encode('ascii')).hexdigest()
    expires_at = created_at + TTL_MS
    record = {'schemaVersion': 1, 'tokenHash': token_hash, 'createdAt': created_at, 'expiresAt': expires_at}
    path = directory / (token_hash + '.json')
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write((json.dumps(record, separators=(',', ':')) + '\n').encode('ascii'))
        stream.flush(); os.fsync(stream.fileno())
    return {'pairingUrl': 'http://127.0.0.1:' + str(port) + '/#pair=' + token, 'expiresAt': expires_at}


def main(argv):
    require('--approved' in argv, 'approval_required')
    parser = SafeParser(add_help=False)
    parser.add_argument('--approved', action='store_true', required=True)
    parser.add_argument('action', choices=['create'])
    parser.add_argument('--port', type=int, default=8443)
    args = parser.parse_args(argv)
    os.umask(0o077)
    return create(args.port)


if __name__ == '__main__':
    try:
        print(json.dumps(main(sys.argv[1:]), separators=(',', ':')))
    except Refused as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr); raise SystemExit(1)
    except Exception:
        print(json.dumps({'error': 'pairing_create_failed'}), file=sys.stderr); raise SystemExit(1)
