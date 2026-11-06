// The real worker.cjs as a node child speaking JSON-RPC over stdio: the built-in engine over a real Cindy catalog, and a
// recording stand-in for the external `agentcompass roll`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const PLUGIN = new URL('../plugin/', import.meta.url);
const CATALOG = JSON.parse(fs.readFileSync(new URL('./fixtures/cindy-0.1.121-catalog.json', import.meta.url), 'utf8'));
const ctx = dir => ({session_id: 'true-session', workdir: dir, workdir_is_local: true, workdir_is_read_only: false});

const roots = [];
process.on('exit', () => {for (const root of roots) fs.rmSync(root, {recursive: true, force: true});});

// One plugin directory with a fake router that records argv, stdin and environment and prints `answer`. `config`:
//   'plugin' router.json next to worker.cjs (scripts/build_plugin.py), 'home' ~/.agent-compass/cindy-plugin/router.json,
//   'none' no configuration at all (a market install), 'cli' ~/.agent-compass/cindy-plugin/config.json {"engine":"cli"}.
// A task containing SLOW makes the fake router take two seconds.
function plugin(answer, code = 0, config = 'plugin') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-bridge-'));
  roots.push(root);
  const out = path.join(root, 'plugin');
  fs.mkdirSync(out);
  fs.cpSync(fileURLToPath(PLUGIN), out, {recursive: true});
  fs.rmSync(path.join(out, 'router.json'), {force: true});
  const home = path.join(root, 'home');
  const stateHome = path.join(home, '.agent-compass', 'cindy-plugin');
  fs.mkdirSync(stateHome, {recursive: true});
  const prompt = path.join(root, 'prompt.md');
  fs.writeFileSync(prompt, Buffer.from('unchanged 原文\r\nall lines', 'utf8'));
  const capture = path.join(root, 'captured.json'), calls = path.join(root, 'calls.log');
  const answerFile = path.join(root, 'answer.json');
  fs.writeFileSync(answerFile, JSON.stringify(answer).replace('"@PROMPT"', () => JSON.stringify(prompt)));
  const fake = path.join(root, 'fake-router.cjs');
  fs.writeFileSync(fake, `
const fs=require('node:fs');const chunks=[];
process.stdin.on('data',d=>chunks.push(d)).on('end',()=>{
  const stdin=Buffer.concat(chunks).toString('utf8');
  fs.appendFileSync(${JSON.stringify(calls)},'call\\n');
  fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({argv:process.argv.slice(2),stdin,
    cwd:process.cwd(),paseo:process.env.PASEO_AGENT_ID??null,hc:process.env.HC_TERMINAL_ID??null,legacy:process.env.ROUTER_CINDY_CONTEXT??null}));
  setTimeout(()=>{process.stdout.write(fs.readFileSync(${JSON.stringify(answerFile)},'utf8'));if(stdin.includes('HANG')){setInterval(()=>{},1000);return;}process.exit(${code});},stdin.includes('SLOW')?2000:0);
});`);
  const settings = {command: [process.execPath, fake], stateRoot: path.join(root, 'state')};
  if (config === 'plugin') fs.writeFileSync(path.join(out, 'router.json'), JSON.stringify(settings));
  if (config === 'home') fs.writeFileSync(path.join(stateHome, 'router.json'), JSON.stringify(settings));
  if (config === 'cli') fs.writeFileSync(path.join(stateHome, 'config.json'), JSON.stringify({engine: 'cli'}));
  const routerCalls = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0;
  return {root, out, prompt, capture, home, fake, stateHome, routerCalls,
    state: ['plugin', 'home'].includes(config) ? settings.stateRoot : stateHome};
}

// An installed `agentcompass` command (a native .exe on Windows, as pip/uv write them) that runs the fake router.
function launcher(p, dir) {
  const python = [process.env.AGENTCOMPASS_PYTHON, 'python3', 'python'].filter(Boolean)
    .find(exe => spawnSync(exe, ['-c', 'import sys'], {stdio: 'ignore'}).status === 0);
  const made = spawnSync(python, ['-X', 'utf8', fileURLToPath(new URL('make_launcher.py', import.meta.url)), dir, process.execPath, p.fake], {encoding: 'utf8'});
  assert.equal(made.status, 0, made.stderr);
  return made.stdout.trim();
}

const SYSTEM = process.platform === 'win32' ? [path.join(process.env.SYSTEMROOT || 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'];
const only = dirs => [...dirs, ...SYSTEM].join(path.delimiter);
// Requests are written at once and answered concurrently: replies come back in completion order (`order`), and are
// also returned sorted by id.
function rpc(p, requests, env = {}) {
  const proc = spawnSync(process.execPath, [path.join(p.out, 'worker.cjs')], {
    input: requests.map(r => JSON.stringify({jsonrpc: '2.0', ...r}) + '\n').join(''),
    env: {...process.env, PASEO_AGENT_ID: 'stale-paseo', HC_TERMINAL_ID: 'stale-terminal', ROUTER_CINDY_CONTEXT: 'stale',
          HOME: p.home, USERPROFILE: p.home, CODEX_HOME: path.join(p.home, '.codex'), PATH: only([]), ...env},
    encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(proc.status, 0, proc.stderr);
  const order = proc.stdout.trim().split('\n').map(line => JSON.parse(line));
  const replies = [...order].sort((a, b) => a.id - b.id);
  replies.order = order.map(r => r.id);
  return replies;
}
const prepare = (p, task, id = 1, catalog = CATALOG, extra = {}) => ({id, method: 'prepare', params: {task, catalog, context: ctx(p.root), ...extra}});
const receipts = p => fs.existsSync(p.state) ? fs.readdirSync(p.state, {recursive: true}).filter(f => String(f).endsWith('receipt.json')) : [];
const makeProfile = (overrides = {}) => ({
  work_kind: 'general_implementation',
  interaction_style: 'engineering',
  reasoning_depth: 2,
  code_complexity: 1,
  context_scale: 1,
  divergence: 1,
  hallucination_risk: 1,
  error_cost: 2,
  needs_visual: false,
  needs_gui: false,
  local_only: true,
  realtime_loop: false,
  expected_hours: 0.5,
  hours_confidence: 'medium',
  urgency: 'normal',
  multi_task: false,
  task_count: '1',
  self: false,
  wants_fast: false,
  reason: 'classified by built-in classifier',
  ...overrides,
});
const withProfile = (overrides = {}) => ({profile: makeProfile(overrides)});
const classified = (overrides = {}, model = 'chatgpt/gpt-5.3-codex-spark', attemptId = undefined) => ({
  classification: {
    ok: true,
    model,
    ...(attemptId ? {attemptId} : {}),
    rawOutput: JSON.stringify(makeProfile(overrides)),
  },
});

const native = bundle => ({status: 'native', parent_id: 'true-session', parent_host: 'native',
  route: {bundle}, worker_prompt_file: '@PROMPT'});
const codex = native({provider: 'codex', harness: 'codex', account: 'codex', model: 'm', effort: 'high'});

// ---- the default: the built-in engine, nothing installed or configured
test('zero configuration: the built-in engine routes over the catalog Cindy passed, with no AgentCompass anywhere', () => {
  const p = plugin(codex, 0, 'none');
  const task = 'Rename the helper foo to bar in util.py and update its two callers.\r\n原文';
  // Phase 1: classifyViaHost asks the Cindy logic page to run the fast catalog classifier model.
  const [askClf] = rpc(p, [prepare(p, task, 1, CATALOG, {classifyViaHost: true})]);
  assert.equal(askClf.result?.state, 'classify');
  assert.equal(askClf.result?.classifier?.model, 'chatgpt/gpt-5.3-codex-spark');
  assert.equal(askClf.result?.classifier?.route?.effort, 'minimal');
  assert.equal(typeof askClf.result?.classifier?.attemptId, 'string');
  // Phase 2: classification result is validated against the pending attempt, cached to score-cache.json, and routed.
  const [reply] = rpc(p, [prepare(p, task, 1, CATALOG, {
    ...classified({realtime_loop: true}, askClf.result.classifier.model, askClf.result.classifier.attemptId),
    classifyViaHost: true,
  })]);
  assert.equal(reply.result?.router?.status, 'native', JSON.stringify(reply));
  assert.equal(reply.result.engine, 'builtin');
  assert.equal(reply.result.router.decision.profile_source, 'classifier');
  assert.equal(reply.result.router.decision.classifier_model, 'chatgpt/gpt-5.3-codex-spark');
  assert.equal(reply.result.router.decision.realtime_loop, true);
  // A second session rolling the identical task text hits score-cache.json directly without a second classification step.
  const [cachedReply] = rpc(p, [{
    id: 9,
    method: 'prepare',
    params: {task, catalog: CATALOG, classifyViaHost: true, context: {...ctx(p.root), session_id: 'second-session'}},
  }]);
  assert.equal(cachedReply.result?.state, 'prepared');
  assert.equal(cachedReply.result?.router?.decision?.classifier_cached, true);
  const b = reply.result.bundle;
  assert.ok(CATALOG.models.some(row => row.route.agentKind === b.harness && row.route.providerId === b.providerId &&
    row.route.model === b.model && row.efforts.includes(b.effort)), 'the route is a real catalog row: ' + JSON.stringify(b));
  assert.equal(b.modeId, 'full-access');
  assert.ok(reply.result.prompt.startsWith(task), 'the assignment is sent unchanged');
  assert.match(reply.result.prompt.slice(task.length), /Cindy plugin task return channel/);
  assert.equal(p.routerCalls(), 0);
  assert.ok(fs.existsSync(path.join(p.stateHome, 'score-cache.json')), 'score-cache.json is persisted');
  assert.ok(fs.existsSync(path.join(p.stateHome, reply.result.operation, 'router.stdout.json')), 'the decision is kept with the receipt');
  // Chunked output transfers reassemble in worker.cjs and write the full transcript page.
  const op = reply.result.operation;
  const fullPage = {items: [{id: 'out-1', role: 'assistant', content: 'chunked-body'}], nextCursor: null};
  const rawPage = JSON.stringify(fullPage);
  const outReplies = rpc(p, [
    {id: 2, method: 'output', params: {operation: op, stream: op + ':end:2', index: 0, chunk: rawPage.slice(0, 15), done: false, context: ctx(p.root)}},
    {id: 3, method: 'output', params: {operation: op, stream: op + ':end:2', index: 1, chunk: rawPage.slice(15), done: true, context: ctx(p.root)}},
  ]);
  assert.equal(outReplies[0].result.partial, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(outReplies[1].result.artifact, 'utf8')), fullPage);
});

test('a route Cindy refused to create on cools down for the retry; a request refusal does not; a created task clears it', () => {
  const p = plugin(codex, 0, 'none');
  const task = 'Rename the helper foo to bar in util.py and update its two callers.';
  const [ask] = rpc(p, [prepare(p, task, 1, CATALOG, {classifyViaHost: true})]);
  const [first] = rpc(p, [prepare(p, task, 1, CATALOG, classified({}, ask.result.classifier.model, ask.result.classifier.attemptId))]);
  const op = first.result.operation, b = first.result.bundle;
  const {operation, ...prepared} = first.result;
  const save = (id, record) => ({id, method: 'save', params: {operation: op, record, context: ctx(p.root)}});
  const creating = {...prepared, state: 'creating'};
  const refused = code => ({...prepared, state: 'prepared', createRejected: true, errorCode: code, error: code, task});
  const file = path.join(p.stateHome, 'route-cooldowns.json');
  rpc(p, [save(1, creating), save(2, refused('INVALID_REQUEST'))]);
  assert.equal(fs.existsSync(file), false, 'a malformed request says nothing about the route');
  rpc(p, [save(1, creating), save(2, refused('ROUTE_UNAVAILABLE'))]);
  const [entry] = Object.values(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.deepEqual([entry.code, entry.failures], ['ROUTE_UNAVAILABLE', 1]);
  assert.ok(Math.abs(entry.until - Date.now() - 15 * 60000) < 60000);
  const [retry] = rpc(p, [prepare(p, task, 1, CATALOG, {classifyViaHost: true})]);
  const moved = retry.result.bundle;
  assert.notEqual(moved.providerId + moved.model, b.providerId + b.model, 'the retry routes elsewhere');
  assert.equal(retry.result.router.decision.cooling_down[0].model, b.model);
  rpc(p, [save(1, creating), save(2, refused('ROUTE_UNAVAILABLE'))]);
  assert.equal(Object.values(JSON.parse(fs.readFileSync(file, 'utf8')))[0].failures, 2, 'a consecutive refusal doubles the cooldown');
  rpc(p, [save(1, creating), save(2, {...creating, state: 'sending', taskId: 'child-task'})]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {}, 'a task created on the route clears it');
});

test('built-in split, self, Pi for exploration and fast mode with fresh Codex quota telemetry', () => {
  const p = plugin(codex, 0, 'none');
  const sessions = path.join(p.home, '.codex', 'sessions', '2026', '11', '03');
  fs.mkdirSync(sessions, {recursive: true});
  fs.writeFileSync(path.join(sessions, 'rollout-x.jsonl'), JSON.stringify({type: 'event_msg', payload: {type: 'token_count',
    rate_limits: {primary: {used_percent: 12, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600}, secondary: null, plan_type: 'pro'}}}) + '\n');
  const replies = rpc(p, [
    prepare(p, 'Two independent tasks:\n1. Add a dark theme to the settings page.\n2. Fix the CSV export encoding bug in report.py.', 1, CATALOG, withProfile({multi_task: true, task_count: '2'})),
    prepare(p, 'What is the difference between a mutex and a semaphore?', 2, CATALOG, withProfile({self: true})),
    prepare(p, 'Investigate why the login request fails: trace it through logs/ and the auth module and report the findings only.', 3, CATALOG, withProfile({work_kind: 'exploration_analysis', interaction_style: 'exploration', code_complexity: 0})),
    prepare(p, 'Use fast mode: rename the helper foo to bar in util.py and update its two callers.', 4, CATALOG, withProfile({work_kind: 'general_implementation', urgency: 'high', wants_fast: true})),
  ]);
  assert.deepEqual([replies[0].result.router.status, replies[0].result.router.task_count, replies[0].result.bundle], ['split', '2', null]);
  assert.deepEqual([replies[1].result.router.status, replies[1].result.bundle], ['self', null]);
  assert.equal(replies[2].result.bundle.harness, 'pi');
  assert.deepEqual([replies[3].result.bundle.harness, replies[3].result.bundle.fast], ['codex', true]);
  assert.equal(replies[3].result.router.decision.quota.used_percent, 12);
});

test('the built-in engine is the default even with `agentcompass` on PATH; an empty catalog is a clear error', () => {
  const p = plugin(codex, 0, 'none');
  const bin = path.join(p.root, 'bin');
  launcher(p, bin);
  const replies = rpc(p, [prepare(p, 'Rename foo to bar in util.py.', 1, CATALOG, withProfile()), prepare(p, 'Rename baz to qux in util.py.', 2, {models: []}, withProfile()),
    {id: 3, method: 'load', params: {operation: 'f'.repeat(40), context: ctx(p.root)}}], {PATH: only([bin])});
  assert.equal(replies[0].result.engine, 'builtin');
  assert.equal(p.routerCalls(), 0, 'the CLI is used only when configured');
  assert.match(replies[1].error.message, /no Claude, Codex or Pi model/);
  assert.equal(replies[2].id, 3, 'the worker keeps serving');
  assert.equal(receipts(p).length, 1);
});

// ---- the external CLI: router.json, or config.json {"engine":"cli"}
test('router.json: the public roll command gets the host session as a native parent, the whole task on stdin and a scrubbed env', () => {
  const p = plugin(native({provider: 'codex', harness: 'codex', account: 'codex', model: 'gpt-test', effort: 'high'}));
  const replies = rpc(p, [prepare(p, 'full assignment 原文\r\n', 1), prepare(p, 'full assignment 原文\r\n', 2)]);
  assert.equal(replies[0].result.operation, replies[1].result.operation);
  assert.equal(replies[0].result.engine, 'cli');
  // One at a time per operation; a receipt that has no task yet is routed again by each prepare (see review 7).
  assert.equal(p.routerCalls(), 2);
  assert.equal(receipts(p).length, 1);
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
    const [reply] = rpc(p, [prepare(p, 'x')]);
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
    const [reply] = rpc(p, [prepare(p, 'x')]);
    assert.ok(reply.error, JSON.stringify(reply));
    assert.match(reply.error.message, /read-only|cannot run routed harness/);
    assert.deepEqual(receipts(p), []);
  }
});

test('self and split from the CLI are recorded as the router answer; a blocked router is an error', () => {
  for (const status of ['self', 'split']) {
    const p = plugin({status, next_action: 'do it'}, 2);
    const [reply] = rpc(p, [prepare(p, 'x')]);
    assert.equal(reply.result.router.status, status);
    assert.equal(reply.result.bundle, null);
  }
  const p = plugin({status: 'blocked', error: 'no account'}, 2);
  const [reply] = rpc(p, [prepare(p, 'x')]);
  assert.match(reply.error.message, /no account/); const hang = plugin(codex); fs.writeFileSync(path.join(hang.out, 'router.json'), JSON.stringify({command: [process.execPath, hang.fake], stateRoot: hang.state, timeoutMs: 150})); const [timedOut] = rpc(hang, [prepare(hang, 'HANG after writing native JSON')]); assert.match(timedOut.error.message, /Router timed out/); assert.deepEqual(receipts(hang), []);
});

test('an untrusted context and a foreign session are refused before the router runs', () => {
  const p = plugin(native({provider: 'codex', harness: 'codex', account: 'codex', model: 'm'}));
  const bad = [{...ctx(p.root), workdir_is_local: false}, {...ctx(p.root), workdir_is_read_only: true}, {...ctx(p.root), workdir: 'relative'}, null];
  const replies = rpc(p, bad.map((context, i) => ({id: i + 1, method: 'prepare', params: {task: 'x', context}})));
  assert.ok(replies.every(r => r.error));
  assert.equal(fs.existsSync(p.capture), false);
  const [first] = rpc(p, [prepare(p, 'x')]);
  const [foreign] = rpc(p, [{id: 2, method: 'load', params: {operation: first.result.operation, context: {...ctx(p.root), session_id: 'other'}}}]);
  assert.match(foreign.error.message, /different parent/);
});

test('config.json {"engine":"cli"}: `agentcompass` on PATH, then ~/.local/bin, runs as `<it> roll ...`', () => {
  const p = plugin(codex, 0, 'cli');
  const bin = path.join(p.root, 'bin');
  const exe = launcher(p, bin);
  assert.equal(path.basename(exe), process.platform === 'win32' ? 'agentcompass.exe' : 'agentcompass');
  const [reply] = rpc(p, [prepare(p, 'opt-in 原文')], {PATH: only([bin])});
  assert.equal(reply.result?.engine, 'cli', JSON.stringify(reply));
  const seen = JSON.parse(fs.readFileSync(p.capture, 'utf8'));
  assert.deepEqual(seen.argv.slice(0, 4), ['roll', '--parent-host', 'native', '--parent-id']);
  assert.equal(seen.stdin, 'opt-in 原文');
  const q = plugin(codex, 0, 'cli');
  launcher(q, path.join(q.home, '.local', 'bin'));
  const [local] = rpc(q, [prepare(q, 'x')]);
  assert.equal(local.result?.engine, 'cli', JSON.stringify(local));
});

test('config.json {"engine":"cli"} with AgentCompass not installed falls back to the built-in engine, no error', () => {
  const p = plugin(codex, 0, 'cli');
  const [reply] = rpc(p, [prepare(p, 'Rename foo to bar in util.py.', 1, CATALOG, withProfile())]);
  assert.equal(reply.result?.engine, 'builtin', JSON.stringify(reply));
  assert.match(reply.result.router.engine_note, /not installed: the built-in engine routed/);
  fs.writeFileSync(path.join(p.stateHome, 'config.json'), '{"engine":"gpt"}');
  const [bad] = rpc(p, [prepare(p, 'another')]);
  assert.match(bad.error.message, /Unreadable plugin configuration.*"engine" must be/);
  fs.writeFileSync(path.join(p.stateHome, 'config.json'), '{"classifierEffort":"extreme"}');
  const [badEffort] = rpc(p, [prepare(p, 'another')]);
  assert.match(badEffort.error.message, /Unreadable plugin configuration.*"classifierEffort" must be/);
});

test('~/.agent-compass/cindy-plugin/account-map.json supplies the CLI connection bindings; a malformed one is refused', () => {
  const p = plugin(codex, 0, 'cli');
  const bin = path.join(p.root, 'bin');
  launcher(p, bin);
  const rows = [{routerProvider: 'pi', routerAccount: 'codex', providerId: 'openai-conn', agentKind: 'pi'}];
  const map = path.join(p.stateHome, 'account-map.json');
  fs.writeFileSync(map, JSON.stringify(rows));
  const [reply] = rpc(p, [prepare(p, 'x')], {PATH: only([bin])});
  assert.deepEqual(reply.result.mappings, rows);
  fs.writeFileSync(map, JSON.stringify([{routerProvider: 'pi', agentKind: 'gpt'}]));
  const [bad] = rpc(p, [prepare(p, 'another task')], {PATH: only([bin])});
  assert.match(bad.error.message, /account-map\.json must be a JSON array/);
});

test('~/.agent-compass/cindy-plugin/router.json is used when the plugin has none; the plugin router.json wins', () => {
  const p = plugin(codex, 0, 'home');
  const [reply] = rpc(p, [prepare(p, 'x')]);
  assert.equal(reply.result?.router?.status, 'native', JSON.stringify(reply));
  assert.ok(fs.existsSync(path.join(p.state, reply.result.operation, 'receipt.json')), 'its stateRoot is honoured');
  fs.writeFileSync(path.join(p.out, 'router.json'), JSON.stringify({command: [process.execPath, '-e', 'process.exit(3)'], stateRoot: path.join(p.root, 'own')}));
  const [own] = rpc(p, [prepare(p, 'x')]);
  assert.match(own.error.message, /Router returned no usable route/);
  assert.ok(fs.existsSync(path.join(p.root, 'own')), 'the plugin router.json was used');
  fs.writeFileSync(path.join(p.out, 'router.json'), '{broken');
  const [broken] = rpc(p, [prepare(p, 'x')]);
  assert.match(broken.error.message, /Unreadable plugin configuration/);
});

// ---- regressions from the PR #274 review
test('review 6: a router that exits without reading stdin (EPIPE) fails that roll only; the shared worker keeps serving', () => {
  const p = plugin(codex);
  fs.writeFileSync(path.join(p.out, 'router.json'), JSON.stringify({command: [process.execPath, '-e', 'process.exit(0)'], stateRoot: p.state}));
  const huge = 'x'.repeat(8 * 1024 * 1024);
  const replies = rpc(p, [prepare(p, huge, 1), prepare(p, huge + 'again', 2), {id: 3, method: 'load', params: {operation: 'f'.repeat(40), context: ctx(p.root)}}]);
  for (const reply of replies.slice(0, 2)) assert.match(reply.error.message, /Router returned no usable route/);
  assert.match(replies[2].error.message, /ENOENT|no such file/, 'the third request was still answered');
  assert.deepEqual(receipts(p), []);
});

test('review 7: a receipt still `prepared` is routed again with the current account map, so a fixed map unblocks the retry', () => {
  const p = plugin(native({provider: 'pi', harness: 'pi', account: 'codex', model: 'gpt-6.1-sol', effort: 'high'}), 0, 'cli');
  const bin = path.join(p.root, 'bin');
  launcher(p, bin);
  const [first] = rpc(p, [prepare(p, 'x')], {PATH: only([bin])});
  assert.deepEqual(first.result.mappings, []);
  const rows = [{routerProvider: 'pi', routerAccount: 'codex', providerId: 'openai', agentKind: 'pi'}];
  fs.writeFileSync(path.join(p.stateHome, 'account-map.json'), JSON.stringify(rows));
  const [retry] = rpc(p, [prepare(p, 'x')], {PATH: only([bin])});
  assert.equal(retry.result.operation, first.result.operation);
  assert.deepEqual(retry.result.mappings, rows);
  assert.equal(retry.result.attempts, 2);
  assert.equal(p.routerCalls(), 2, 'routed again');
  // Once the task exists the receipt is final: no re-routing.
  const file = path.join(p.stateHome, first.result.operation, 'receipt.json');
  fs.writeFileSync(file, JSON.stringify({...JSON.parse(fs.readFileSync(file, 'utf8')), state: 'running', taskId: 't', runId: 'r'}));
  const [later] = rpc(p, [prepare(p, 'x')], {PATH: only([bin])});
  assert.deepEqual([later.result.state, p.routerCalls()], ['running', 2]);
});

test('review 5: a slow route for one session does not hold up another operation in the shared worker', () => {
  const p = plugin(codex);
  const [done] = rpc(p, [prepare(p, 'quick one')]);
  const replies = rpc(p, [prepare(p, 'SLOW route', 1), {id: 2, method: 'load', params: {operation: done.result.operation, context: ctx(p.root)}}]);
  assert.equal(replies[1].result.state, 'prepared');
  assert.equal(replies[0].result.router.status, 'native');
  assert.deepEqual(replies.order, [2, 1], 'the load was answered while the route was still running');
});

test('B1 & M3 regression: two-phase classification handshake verifies pending attempt/task/model and blocked classification never writes prepared receipt.json', () => {
  const p = plugin(codex, 0, 'none');
  const task = 'Implement retry backoff in client.ts';

  // 1. Unsolicited classification (without a preceding classifyViaHost phase) is rejected as blocked and writes no receipt.json.
  const [unsolicited] = rpc(p, [prepare(p, task, 1, CATALOG, classified())]);
  assert.equal(unsolicited.result?.state, 'blocked');
  assert.equal(unsolicited.result?.router?.status, 'blocked');
  assert.equal(unsolicited.result?.router?.decision?.reason, 'unsolicited_or_mismatched_classification');
  assert.deepEqual(receipts(p), [], 'M3: blocked unsolicited classification writes no receipt.json');

  // 2. Phase 1 mints a unique attemptId; if classification fails (e.g. timeout), state is blocked, no receipt.json is written,
  // and the next Phase 1 call increments the attempt counter and mints a fresh attemptId (B1).
  const [ask1] = rpc(p, [prepare(p, task, 2, CATALOG, {classifyViaHost: true})]);
  assert.equal(ask1.result?.state, 'classify');
  const attemptId1 = ask1.result.classifier.attemptId;
  assert.equal(typeof attemptId1, 'string');

  const [failedClf] = rpc(p, [prepare(p, task, 3, CATALOG, {
    classifyViaHost: true,
    classification: {
      ok: false,
      attemptId: attemptId1,
      model: ask1.result.classifier.model,
      route: ask1.result.classifier.route,
      reason: 'timeout',
      error: 'Classifier timed out after 15000ms',
    },
  })]);
  assert.equal(failedClf.result?.state, 'blocked');
  assert.equal(failedClf.result?.router?.status, 'blocked');
  assert.equal(failedClf.result?.router?.decision?.reason, 'timeout');
  assert.deepEqual(receipts(p), [], 'M3: failed classification leaves no prepared receipt.json');

  // Replaying a classification for the already-consumed attemptId1 is rejected.
  const [replayed] = rpc(p, [prepare(p, task, 4, CATALOG, classified({}, ask1.result.classifier.model, attemptId1))]);
  assert.equal(replayed.result?.state, 'blocked');
  assert.equal(replayed.result?.router?.decision?.reason, 'unsolicited_or_mismatched_classification');
  assert.deepEqual(receipts(p), []);

  // 3. Retrying Phase 1 on the same task mints a new attemptId (B1); mismatched model/attemptId is rejected; matching attemptId succeeds.
  const [ask2] = rpc(p, [prepare(p, task, 5, CATALOG, {classifyViaHost: true})]);
  assert.equal(ask2.result?.state, 'classify');
  const attemptId2 = ask2.result.classifier.attemptId;
  assert.notEqual(attemptId2, attemptId1, 'B1: retry mints a fresh attemptId');

  const [wrongAttempt] = rpc(p, [prepare(p, task, 6, CATALOG, classified({}, ask2.result.classifier.model, attemptId1))]);
  assert.equal(wrongAttempt.result?.state, 'blocked');
  assert.equal(wrongAttempt.result?.router?.decision?.reason, 'unsolicited_or_mismatched_classification');

  const [ask3] = rpc(p, [prepare(p, task, 7, CATALOG, {classifyViaHost: true})]);
  const attemptId3 = ask3.result.classifier.attemptId;
  const [okReply] = rpc(p, [prepare(p, task, 8, CATALOG, classified({}, ask3.result.classifier.model, attemptId3))]);
  assert.equal(okReply.result?.state, 'prepared');
  assert.equal(okReply.result?.router?.status, 'native');
  assert.equal(receipts(p).length, 1);
});

test('m2 & m4 regression: config.json validation matches README (efforts none/off/ultra, timeout 100..120000, non-empty classifierModels) and no_model_meets_floor returns structured blocked', () => {
  const p = plugin(codex, 0, 'none');

  // m2: efforts none, off, ultra are accepted in config.json.
  for (const effort of ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    fs.writeFileSync(path.join(p.stateHome, 'config.json'), JSON.stringify({classifierEffort: effort, classifierTimeoutMs: 5000}));
    const [ok] = rpc(p, [prepare(p, `Task for effort ${effort}`, 1, CATALOG, withProfile())]);
    assert.equal(ok.result?.router?.status, 'native', `classifierEffort=${effort} should be accepted`);
  }

  // m2: classifierTimeoutMs outside 100..120000 is rejected.
  for (const badTimeout of [0, 50, 99, 120001, -10, '1000']) {
    fs.writeFileSync(path.join(p.stateHome, 'config.json'), JSON.stringify({classifierTimeoutMs: badTimeout}));
    const [bad] = rpc(p, [prepare(p, 'Task with bad timeout', 1, CATALOG, withProfile())]);
    assert.match(bad.error?.message || '', /classifierTimeoutMs.*100.*120000/);
  }

  // m2: empty classifierModels array is rejected.
  fs.writeFileSync(path.join(p.stateHome, 'config.json'), JSON.stringify({classifierModels: []}));
  const [emptyModels] = rpc(p, [prepare(p, 'Task with empty classifierModels', 1, CATALOG, withProfile())]);
  assert.match(emptyModels.error?.message || '', /classifierModels.*non-empty array/);

  // Reset config.json and verify m4: when no catalog model meets the capability floor, worker.cjs returns structured blocked (not an RPC error).
  fs.rmSync(path.join(p.stateHome, 'config.json'), {force: true});
  const minimalOnlyCatalog = {
    models: [
      {route: {agentKind: 'pi', providerId: 'openai', model: 'chatgpt/gpt-5.3-codex-spark', effort: 'minimal', fastMode: false}, efforts: ['minimal'], supportsFastMode: false},
    ],
  };
  const [floorBlocked] = rpc(p, [prepare(p, 'Prove formal distributed consensus safety.', 1, minimalOnlyCatalog, withProfile({
    work_kind: 'direction_reasoning',
    interaction_style: 'advisory',
    reasoning_depth: 4,
    code_complexity: 3,
    context_scale: 3,
    hallucination_risk: 3,
    error_cost: 3,
  }))]);
  assert.equal(floorBlocked.error, undefined, 'm4: no_model_meets_floor does not throw an RPC error');
  assert.equal(floorBlocked.result?.state, 'blocked');
  assert.equal(floorBlocked.result?.router?.status, 'blocked');
  assert.equal(floorBlocked.result?.router?.decision?.reason, 'no_model_meets_floor');
});
