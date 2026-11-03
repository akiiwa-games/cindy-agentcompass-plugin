"""Opt-in Windows Cindy 0.1.121 cancel hotfix; close Cindy before apply/restore.

Only the verified compiled counterpart of patches/cindy-0.1.121-cancel.patch
is changed. This is a local modified build, not an official Cindy release.
"""
import argparse
import hashlib
import json
import os
import shutil
import struct
import tempfile
from pathlib import Path

MEMBER = '.vite/build/bootstrap-electron-DYGB3X66.js'
ORIGINAL_HASH = 'c8ca530fdd990a73fe65f892d1a2d85a15c46d0b527026de1af86bf792722215'
EXE_ORIGINAL_HASH = 'a950ad5aa1965e24984604db35565f6f99a63bf98606df877d63a95c39252e45'
ORIGINAL_HEADER_HASH = b'e6e492c9c55ddc2d791a118f16ca6c62abd34fb9b67e58441bb1e75b1bf4ffd6'
OLD = b'const ul=await Ml.stopSessionTurn({targetSessionId:Ja});if(!ul.ok)throw new PluginTaskError("UNSUPPORTED_CAPABILITY","Execution does not support stopping");Fc=ul.status==="no-active-turn"'
NEW = b'const ul=l.getSession(Ja);if(!ul){Fc=!0;return}await ul.abort()'
OLD_TERMINAL = b'const aa=(Qo=Kt.data)==null?void 0:Qo.status,ma=!isTerminalTurnErrorEvent(Kt)&&(aa==="cancelled"||aa==="interrupted")?aa:ha?"failed":"completed";'
NEW_TERMINAL = b'const aa=Kt.data?.cancelled===true?"cancelled":Kt.data?.status,ma=!isTerminalTurnErrorEvent(Kt)&&(aa==="cancelled"||aa==="interrupted")?aa:ha?"failed":"completed";'
PADDING = len(OLD) - len(NEW) + len(OLD_TERMINAL) - len(NEW_TERMINAL)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def header_of(stream):
    size, header_size, payload_size, json_size = struct.unpack('<4I', stream.read(16))
    if size != 4 or payload_size + 4 != header_size or json_size > payload_size - 4:
        raise ValueError('Invalid ASAR header; no changes made')
    return json.loads(stream.read(json_size)), 8 + header_size


def entry_of(header, name):
    entry = header
    for part in name.split('/'):
        entry = entry['files'][part]
    return entry


def read_entry(stream, data_offset, entry):
    if entry.get('unpacked') or 'offset' not in entry:
        raise ValueError('Expected packed member; no changes made')
    stream.seek(data_offset + int(entry['offset']))
    data = stream.read(entry['size'])
    if len(data) != entry['size']:
        raise ValueError('Truncated ASAR; no changes made')
    return data


def inspect(path):
    with path.open('rb') as stream:
        header, offset = header_of(stream)
        package = json.loads(read_entry(stream, offset, entry_of(header, 'package.json')))
        if package.get('version') != '0.1.121':
            raise ValueError('Only Cindy 0.1.121 is supported; use a matching source fix')
        entry = entry_of(header, MEMBER)
        content = read_entry(stream, offset, entry)
        current_hash = digest(content)
        original = content
        if current_hash != ORIGINAL_HASH and content.endswith(b' ' * PADDING):
            original = content[:-PADDING].replace(NEW, OLD).replace(NEW_TERMINAL, OLD_TERMINAL)
        if digest(original) != ORIGINAL_HASH or original.count(OLD) != 1 or original.count(OLD_TERMINAL) != 1:
            raise ValueError('Cindy code differs from the reviewed release; no changes made')
        if entry.get('integrity', {}).get('hash') != current_hash:
            raise ValueError('ASAR member integrity mismatch; no changes made')
        return header, offset, entry, content, original, ('original' if content == original else 'patched')


def run_archive(path, action):
    path = path.resolve(strict=True)
    header, offset, entry, content, original, state = inspect(path)
    backup = path.with_name(path.name + '.agentcompass-original')
    if action == 'check':
        return {'state': state, 'archive': str(path), 'member_sha256': digest(content)}
    if action == 'restore':
        if state == 'original':
            return {'state': 'original', 'changed': False}
        if inspect(backup)[-1] != 'original':
            raise ValueError('Original backup is unavailable; no changes made')
        os.replace(backup, path)
        return {'state': 'original', 'changed': True}
    if state == 'patched':
        return {'state': state, 'changed': False}
    if backup.exists():
        if inspect(backup)[-1] != 'original':
            raise ValueError('Existing backup is not original; no changes made')
        with backup.open('rb') as stream:
            backup_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
        with path.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != backup_hash:
                raise ValueError('Existing backup differs; preserve it and resolve manually')
    else:
        shutil.copy2(path, backup)
    patched = original.replace(OLD, NEW).replace(OLD_TERMINAL, NEW_TERMINAL).ljust(len(original), b' ')
    integrity = entry['integrity']
    block_size = integrity['blockSize']
    integrity['hash'] = digest(patched)
    integrity['blocks'] = [digest(patched[i:i + block_size]) for i in range(0, len(patched), block_size)]
    serialized = json.dumps(header, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    payload = struct.pack('<I', len(serialized)) + serialized
    payload += b'\0' * (-len(payload) % 4)
    packed_header = struct.pack('<3I', 4, 4 + len(payload), len(payload)) + payload
    fd, temporary_name = tempfile.mkstemp(prefix=path.name + '.agentcompass-', dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with path.open('rb') as src, os.fdopen(fd, 'wb') as dst:
            dst.write(packed_header)
            src.seek(offset)
            shutil.copyfileobj(src, dst)
            dst.seek(len(packed_header) + int(entry['offset']))
            dst.write(patched)
        assert inspect(temporary)[-1] == 'patched'
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return {'state': 'patched', 'archive': str(path), 'backup': str(backup),
            'member_sha256': digest(patched), 'official_build': False}


def run(path, action):
    path = path.resolve(strict=True)
    inspect(path)
    exe = path.parent.parent / 'Cindy.exe'
    backup = exe.with_name(exe.name + '.agentcompass-original')
    content = exe.read_bytes()
    with path.open('rb') as stream:
        _, _, _, json_size = struct.unpack('<4I', stream.read(16))
        current_header_hash = digest(stream.read(json_size)).encode('ascii')
    original = content.replace(current_header_hash, ORIGINAL_HEADER_HASH)
    if digest(original) != EXE_ORIGINAL_HASH or original.count(ORIGINAL_HEADER_HASH) != 1:
        raise ValueError('Executable differs from reviewed Windows x64 Global build; no changes made')
    if action == 'check':
        return {**run_archive(path, action), 'executable_state': 'original' if content == original else 'patched'}
    if backup.exists():
        if digest(backup.read_bytes()) != EXE_ORIGINAL_HASH:
            raise ValueError('Executable backup differs; no changes made')
    elif action == 'apply':
        with backup.open('xb') as stream:
            stream.write(original)
    result = run_archive(path, action)
    with path.open('rb') as stream:
        _, _, _, json_size = struct.unpack('<4I', stream.read(16))
        updated_header_hash = digest(stream.read(json_size)).encode('ascii')
    target = original if action == 'restore' else original.replace(ORIGINAL_HEADER_HASH, updated_header_hash)
    if target != content:
        fd, name = tempfile.mkstemp(prefix='Cindy.agentcompass-', dir=exe.parent)
        temporary = Path(name)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(target)
            os.replace(temporary, exe)
        finally:
            temporary.unlink(missing_ok=True)
    if action == 'restore':
        backup.unlink(missing_ok=True)
    return {**result, 'executable_state': 'original' if action == 'restore' else 'patched',
            'executable_sha256': digest(target), 'note': 'Original signed executable restored.' if action == 'restore' else 'Local modified build; original vendor signature is not valid after patching. Integrity checks remain enabled.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path, help='Explicit path to the closed Cindy installation resources/app.asar')
    parser.add_argument('--action', choices=['check', 'apply', 'restore'], default='check')
    args = parser.parse_args()
    print(json.dumps(run(args.archive, args.action), ensure_ascii=False, indent=2))
