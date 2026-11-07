"""scripts/build_plugin.py: the reviewable plugin source it writes and what it refuses."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'scripts'))
import build_plugin  # noqa: E402


def build(*argv):
    proc = subprocess.run([sys.executable, '-X', 'utf8', str(REPO / 'scripts' / 'build_plugin.py'), *map(str, argv)],
                          capture_output=True, text=True, encoding='utf-8', timeout=60)
    return proc.returncode, json.loads(proc.stdout)


class BuildPluginTests(unittest.TestCase):
    def test_build_binds_an_explicit_command_and_writes_the_v3_manifest_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'plugin src'
            code, doc = build('--output', output, '--router-cmd', json.dumps([sys.executable, '-m', 'agentcompass', 'roll']))
            self.assertEqual(code, 0, doc)
            shipped = sorted(p.relative_to(output).as_posix() for p in output.rglob('*') if p.is_file())
            self.assertEqual(shipped, ['assets/icon.png', 'engine/allocator.mjs', 'engine/catalog.mjs', 'engine/classifier-cases.json', 'engine/continuity.mjs',
                                       'engine/profiler.mjs', 'engine/quota-loader.mjs', 'engine/quota.mjs', 'engine/route.mjs', 'ghost.json', 'locales/en.json', 'locales/ja.json', 'locales/ko.json',
                                       'locales/zh-CN.json', 'main.js', 'router.json', 'worker.cjs'])
            config = json.loads((output / 'router.json').read_text(encoding='utf-8'))
            self.assertEqual(config['command'][1:], ['-m', 'agentcompass', 'roll'])
            self.assertTrue(Path(config['command'][0]).is_absolute())
            self.assertEqual(config['accountMappings'], [])
            manifest = json.loads((output / 'ghost.json').read_text(encoding='utf-8'))
            # Cindy's real v3 packer rejects a manifest without a version floor.
            self.assertEqual(manifest['schemaVersion'], 3)
            self.assertRegex(manifest.get('minCindyVersion', ''), r'^\d+\.\d+\.\d+(?:[-+].+)?$')
            self.assertTrue(manifest['sessionContext'])
            self.assertTrue(manifest['agent']['tasks'])
            self.assertEqual([t['name'] for t in manifest['tools']], ['roll', 'status', 'stop', 'cleanup'])
            self.assertNotIn('skill', manifest)  # upstream deprecated new bundled skills
            for name in shipped:
                if name != 'router.json':
                    self.assertEqual((output / name).read_bytes(), (REPO / 'plugin' / name).read_bytes(), name)
            self.assertFalse((Path(tmp) / '.cindy').exists())

    def test_checkout_path_runs_its_package_with_this_python(self):
        with tempfile.TemporaryDirectory() as tmp:
            checkout = Path(tmp) / 'AgentCompass'
            (checkout / 'agentcompass').mkdir(parents=True)
            (checkout / 'agentcompass' / '__main__.py').write_text('', encoding='utf-8')
            for given in (checkout, checkout / 'agentcompass'):
                command = build_plugin.router_command(str(given))
                self.assertEqual(command[1:], ['-X', 'utf8', str((checkout / 'agentcompass').resolve()), 'roll'])

    def test_account_map_is_carried_verbatim_and_state_root_is_absolute(self):
        rows = [{'routerProvider': 'codex', 'routerAccount': 'codex', 'providerId': 'openai', 'agentKind': 'codex'}]
        with tempfile.TemporaryDirectory() as tmp:
            mapping = Path(tmp) / 'map.json'
            mapping.write_text(json.dumps(rows), encoding='utf-8')
            code, doc = build('--output', Path(tmp) / 'p', '--account-map', mapping, '--state-root', Path(tmp) / 'state',
                              '--router-cmd', json.dumps([sys.executable, 'roll']))
            self.assertEqual(code, 0, doc)
            config = json.loads((Path(tmp) / 'p' / 'router.json').read_text(encoding='utf-8'))
            self.assertEqual(config['accountMappings'], rows)
            self.assertTrue(Path(config['stateRoot']).is_absolute())

    def test_refusals_write_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            existing = Path(tmp) / 'exists'
            existing.mkdir()
            cmd = json.dumps([sys.executable, 'roll'])
            code, doc = build('--output', existing, '--router-cmd', cmd)
            self.assertEqual((code, doc['status']), (2, 'blocked'))
            self.assertIn('already exists', doc['error'])
            bad = Path(tmp) / 'bad.json'
            for rows in ([{'routerProvider': 'codex'}], [{'routerProvider': 'c', 'routerAccount': 'c', 'providerId': 'c', 'agentKind': 'gpt'}], {}):
                bad.write_text(json.dumps(rows), encoding='utf-8')
                code, doc = build('--output', Path(tmp) / 'never', '--account-map', bad, '--router-cmd', cmd)
                self.assertEqual(code, 2)
                self.assertIn('Account mappings', doc['error'])
            for command in ('[]', '["/no/such/agentcompass","roll"]', str(Path(tmp) / 'missing')):
                code, doc = build('--output', Path(tmp) / 'never', '--router-cmd', command)
                self.assertEqual(code, 2, command)
            self.assertFalse((Path(tmp) / 'never').exists())


if __name__ == '__main__':
    unittest.main()
