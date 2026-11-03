"""Build the installable AgentCompass Cindy plugin source directory; installs nothing.

    python -X utf8 scripts/build_plugin.py --output <new-directory> [--account-map <file.json>] [--router-cmd <json-or-path>]
                                           [--state-root <directory>]

The plugin/ directory itself installs as is (market install): without router.json, worker.cjs finds AgentCompass at run
time. A build instead binds one AgentCompass install in router.json. --router-cmd is either a JSON array that is the
complete roll command (for example ["/usr/local/bin/agentcompass", "roll"]), or a path: an `agentcompass` executable or
an AgentCompass source checkout (its `agentcompass` package directory or the checkout root) to which `roll` is appended.
Without it the `agentcompass` on PATH is used.
"""
import argparse
import json
import shutil
import sys
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1] / 'plugin'


def sources():
    """Every file the manifest declares: itself, the logic page, the node worker, the icon and the locale resources."""
    manifest = json.loads((PLUGIN / 'ghost.json').read_text(encoding='utf-8'))
    return ['ghost.json', manifest['entry'], manifest['node']['entry'], manifest['icon'], *manifest['locales'].values()]


MAPPING_KEYS = {'routerProvider', 'routerAccount', 'providerId', 'agentKind'}


def check_mappings(mappings):
    if not isinstance(mappings, list) or any(
        not isinstance(row, dict) or set(row) != MAPPING_KEYS or row.get('agentKind') not in ('cc', 'codex', 'pi') or
        any(not isinstance(value, str) or not value.strip() for value in row.values())
        for row in mappings
    ):
        raise ValueError('Account mappings must name exact routerProvider/routerAccount/providerId/agentKind strings.')
    return mappings


def router_command(value=None):
    """The complete public `roll` command, as an argument vector with an absolute executable."""
    if value is None:
        found = shutil.which('agentcompass')
        if not found:
            raise ValueError('agentcompass is not on PATH; install AgentCompass or pass --router-cmd.')
        return [str(Path(found).resolve()), 'roll']
    text = str(value).strip()
    if text.startswith('['):
        command = json.loads(text)
        if not isinstance(command, list) or not command or any(not isinstance(v, str) or not v for v in command):
            raise ValueError('--router-cmd JSON must be a non-empty array of strings.')
        executable = Path(command[0]) if Path(command[0]).is_absolute() else shutil.which(command[0])
        if not executable or not Path(executable).is_file():
            raise ValueError(f'Router executable {command[0]!r} was not found.')
        return [str(Path(executable).resolve()), *command[1:]]
    path = Path(text).expanduser().resolve()
    if path.is_dir() and (path / 'agentcompass' / '__main__.py').is_file():
        path = path / 'agentcompass'
    if path.is_dir() and (path / '__main__.py').is_file():
        return [str(Path(sys.executable).resolve()), '-X', 'utf8', str(path), 'roll']
    if path.is_file():
        return [str(path), 'roll']
    raise ValueError(f'--router-cmd {text!r} is neither a JSON command, an executable nor an AgentCompass checkout.')


def build_plugin(output, mappings=None, command=None, state_root=None):
    mappings = check_mappings(mappings or [])
    output = Path(output)
    if output.exists():
        raise ValueError('Output already exists; choose a new plugin source directory.')
    output.mkdir(parents=True)
    for name in sources():
        (output / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(PLUGIN / name, output / name)
    config = {'command': command or router_command(), 'accountMappings': mappings}
    if state_root:
        config['stateRoot'] = str(Path(state_root).resolve())
    (output / 'router.json').write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding='utf-8')
    return {'status': 'built', 'plugin_source': str(output.resolve()), 'router_command': config['command'],
            'next_action': 'In Cindy call ghost_forge_pack with this source directory, then install the resulting .cindy '
                           'through Cindy. Approve its Node/sessionContext/tasks capabilities. This does not install anything.'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output', type=Path, required=True, help='new directory for the plugin source')
    parser.add_argument('--account-map', type=Path, help='JSON array of explicit routerProvider/routerAccount/providerId/agentKind bindings')
    parser.add_argument('--router-cmd', help='JSON roll command, agentcompass executable or AgentCompass checkout')
    parser.add_argument('--state-root', type=Path, help='receipt directory (default ~/.agent-compass/cindy-plugin)')
    args = parser.parse_args(argv)
    try:
        mappings = json.loads(args.account_map.read_text(encoding='utf-8')) if args.account_map else []
        check_mappings(mappings)
        command = router_command(args.router_cmd)
        print(json.dumps(build_plugin(args.output, mappings, command, args.state_root), ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError) as exc:
        print(json.dumps({'status': 'blocked', 'error': str(exc)}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
