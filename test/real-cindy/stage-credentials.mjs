// Host side: put sign-in copies for THIS run into <scratch>/stage/signin, refresh tokens emptied.
//   node test/real-cindy/stage-credentials.mjs <scratch>            stage the copies
//   node test/real-cindy/stage-credentials.mjs <scratch> --remove   delete them again (run as soon as the guest has them)
//
// The script moves fields and prints nothing about them: no value, no key name, only which files were staged.
// Codex and Claude only. Grok is not copied: Cindy keeps its xAI sign-in in its own store.
// Emptying every refresh-token field means the guest can use the access token until it expires but can never rotate
// the host's sign-in away; the access token is short-lived and the guest is destroyed at the end of the run.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const scratch = process.argv[2];
if (!scratch) throw new Error('usage: stage-credentials.mjs <scratch> [--remove]');
const run = JSON.parse(readFileSync(join(scratch, 'run.json'), 'utf8'));
const dir = join(run.stage, 'signin');

if (process.argv.includes('--remove')) {
  rmSync(dir, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ removed: !existsSync(dir) }) + '\n');
  process.exit(0);
}

function emptyRefresh(node) {
  let emptied = 0;
  if (Array.isArray(node)) { for (const v of node) emptied += emptyRefresh(v); return emptied; }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      if (/refresh[_-]?token/i.test(k) && typeof node[k] === 'string') { node[k] = ''; emptied += 1; } else emptied += emptyRefresh(node[k]);
    }
  }
  return emptied;
}

const sources = [
  { name: 'codex', from: join(homedir(), '.codex', 'auth.json'), to: join(dir, 'codex', 'auth.json') },
  { name: 'claude', from: join(homedir(), '.claude', '.credentials.json'), to: join(dir, 'claude', '.credentials.json') },
];
const staged = {};
for (const s of sources) {
  if (!existsSync(s.from)) { staged[s.name] = { staged: false, reason: 'no sign-in file on this host' }; continue; }
  const doc = JSON.parse(readFileSync(s.from, 'utf8'));
  const emptied = emptyRefresh(doc);
  mkdirSync(join(s.to, '..'), { recursive: true });
  writeFileSync(s.to, JSON.stringify(doc));
  try { chmodSync(s.to, 0o600); } catch { /* Windows */ }
  staged[s.name] = { staged: true, refresh_fields_emptied: emptied };
}
process.stdout.write(JSON.stringify(staged) + '\n');
