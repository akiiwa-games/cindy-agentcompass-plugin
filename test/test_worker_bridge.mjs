// The real worker.cjs as a node child speaking JSON-RPC over stdio, with a recording stand-in for the public router.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {spawnSync} from 'node:child_process';

const PLUGIN = new URL('../plugin/', import.meta.url);
const ctx = dir => ({session_id: 'true-session', workdir: dir, workdir_is_local: true, workdir_is_read_only: false});

// One plugin directory whose router.json runs a fake router that records argv, stdin and environment and prints `answer`.
function plugin(answer, code = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-bridge-'));
  const out = path.join(root, 'plugin');
  fs.mkdirSync(out);
  for (const name of ['ghost.json', 'main.js', 'worker.cjs']) fs.copyFileSync(new URL(name, PLUGIN), path.join(out, name));
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
  fs.writeFileSync(path.join(out, 'router.json'), JSON.stringify({command: [process.execPath, fake], stateRoot: path.join(root, 'state')}));
  return {root, out, prompt, capture};
}

function rpc(p, requests, env = {}) {
  const proc = spawnSync(process.execPath, [path.join(p.out, 'worker.cjs')], {
    input: requests.map(r => JSON.stringify({jsonrpc: '2.0', ...r}) + '\n').join(''),
    env: {...process.env, PASEO_AGENT_ID: 'stale-paseo', HC_TERMINAL_ID: 'stale-terminal', ROUTER_CINDY_CONTEXT: 'stale', ...env},
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
    const receipts = fs.readdirSync(path.join(p.root, 'state'), {recursive: true}).filter(f => String(f).endsWith('receipt.json'));
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
