"""Put an `agentcompass` command into a bin directory the way pip and uv install console scripts.

    python -X utf8 test/make_launcher.py <bin dir> <program> [<argument>...]

The command runs `<program> <argument>... <its own arguments>` with stdin, stdout and stderr passed through. On Windows
it is a native `agentcompass.exe` (distlib's launcher with a script appended, as pip writes console scripts), elsewhere
an executable sh script. Test helper only: the plugin's zero-config discovery must find and spawn it like an install.
"""
import os
import shlex
import stat
import sys
import tempfile
from pathlib import Path


def make(bin_dir, argv, name='agentcompass'):
    bin_dir = Path(bin_dir)
    bin_dir.mkdir(parents=True, exist_ok=True)
    if os.name != 'nt':
        script = bin_dir / name
        script.write_text(f'#!/bin/sh\nexec {shlex.join(map(str, argv))} "$@"\n', encoding='utf-8')
        script.chmod(script.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        return script
    from pip._vendor.distlib.scripts import ScriptMaker
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / name).write_text('#!python\nimport subprocess, sys\n'
                                      f'sys.exit(subprocess.call({list(map(str, argv))!r} + sys.argv[1:]))\n', encoding='utf-8')
        maker = ScriptMaker(tmp, str(bin_dir), add_launchers=True)
        maker.executable = sys.executable
        written = maker.make(name)
    exe = bin_dir / f'{name}.exe'
    if not exe.is_file():
        raise SystemExit(f'distlib wrote {written}, not {exe}')
    return exe


if __name__ == '__main__':
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    print(make(sys.argv[1], sys.argv[2:]))
