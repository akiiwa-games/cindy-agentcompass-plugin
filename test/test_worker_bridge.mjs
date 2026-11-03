// The real worker.cjs as a node child speaking JSON-RPC over stdio, with a recording stand-in for the public router.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const PLUGIN = new URL('../plugin/', import.meta.url);
const ctx = dir => ({session_id: 'true-session', workdir: dir, workdir_is_local: true, workdir_is_read_only: false});

const roots = [];
process.on('exit', () => {for (const root of roots) fs.rmSync(root, {recursive: true, force: true});});

// One plugin directory with a fake router that records argv, stdin and environment and prints `answer`. `config`:
//   'plugin' router.json next to worker.cjs (scripts/build_plugin.py), 'home' ~/.agent-compass/cindy-plugin/router.json,
//   'none' no configuration at all (a market install; the test puts an `agentcompass` launcher where it should be found).
function plugin(answer, code = 0, config = 'plugin') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-bridge-'));
  roots.push(root);
  const out = path.join(root, 'plugin');
  fs.mkdirSync(out);
  for (const name of ['ghost.json', 'main.js', 'worker.cjs']) fs.copyFileSync(new URL(name, PLUGIN), path.join(out, name));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.agent-compass', 'cindy-plugin'), {recursive: true});
  const prompt = path.join(root, 'prompt.md');
  fs.writeFileSync(prompt, Buffer.from('unchanged 原文\r\nall lines', 'utf8'));
  const capture = path.join(root, 'captured.json');
  const answerFile = path.join(root, 'answer.json');
  fs.writeFileSync(answerFile, JSON.stringify(answer).replace('"@PROMPT"', () => JSON.stringify(prompt)));
  const fake = path.join(root, 'fake-router.cjs');
  fs.writeFileSync(fake, `
const fs=require('node:fs');const chunks=[];
process.stdin.on('data',d=>chunks.push(d)).on('end',()=>{
  fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({argv:process.argv.slice(2),stdin:Buffer.concat(chunks).toString('utf8'),
    cwd:process.cwd(),paseo:process.env.PASEO_AGENT_ID??null,hc:process.env.HC_TERMINAL_ID??null,legacy:process.env.ROUTER_CINDY_CONTEXT??null}));
  process.stdout.write(fs.readFileSync(${JSON.stringify(answerFile)},'utf8'));
  process.exit(${code});
});`);
  const settings = {command: [process.execPath, fake], stateRoot: path.join(root, 'state')};
  if (config === 'plugin') fs.writeFileSync(path.join(out, 'router.json'), JSON.stringify(settings));
  if (config === 'home') fs.writeFileSync(path.join(home, '.agent-compass', 'cindy-plugin', 'router.json'), JSON.stringify(settings));
  return {root, out, prompt, capture, home, fake, state: config === 'none' ? path.join(home, '.agent-compass', 'cindy-plugin') : settings.stateRoot};
}

// An installed `agentcompass` command (a native .exe on Windows, as pip/uv write them) that runs the fake router.
function launcher(p, dir) {
  const python = [process.env.AGENTCOMPASS_PYTHON, 'python3', 'python'].filter(Boolean)
    .find(exe => spawnSync(exe, ['-c', 'import sys'], {stdio: 'ignore'}).status === 0);
  const made = spawnSync(python, ['-X', 'utf8', fileURLToPath(new URL('make_launcher.py', import.meta.url)), dir, process.execPath, p.fake], {encoding: 'utf8'});
  assert.equal(made.status, 0, made.stderr);
  return made.stdout.trim();
}

function rpc(p, requests, env = {}) {
  const proc = spawnSync(process.execPath, [path.join(p.out, 'worker.cjs')], {
    input: requests.map(r => JSON.stringify({jsonrpc: '2.0', ...r}) + '\n').join(''),
    env: {...process.env, PASEO_AGENT_ID: 'stale-paseo', HC_TERMINAL_ID: 'stale-terminal', ROUTER_CINDY_CONTEXT: 'stale',
          HOME: p.home, USERPROFILE: p.home, ...env},
    encoding: 'utf8', timeout: 30000,
  });
  assert.equal(proc.status, 0, proc.stderr);
  return proc.stdout.trim().split('\n').map(line => JSON.parse(line));
}

const native = bundle => ({status: 'native', parent_id: 'true-session', parent_host: 'native',
  route: {bundle}, worker_prompt_file: '@PROMPT'});

test('the public roll command gets the host session as a native parent, the whole task on stdin and a scrubbed env', () => {
  const p = plugin(native({provider: 'codex', harness: 'codex', account: 'codex', model: 'gpt-test', effort: 'high'}));
  const prepare = id => ({id, method: 'prepare', params: {task: 'full assignment 原文\r\n', context: ctx(p.root)}});
  const replies = rpc(p, [prepare(1), prepare(2)]);
  assert.equal(replies[0].result.operation, replies[1].result.operation);
  const seen = JSON.parse(fs.readFileSync(p.capture, 'utf8'));
  assert.deepEqual(seen.argv, ['--parent-host', 'native', '--parent-id', 'true-session', '--parent-address', 'true-session',
    '--local-only', seen.argv[7], '--task', '-', '--verbose']);
  assert.match(seen.argv[7], /local project directory/);
  assert.equal(seen.stdin, 'full assignment 原文\r\n');
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(p.root));
  assert.deepEqual([seen.paseo, seen.hc, seen.legacy], [null, null, null]);
});

test('fleet bundles without modeId get the explicit launcher default and the Cindy return channel', () => {
  for (const [harness, mode] of [['codex', 'full-access'], ['claude', 'bypassPermissions'], ['pi', 'full-access']]) {
    const p = plugin(native({provider: harness, harness, account: harness, model: 'm', effort: 'high'}));
    const [reply] = rpc(p, [{id: 1, method: 'prepare', params: {task: 'x', context: ctx(p.root)}}]);
    assert.equal(reply.result.bundle.modeId, mode, harness);
    assert.equal(reply.result.bundle.harness, harness);
    const original = fs.readFileSync(p.prompt, 'utf8');
    assert.ok(reply.result.prompt.startsWith(original), 'the router prompt is kept byte for byte');
    assert.match(reply.result.prompt.slice(original.length), /Cindy plugin task return channel/);
  }
});

test('an explicitly restricted mode or a harness Cindy cannot run is refused and leaves no receipt', () => {
  for (const bundle of [{provider: 'codex', harness: 'codex', account: 'codex', model: 'm', modeId: 'read-only'},
                        {provider: 'agy', harness: 'antigravity-resilient', account: 'agy', model: 'm'}]) {
    const p = plugin(native(bundle));
    const [reply] = rpc(p, [{id: 1, method: 'prepare', params: {task: 'x', context: ctx(p.root)}}]);
    assert.ok(reply.error, JSON.stringify(reply));
    assert.match(reply.error.message, /read-only|cannot run routed harness/);
    const receipts = fs.readdirSync(p.state, {recursive: true}).filter(f => String(f).endsWith('receipt.json'));
    assert.deepEqual(receipts, []);
  }
});

test('self and split are recorded as the router answer; a blocked router is an error', () => {
  for (const status of ['self', 'split']) {
    const p = plugin({status, next_action: 'do it'}, 2);
    const [reply] = rpc(p, [{id: 1, method: 'prepare', params: {task: 'x', context: ctx(p.root)}}]);
    assert.equal(reply.result.router.status, status);
    assert.equal(reply.result.bundle, null);
  }
  const p = plugin({status: 'blocked', error: 'no account'}, 2);
  const [reply] = rpc(p, [{id: 1, method: 'prepare', params: {task: 'x', context: ctx(p.root)}}]);
  assert.match(reply.error.message, /no account/);
});

test('an untrusted context and a foreign session are refused before the router runs', () => {
  const p = plugin(native({provider: 'codex', harness: 'codex', account: 'codex', model: 'm'}));
  const bad = [{...ctx(p.root), workdir_is_local: false}, {...ctx(p.root), workdir_is_read_only: true}, {...ctx(p.root), workdir: 'relative'}, null];
  const replies = rpc(p, bad.map((context, i) => ({id: i + 1, method: 'prepare', params: {task: 'x', context}})));
  assert.ok(replies.every(r => r.error));
  assert.equal(fs.existsSync(p.capture), false);
  const [first] = rpc(p, [{id: 1, method: 'prepare', params: {task: 'x', context: ctx(p.root)}}]);
  const [foreign] = rpc(p, [{id: 2, method: 'load', params: {operation: first.result.operation, context: {...ctx(p.root), session_id: 'other'}}}]);
  assert.match(foreign.error.message, /different parent/);
});

// ---- zero configuration: the plugin directory exactly as the market installs it
const SYSTEM = process.platform === 'win32' ? [path.join(process.env.SYSTEMROOT || 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'];
const only = dirs => [...dirs, ...SYSTEM].join(path.delimiter);
const prepareX = (p, task = 'zero-config 原文') => ({id: 1, method: 'prepare', params: {task, context: ctx(p.root)}});
const codex = native({provider: 'codex', harness: 'codex', account: 'codex', model: 'm', effort: 'high'});

test('without router.json the worker starts, finds `agentcompass` on PATH and runs `<it> roll ...`', () => {
  const p = plugin(codex, 0, 'none');
  const bin = path.join(p.root, 'bin');
  const exe = launcher(p, bin);
  assert.equal(path.basename(exe), process.platform === 'win32' ? 'agentcompass.exe' : 'agentcompass');
  const [reply] = rpc(p, [prepareX(p)], {PATH: only([bin])});
  assert.equal(reply.result?.router?.status, 'native', JSON.stringify(reply));
  const seen = JSON.parse(fs.readFileSync(p.capture, 'utf8'));
  assert.deepEqual(seen.argv.slice(0, 4), ['roll', '--parent-host', 'native', '--parent-id']);
  assert.equal(seen.stdin, 'zero-config 原文');
  assert.deepEqual(reply.result.mappings, []);
  assert.ok(fs.existsSync(path.join(p.state, reply.result.operation, 'receipt.json')), 'receipts default to ~/.agent-compass/cindy-plugin');
});

test('not on PATH: ~/.local/bin, where uv tool install puts it, is found', () => {
  const p = plugin(codex, 0, 'none');
  launcher(p, path.join(p.home, '.local', 'bin'));
  const [reply] = rpc(p, [prepareX(p)], {PATH: only([])});
  assert.equal(reply.result?.router?.status, 'native', JSON.stringify(reply));
});

test('AgentCompass nowhere: a clear error, no receipt, and the worker keeps serving', () => {
  const p = plugin(codex, 0, 'none');
  const replies = rpc(p, [prepareX(p), {id: 2, method: 'load', params: {operation: 'f'.repeat(40), context: ctx(p.root)}}], {PATH: only([])});
  assert.match(replies[0].error.message, /AgentCompass was not found.*PATH.*\.local/s);
  assert.equal(replies[1].id, 2, 'the worker answered the next request');
  assert.equal(fs.existsSync(p.capture), false);
  assert.deepEqual(fs.readdirSync(p.state, {recursive: true}).filter(f => String(f).endsWith('receipt.json')), []);
});

test('~/.agent-compass/cindy-plugin/account-map.json supplies the Cindy connection bindings; a malformed one is refused', () => {
  const p = plugin(codex, 0, 'none');
  const bin = path.join(p.root, 'bin');
  launcher(p, bin);
  const rows = [{routerProvider: 'pi', routerAccount: 'codex', providerId: 'openai-conn', agentKind: 'pi'}];
  const map = path.join(p.home, '.agent-compass', 'cindy-plugin', 'account-map.json');
  fs.writeFileSync(map, JSON.stringify(rows));
  const [reply] = rpc(p, [prepareX(p)], {PATH: only([bin])});
  assert.deepEqual(reply.result.mappings, rows);
  fs.writeFileSync(map, JSON.stringify([{routerProvider: 'pi', agentKind: 'gpt'}]));
  const [bad] = rpc(p, [prepareX(p, 'another task')], {PATH: only([bin])});
  assert.match(bad.error.message, /account-map\.json must be a JSON array/);
});

test('~/.agent-compass/cindy-plugin/router.json is used when the plugin has none; the plugin router.json wins', () => {
  const p = plugin(codex, 0, 'home');
  const [reply] = rpc(p, [prepareX(p)], {PATH: only([])});
  assert.equal(reply.result?.router?.status, 'native', JSON.stringify(reply));
  assert.ok(fs.existsSync(path.join(p.state, reply.result.operation, 'receipt.json')), 'its stateRoot is honoured');
  fs.writeFileSync(path.join(p.out, 'router.json'), JSON.stringify({command: [process.execPath, '-e', 'process.exit(3)'], stateRoot: path.join(p.root, 'own')}));
  const [own] = rpc(p, [prepareX(p)], {PATH: only([])});
  assert.match(own.error.message, /Router returned no usable route/);
  assert.ok(fs.existsSync(path.join(p.root, 'own')), 'the plugin router.json was used');
  fs.writeFileSync(path.join(p.out, 'router.json'), '{broken');
  const [broken] = rpc(p, [prepareX(p)], {PATH: only([])});
  assert.match(broken.error.message, /Unreadable plugin configuration/);
});
