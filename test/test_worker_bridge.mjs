// The real worker.cjs as a node child speaking JSON-RPC over stdio: the built-in engine over a real Cindy catalog, and a
// recording stand-in for the external `agentcompass roll`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {BASE_TASK, KEYWORD_CORPUS} from './task_text_corpus.mjs';

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
          HOME: p.home, USERPROFILE: p.home, CODEX_HOME: path.join(p.home, '.codex'),
          APPDATA: path.join(p.home, 'AppData'), XDG_CONFIG_HOME: path.join(p.home, 'AppData'), PATH: only([]), ...env},
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
const QUICK_MODEL = 'openai/fixture-quick-text';
const classified = (overrides = {}, attemptId = undefined) => ({
  classification: {
    ok: true,
    model: QUICK_MODEL,
    ...(attemptId ? {attemptId} : {}),
    rawOutput: JSON.stringify(makeProfile(overrides)),
  },
});
const refusedBy = (reason, attemptId) => ({classification: {ok: false, attemptId, reason, error: `Cindy refused: ${reason}`}});
// The two phases the logic page runs: ask, then bring back the answer.
function classifyWith(p, task, answer, context = ctx(p.root)) {
  const params = {task, catalog: CATALOG, classifyViaHost: true, context};
  const [ask] = rpc(p, [{id: 1, method: 'prepare', params}]);
  assert.equal(ask.result?.state, 'classify', JSON.stringify(ask));
  const [reply] = rpc(p, [{id: 2, method: 'prepare', params: {...params, ...answer(ask.result.classifier.attemptId)}}]);
  return reply;
}
const classifierCooldownsOf = p => JSON.parse(fs.readFileSync(path.join(p.stateHome, 'classifier-cooldowns.json'), 'utf8'));
function expireClassifierCooldowns(p) {
  const file = path.join(p.stateHome, 'classifier-cooldowns.json');
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(classifierCooldownsOf(p)).map(([key, entry]) => [key, {...entry, until: Date.now() - 1}]))));
}

const native = bundle => ({status: 'native', parent_id: 'true-session', parent_host: 'native',
  route: {bundle}, worker_prompt_file: '@PROMPT'});
const codex = native({provider: 'codex', harness: 'codex', account: 'codex', model: 'm', effort: 'high'});

// ---- the default: the built-in engine, nothing installed or configured
test('zero configuration: the built-in engine routes over the catalog Cindy passed, with no AgentCompass anywhere', () => {
  const p = plugin(codex, 0, 'none');
  const task = 'Rename the helper foo to bar in util.py and update its two callers.\r\n原文';
  // Phase 1: classifyViaHost asks the Cindy logic page to put the prompt to the quick-text channel; Cindy picks the model.
  const [askClf] = rpc(p, [prepare(p, task, 1, CATALOG, {classifyViaHost: true})]);
  assert.equal(askClf.result?.state, 'classify');
  assert.deepEqual(Object.keys(askClf.result.classifier).sort(), ['attemptId', 'prompt', 'timeoutMs']);
  assert.equal(typeof askClf.result.classifier.attemptId, 'string');
  assert.ok(askClf.result.classifier.prompt.length <= 32768);
  assert.equal(askClf.result.classifier.timeoutMs, 65000);
  // Phase 2: classification result is validated against the pending attempt, cached to score-cache.json, and routed.
  const [reply] = rpc(p, [prepare(p, task, 1, CATALOG, {
    ...classified({realtime_loop: true}, askClf.result.classifier.attemptId),
    classifyViaHost: true,
  })]);
  assert.equal(reply.result?.router?.status, 'native', JSON.stringify(reply));
  assert.equal(reply.result.engine, 'builtin');
  assert.equal(reply.result.router.decision.profile_source, 'classifier');
  assert.equal(reply.result.router.decision.classifier_model, QUICK_MODEL);
  assert.deepEqual(reply.result.router.decision.classifier_calibration_cases, {included: 47, total: 47});
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
  const [first] = rpc(p, [prepare(p, task, 1, CATALOG, classified({}, ask.result.classifier.attemptId))]);
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
  fs.writeFileSync(path.join(p.stateHome, 'config.json'), '{"classifierTimeoutMs":"soon"}');
  const [badTimeout] = rpc(p, [prepare(p, 'another')]);
  assert.match(badTimeout.error.message, /Unreadable plugin configuration.*"classifierTimeoutMs" must be/);
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
  assert.match(replies[2].error.message, /Unknown operation/, 'the third request was still answered');
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

test('B1 & M3 regression: two-phase classification handshake verifies the pending attempt and task, and a blocked classification never writes a prepared receipt.json', () => {
  const p = plugin(codex, 0, 'none');
  const task = 'Implement retry backoff in client.ts';

  // 1. Unsolicited classification (without a preceding classifyViaHost phase) is rejected as blocked and writes no receipt.json.
  const [unsolicited] = rpc(p, [prepare(p, task, 1, CATALOG, classified())]);
  assert.equal(unsolicited.result?.state, 'blocked');
  assert.equal(unsolicited.result?.router?.status, 'blocked');
  assert.equal(unsolicited.result?.router?.decision?.reason, 'unsolicited_or_mismatched_classification');
  assert.deepEqual(receipts(p), [], 'M3: blocked unsolicited classification writes no receipt.json');

  // 2. Phase 1 mints a unique attemptId; if classification fails, state is blocked and no receipt.json is written.
  const [ask1] = rpc(p, [prepare(p, task, 2, CATALOG, {classifyViaHost: true})]);
  assert.equal(ask1.result?.state, 'classify');
  const attemptId1 = ask1.result.classifier.attemptId;
  assert.equal(typeof attemptId1, 'string');

  const [failedClf] = rpc(p, [prepare(p, task, 3, CATALOG, {classifyViaHost: true, ...refusedBy('classifier_timeout', attemptId1)})]);
  assert.equal(failedClf.result?.state, 'blocked');
  assert.equal(failedClf.result?.router?.status, 'blocked');
  assert.equal(failedClf.result?.router?.decision?.reason, 'classifier_timeout');
  assert.deepEqual(receipts(p), [], 'M3: failed classification leaves no prepared receipt.json');

  // Replaying a classification for the already-consumed attemptId1 is rejected.
  const [replayed] = rpc(p, [prepare(p, task, 4, CATALOG, classified({}, attemptId1))]);
  assert.equal(replayed.result?.state, 'blocked');
  assert.equal(replayed.result?.router?.decision?.reason, 'unsolicited_or_mismatched_classification');
  assert.deepEqual(receipts(p), []);

  // 3. After the cooldown, Phase 1 on the same task mints a new attemptId (B1); a mismatched attemptId is rejected; a matching one succeeds.
  expireClassifierCooldowns(p);
  const [ask2] = rpc(p, [prepare(p, task, 5, CATALOG, {classifyViaHost: true})]);
  assert.equal(ask2.result?.state, 'classify');
  const attemptId2 = ask2.result.classifier.attemptId;
  assert.notEqual(attemptId2, attemptId1, 'B1: retry mints a fresh attemptId');

  const [wrongAttempt] = rpc(p, [prepare(p, task, 6, CATALOG, classified({}, attemptId1))]);
  assert.equal(wrongAttempt.result?.state, 'blocked');
  assert.equal(wrongAttempt.result?.router?.decision?.reason, 'unsolicited_or_mismatched_classification');

  const [ask3] = rpc(p, [prepare(p, task, 7, CATALOG, {classifyViaHost: true})]);
  const [okReply] = rpc(p, [prepare(p, task, 8, CATALOG, classified({}, ask3.result.classifier.attemptId))]);
  assert.equal(okReply.result?.state, 'prepared');
  assert.equal(okReply.result?.router?.status, 'native');
  assert.equal(receipts(p).length, 1);
});

test('m2 & m4 regression: config.json validation matches README (timeout 100..65000, the old model keys are no settings any more) and no_model_meets_floor returns structured blocked', () => {
  const p = plugin(codex, 0, 'none');

  for (const badTimeout of [0, 50, 99, 65001, 120000, -10, '1000']) {
    fs.writeFileSync(path.join(p.stateHome, 'config.json'), JSON.stringify({classifierTimeoutMs: badTimeout}));
    const [bad] = rpc(p, [prepare(p, 'Task with bad timeout', 1, CATALOG, withProfile())]);
    assert.match(bad.error?.message || '', /classifierTimeoutMs.*100.*65000/);
  }
  // A config.json from the earlier version does not stop the plugin, and its keys choose nothing.
  fs.writeFileSync(path.join(p.stateHome, 'config.json'), JSON.stringify({classifierModel: 'x', classifierModels: [], classifierEffort: 'extreme', classifierTimeoutMs: 5000}));
  const [configured] = rpc(p, [prepare(p, 'Task with old keys', 1, CATALOG, {classifyViaHost: true})]);
  assert.deepEqual(Object.keys(configured.result.classifier).sort(), ['attemptId', 'prompt', 'timeoutMs']);
  assert.equal(configured.result.classifier.timeoutMs, 5000);

  // m4: when no catalog model meets the capability floor, worker.cjs returns structured blocked (not an RPC error).
  fs.rmSync(path.join(p.stateHome, 'config.json'), {force: true});
  const minimalOnlyCatalog = {
    models: [
      {route: {agentKind: 'pi', providerId: 'openai', model: 'chatgpt/gpt-6-luna', effort: 'minimal', fastMode: false}, efforts: ['minimal'], supportsFastMode: false},
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

test('R1: a failed classification cools the channel: the retry answers at once with the failure and the plugin card, without asking Cindy; it expires, doubles, and a classified task clears it', () => {
  const p = plugin(codex, 0, 'none');
  const task = 'Add pagination to the list endpoint.';
  const failed = classifyWith(p, task, id => refusedBy('classifier_no_candidate', id));
  assert.equal(failed.result.router.decision.reason, 'classifier_no_candidate');
  assert.match(failed.result.router.next_action, /plugin card/);
  const {channel} = classifierCooldownsOf(p);
  assert.deepEqual([channel.reason, channel.failures], ['classifier_no_candidate', 1]);
  assert.ok(Math.abs(channel.until - Date.now() - 30000) < 5000);

  // Asked again at once: no second classify step, for this task or any other; the answer names the failure and where to act.
  for (const again of [task, 'A different task entirely.']) {
    const [cooling] = rpc(p, [prepare(p, again, 1, CATALOG, {classifyViaHost: true})]);
    assert.equal(cooling.result.state, 'blocked');
    assert.equal(cooling.result.classifier, undefined, 'Cindy is not asked');
    assert.equal(cooling.result.router.decision.reason, 'classifier_cooling_down');
    assert.equal(cooling.result.router.cooldown.reason, 'classifier_no_candidate');
    assert.ok(cooling.result.router.cooldown.retry_after_seconds <= 30);
    assert.match(cooling.result.router.error, /classifier_no_candidate.*Cindy refused/);
    assert.match(cooling.result.router.next_action, /plugin card/);
  }
  // A complete explicit profile needs no classifier, so the cooldown does not hold it.
  const [explicit] = rpc(p, [prepare(p, task, 1, CATALOG, {classifyViaHost: true, ...withProfile()})]);
  assert.equal(explicit.result.router.status, 'native');

  // A consecutive failure doubles the wait.
  expireClassifierCooldowns(p);
  classifyWith(p, 'Second failure.', id => refusedBy('classifier_permission_denied', id));
  const doubled = classifierCooldownsOf(p).channel;
  assert.deepEqual([doubled.reason, doubled.failures], ['classifier_permission_denied', 2]);
  assert.ok(Math.abs(doubled.until - Date.now() - 60000) < 5000);

  // A classified task clears it.
  expireClassifierCooldowns(p);
  const ok = classifyWith(p, 'Third try works.', id => classified({}, id));
  assert.equal(ok.result.router.status, 'native');
  assert.deepEqual(classifierCooldownsOf(p), {});
});

test('R1: a malformed answer cools only that task, so one adversarial task cannot block the others', () => {
  const p = plugin(codex, 0, 'none');
  const reply = classifyWith(p, 'Task that makes the model babble.', id => ({classification: {ok: true, attemptId: id, model: QUICK_MODEL, rawOutput: 'not json'}}));
  assert.equal(reply.result.router.decision.reason, 'invalid_classifier_output');
  assert.deepEqual(Object.keys(classifierCooldownsOf(p)).map(key => key.split(':')[0]), ['task']);
  const [same] = rpc(p, [prepare(p, 'Task that makes the model babble.', 1, CATALOG, {classifyViaHost: true})]);
  assert.equal(same.result.router.decision.reason, 'classifier_cooling_down');
  const [other] = rpc(p, [prepare(p, 'An ordinary task.', 1, CATALOG, {classifyViaHost: true})]);
  assert.equal(other.result.state, 'classify');
});

test('r1: phase 2 needs a live request of this session and task; a forged, stale or incomplete answer is refused and fills no shared cache', () => {
  const p = plugin(codex, 0, 'none');
  const task = 'Implement rate limiting in gateway.ts';
  const other = {...ctx(p.root), session_id: 'other-session'};
  const prepareAs = (id, context, extra) => ({id, method: 'prepare', params: {task, catalog: CATALOG, context, ...extra}});
  const refused = reply => {
    assert.equal(reply.result?.router?.decision?.reason, 'unsolicited_or_mismatched_classification', JSON.stringify(reply));
    assert.deepEqual(receipts(p), []);
  };
  const [ask] = rpc(p, [prepareAs(1, ctx(p.root), {classifyViaHost: true})]);
  const pendingFile = path.join(p.stateHome, ask.result.operation, 'pending-classify.json');
  assert.ok(fs.existsSync(pendingFile));
  // Another session has no request of its own, whatever attempt it names; ours stays usable.
  refused(rpc(p, [prepareAs(2, other, classified({realtime_loop: true}, ask.result.classifier.attemptId))])[0]);
  assert.ok(fs.existsSync(pendingFile));
  // Every field of the answer is required: each of these also uses the request up.
  for (const answer of [
    classified({}),
    classified({}, 'forged-attempt'),
    {classification: {ok: true, attemptId: 'whatever', model: QUICK_MODEL}},
    {classification: {attemptId: 'whatever', rawOutput: '{}'}},
  ]) {
    const [again] = rpc(p, [prepareAs(3, ctx(p.root), {classifyViaHost: true})]);
    assert.equal(again.result.state, 'classify');
    refused(rpc(p, [prepareAs(4, ctx(p.root), answer)])[0]);
    assert.equal(fs.existsSync(pendingFile), false, 'an attempt is good for one answer');
  }
  // An answer without an ok of true or false, with the right attempt, is not an answer.
  const [fresh] = rpc(p, [prepareAs(5, ctx(p.root), {classifyViaHost: true})]);
  refused(rpc(p, [prepareAs(6, ctx(p.root), {classification: {attemptId: fresh.result.classifier.attemptId, rawOutput: JSON.stringify(makeProfile())}})])[0]);
  // A request older than five minutes has lapsed.
  const [stale] = rpc(p, [prepareAs(7, ctx(p.root), {classifyViaHost: true})]);
  fs.writeFileSync(pendingFile, JSON.stringify({...JSON.parse(fs.readFileSync(pendingFile, 'utf8')), createdAt: Date.now() - 5 * 60000 - 1}));
  refused(rpc(p, [prepareAs(8, ctx(p.root), classified({}, stale.result.classifier.attemptId))])[0]);
  // None of that reached the cache another session reads: it has to ask for itself.
  const [clean] = rpc(p, [prepareAs(9, other, {classifyViaHost: true})]);
  assert.equal(clean.result.state, 'classify');
  assert.equal(clean.result.router, undefined);
  assert.equal(fs.existsSync(path.join(p.stateHome, 'score-cache.json')), false);
});

test('r4: a blocked classification leaves a receipt the caller already holds in place', () => {
  const p = plugin(codex, 0, 'none');
  const task = 'Rename foo to bar in util.py.';
  const [held] = rpc(p, [prepare(p, task, 1, CATALOG, withProfile())]);
  assert.equal(held.result.state, 'prepared');
  const file = path.join(p.stateHome, held.result.operation, 'receipt.json');
  const before = fs.readFileSync(file, 'utf8');
  const reply = classifyWith(p, task, id => refusedBy('classifier_internal', id));
  assert.equal(reply.result.state, 'blocked');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const [load] = rpc(p, [{id: 3, method: 'load', params: {operation: held.result.operation, context: ctx(p.root)}}]);
  assert.equal(load.result.state, 'prepared');
});

test('r5: an empty or partial profile starts nothing, with or without the host phase; a complete one routes', () => {
  const p = plugin(codex, 0, 'none');
  for (const partial of [{}, {work_kind: 'general_implementation'}, {self: true}]) {
    for (const viaHost of [false, true]) {
      const [reply] = rpc(p, [prepare(p, 'Fix util.py', 1, CATALOG, {profile: partial, classifyViaHost: viaHost})]);
      assert.equal(reply.result?.state, 'blocked', JSON.stringify(partial));
      assert.equal(reply.result.router.decision.reason, 'invalid_caller_profile');
      assert.equal(reply.result.bundle, null);
      assert.match(reply.result.router.next_action, /expected_hours/);
    }
  }
  assert.deepEqual(receipts(p), []);
  const {reason, ...complete} = makeProfile();
  const [good] = rpc(p, [prepare(p, 'Fix util.py', 1, CATALOG, {profile: complete, classifyViaHost: true})]);
  assert.equal(good.result.router.status, 'native');
  assert.equal(good.result.router.decision.profile_source, 'caller');
});

test('r6: the external CLI takes no profile: it is refused out loud rather than silently ignored', () => {
  for (const config of ['plugin', 'cli']) {
    const p = plugin(codex, 0, config);
    const env = {};
    if (config === 'cli') {
      const bin = path.join(p.root, 'bin');
      launcher(p, bin);
      env.PATH = only([bin]);
    }
    const [refused] = rpc(p, [prepare(p, 'Fix util.py', 1, CATALOG, withProfile())], env);
    assert.equal(refused.result?.state, 'blocked', JSON.stringify(refused));
    assert.equal(refused.result.router.decision.reason, 'profile_not_supported_by_cli');
    assert.equal(p.routerCalls(), 0, 'the CLI never ran');
    assert.deepEqual(receipts(p), []);
    const [routed] = rpc(p, [prepare(p, 'Fix util.py', 2, CATALOG)], env);
    assert.equal(routed.result?.engine, 'cli', 'without a profile the CLI routes as before');
    assert.equal(p.routerCalls(), 1);
  }
});

test('R3: a task of more than 15,000 characters is classified whole; one that cannot fit the quick-text prompt is refused, never cut', () => {
  const p = plugin(codex, 0, 'none');
  const long = 'x'.repeat(15001);
  const [ask] = rpc(p, [prepare(p, long, 1, CATALOG, {classifyViaHost: true})]);
  assert.equal(ask.result.state, 'classify');
  assert.ok(ask.result.classifier.prompt.length <= 32768);
  assert.ok(ask.result.classifier.prompt.includes(long));
  const [routed] = rpc(p, [prepare(p, long, 2, CATALOG, classified({}, ask.result.classifier.attemptId))]);
  assert.equal(routed.result.router.status, 'native');
  const cases = routed.result.router.decision.classifier_calibration_cases;
  assert.equal(cases.total, 47);
  assert.ok(cases.included > 0 && cases.included < 47, JSON.stringify(cases));

  const [tooLong] = rpc(p, [prepare(p, 'x'.repeat(32768), 3, CATALOG, {classifyViaHost: true})]);
  assert.equal(tooLong.result.state, 'blocked');
  assert.equal(tooLong.result.router.decision.reason, 'task_too_long_for_classifier');
  assert.match(tooLong.result.router.error, /never truncated/);
  assert.match(tooLong.result.router.next_action, /explicit `profile`/);
  assert.equal(fs.existsSync(path.join(p.stateHome, 'classifier-cooldowns.json')), false, 'its length says nothing about the channel');
  // The same task with a complete explicit profile does not need the channel at all, up to Cindy's own send limit.
  const [explicit] = rpc(p, [prepare(p, 'x'.repeat(20000), 4, CATALOG, withProfile())]);
  assert.equal(explicit.result.router.status, 'native');
});

const askAgain = (p, task, context = ctx(p.root)) => rpc(p, [{id: 1, method: 'prepare', params: {task, catalog: CATALOG, classifyViaHost: true, context}}])[0];
const stateOf = reply => [reply.result.state, reply.result.router?.decision?.reason ?? null];

test('A1: a model answer without self or wants_fast starts nothing and cools only that task', () => {
  for (const field of ['self', 'wants_fast']) {
    const p = plugin(codex, 0, 'none');
    const {[field]: _, ...without} = makeProfile();
    const reply = classifyWith(p, 'What is a mutex?', id => ({classification: {ok: true, attemptId: id, model: QUICK_MODEL, rawOutput: JSON.stringify(without)}}));
    assert.deepEqual(stateOf(reply), ['blocked', 'invalid_classifier_output'], field);
    assert.match(reply.result.router.error, new RegExp(`missing required field.*${field}`));
    assert.deepEqual(Object.keys(classifierCooldownsOf(p)).map(key => key.split(':')[0]), ['task']);
  }
});

test('a1: profile:null means no profile: the built-in engine asks Cindy, and the configured CLI does not refuse it', () => {
  const p = plugin(codex, 0, 'none');
  const [ask] = rpc(p, [prepare(p, 'Add a retry to the fetcher.', 1, CATALOG, {classifyViaHost: true, profile: null})]);
  assert.equal(ask.result.state, 'classify', JSON.stringify(ask.result.router?.decision));
  const cli = plugin(codex, 0, 'plugin');
  const [routed] = rpc(cli, [prepare(cli, 'Add a retry to the fetcher.', 1, CATALOG, {classifyViaHost: true, profile: null})]);
  assert.equal(routed.result.state, 'prepared', JSON.stringify(routed.result.router?.decision));
  assert.equal(cli.routerCalls(), 1);
});

test('a2: INTERNAL, TIMEOUT and the like cool only the task that caused them, in every session; other tasks in any session still ask Cindy', () => {
  for (const reason of ['classifier_internal', 'classifier_timeout', 'classifier_invalid_params', 'classifier_error']) {
    const p = plugin(codex, 0, 'none');
    const poison = 'A task the provider refuses to answer.';
    assert.equal(classifyWith(p, poison, id => refusedBy(reason, id)).result.router.decision.reason, reason);
    assert.deepEqual(Object.keys(classifierCooldownsOf(p)).map(key => key.split(':')[0]), ['task'], reason);
    assert.deepEqual(stateOf(askAgain(p, poison)), ['blocked', 'classifier_cooling_down'], reason);
    assert.deepEqual(stateOf(askAgain(p, poison, {...ctx(p.root), session_id: 'other-session'})), ['blocked', 'classifier_cooling_down'], 'the same text, another session');
    assert.equal(askAgain(p, 'A healthy task.').result.state, 'classify', reason);
    assert.equal(askAgain(p, 'Another healthy task.', {...ctx(p.root), session_id: 'other-session'}).result.state, 'classify', reason);
  }
});

test('a2: only a channel failure cools every task; RATE_LIMITED cools nothing and says what it is; a cooling answer says how long and what else works', () => {
  for (const reason of ['classifier_no_candidate', 'classifier_permission_denied']) {
    const p = plugin(codex, 0, 'none');
    classifyWith(p, 'First task.', id => refusedBy(reason, id));
    assert.deepEqual(Object.keys(classifierCooldownsOf(p)), ['channel'], reason);
    const cooling = askAgain(p, 'A different task.', {...ctx(p.root), session_id: 'other-session'});
    assert.deepEqual(stateOf(cooling), ['blocked', 'classifier_cooling_down'], reason);
    assert.match(cooling.result.router.next_action, /\d+ s/);
    assert.match(cooling.result.router.next_action, /`profile`/);
  }
  const p = plugin(codex, 0, 'none');
  const limited = classifyWith(p, 'Task during a burst.', id => refusedBy('classifier_rate_limited', id));
  assert.equal(limited.result.router.decision.reason, 'classifier_rate_limited');
  assert.doesNotMatch(limited.result.router.next_action, /Pick another model/);
  assert.match(limited.result.router.next_action, /roll again/);
  assert.equal(fs.existsSync(path.join(p.stateHome, 'classifier-cooldowns.json')), false, 'a limit on requests in flight says nothing about the model');
  assert.equal(askAgain(p, 'Task during a burst.').result.state, 'classify');
});

test('a2: changing the plugin card, oneshotModel or the catalog ends a cooldown at once; nothing else in the settings does', () => {
  const prefsFile = p => {
    const dir = path.join(process.platform === 'darwin' ? path.join(p.home, 'Library', 'Application Support') : path.join(p.home, 'AppData'), 'CindyGlobal', 'owners', '0123456789abcdef0123');
    fs.mkdirSync(dir, {recursive: true});
    return path.join(dir, 'ghost-errand-prefs.json');
  };
  const failed = p => {
    classifyWith(p, 'First task.', id => refusedBy('classifier_no_candidate', id));
    assert.deepEqual(stateOf(askAgain(p, 'Second task.')), ['blocked', 'classifier_cooling_down']);
  };

  const card = plugin(codex, 0, 'none');
  const file = prefsFile(card);
  fs.writeFileSync(file, JSON.stringify({errand: {agentcompass: {model: 'bad-model', agentKind: 'codex'}}, sessions: {}}));
  failed(card);
  // The sessions map of the same file changes on its own and says nothing about the model.
  fs.writeFileSync(file, JSON.stringify({errand: {agentcompass: {model: 'bad-model', agentKind: 'codex'}}, sessions: {agentcompass: 'session-1'}}));
  assert.deepEqual(stateOf(askAgain(card, 'Second task.')), ['blocked', 'classifier_cooling_down']);
  fs.writeFileSync(file, JSON.stringify({errand: {agentcompass: {model: 'good-model', agentKind: 'codex'}}, sessions: {agentcompass: 'session-1'}}));
  assert.equal(askAgain(card, 'Second task.').result.state, 'classify', 'the card changed');
  assert.deepEqual(classifierCooldownsOf(card), {});

  // A task's own cooldown too: a slower model may have been its trouble.
  const slow = plugin(codex, 0, 'none');
  classifyWith(slow, 'A long question.', id => refusedBy('classifier_timeout', id));
  assert.deepEqual(stateOf(askAgain(slow, 'A long question.')), ['blocked', 'classifier_cooling_down']);
  fs.writeFileSync(prefsFile(slow), JSON.stringify({errand: {agentcompass: {model: 'quick-model'}}}));
  assert.equal(askAgain(slow, 'A long question.').result.state, 'classify');

  const declared = plugin(codex, 0, 'none');
  failed(declared);
  const manifest = path.join(declared.out, 'ghost.json');
  const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  fs.writeFileSync(manifest, JSON.stringify({...parsed, cindy: {...parsed.cindy, oneshotModel: 'codex/gpt-6.1-sol'}}));
  assert.equal(askAgain(declared, 'Second task.').result.state, 'classify', 'oneshotModel changed');

  const signedIn = plugin(codex, 0, 'none');
  failed(signedIn);
  const wider = {...CATALOG, models: [...CATALOG.models, {route: {agentKind: 'cc', providerId: 'anthropic', model: 'claude-sonnet-5-5', effort: 'high', fastMode: false}, efforts: ['high'], supportsFastMode: false}]};
  const [after] = rpc(signedIn, [prepare(signedIn, 'Second task.', 1, wider, {classifyViaHost: true})]);
  assert.equal(after.result.state, 'classify', 'a new connection in the catalog');
});

test('a3: a cooldown never waits more than 5 minutes, and a clock moved back does not hold it for longer', () => {
  const p = plugin(codex, 0, 'none');
  classifyWith(p, 'First task.', id => refusedBy('classifier_no_candidate', id));
  const file = path.join(p.stateHome, 'classifier-cooldowns.json');
  const moved = classifierCooldownsOf(p);
  moved.channel.until = Date.now() + 30 * 24 * 3600 * 1000;
  fs.writeFileSync(file, JSON.stringify(moved));
  const cooling = askAgain(p, 'Second task.');
  assert.deepEqual(stateOf(cooling), ['blocked', 'classifier_cooling_down']);
  assert.ok(cooling.result.router.cooldown.retry_after_seconds <= 300, String(cooling.result.router.cooldown.retry_after_seconds));
  // Kept, so the five minutes run out: capping each read alone would hold it for the whole 30 days.
  assert.ok(classifierCooldownsOf(p).channel.until <= Date.now() + 300000);
  expireClassifierCooldowns(p);
  for (let i = 0; i < 6; i++) {
    classifyWith(p, `Failure ${i}.`, id => refusedBy('classifier_no_candidate', id));
    assert.ok(classifierCooldownsOf(p).channel.until <= Date.now() + 300000, `failure ${i}`);
    expireClassifierCooldowns(p);
  }
});

test('m2: the hint says a fix the plugin cannot see still waits out the cooldown, up to 5 minutes, and what does not wait', () => {
  const p = plugin(codex, 0, 'none');
  const failed = classifyWith(p, 'First task.', id => refusedBy('classifier_no_candidate', id));
  const cooling = askAgain(p, 'Second task.');
  assert.deepEqual(stateOf(cooling), ['blocked', 'classifier_cooling_down']);
  for (const hint of [failed.result.router.next_action, cooling.result.router.next_action]) {
    assert.match(hint, /auxiliary model[^.]*permission[^.]*up to 5 minutes/);
    assert.match(hint, /`profile`/);
  }
  assert.match(fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8'), /auxiliary model[^.]*permission[^.]*up to 5 minutes/);
});

test('m3: through the worker, both steps, the same answer routes every text in the corpus the same; opposite answers on the same text go opposite ways', () => {
  const route = (overrides, tasks) => {
    const p = plugin(codex, 0, 'none');
    const params = task => ({task, catalog: CATALOG, classifyViaHost: true, context: ctx(p.root)});
    const asked = rpc(p, tasks.map((task, index) => ({id: index + 1, method: 'prepare', params: params(task)})));
    const replies = rpc(p, tasks.map((task, index) => ({id: index + 1, method: 'prepare', params: {...params(task), ...classified(overrides, asked[index].result.classifier.attemptId)}})));
    return replies.map(reply => {
      const {classifier_calibration_cases, ...decision} = reply.result.router.decision;
      return {state: reply.result.state, bundle: reply.result.bundle, decision};
    });
  };
  const tasks = [BASE_TASK, ...KEYWORD_CORPUS];
  for (const overrides of [{}, {realtime_loop: true, wants_fast: true, urgency: 'high'}]) {
    const [expected, ...rest] = route(overrides, tasks);
    assert.equal(expected.decision.profile.realtime_loop, overrides.realtime_loop === true);
    assert.equal(expected.decision.profile.wants_fast, overrides.wants_fast === true);
    rest.forEach((actual, index) => assert.deepEqual(actual, expected, KEYWORD_CORPUS[index].slice(0, 60)));
  }
});

test('M1, fifth review: through the worker, an unquoted count splits with its count, and the same task asks Cindy nothing the second time; a contradicting number starts nothing', () => {
  for (const [count, bucket] of [[3, '3'], [4, '>3']]) {
    const p = plugin(codex, 0, 'none');
    const task = `Do several things, count ${count}.`;
    const first = classifyWith(p, task, id => classified({multi_task: true, task_count: count}, id));
    assert.deepEqual([first.result.router.status, first.result.router.task_count], ['split', bucket]);
    const again = askAgain(p, task);
    assert.notEqual(again.result.state, 'classify', 'Cindy is not asked again');
    assert.deepEqual([again.result.router.status, again.result.router.task_count], ['split', bucket]);
    assert.equal(again.result.classifier, undefined);
  }
  for (const [multi, count] of [[false, 2], [true, 1], [true, 0], [true, 2.5]]) {
    const p = plugin(codex, 0, 'none');
    const reply = classifyWith(p, 'Do something.', id => classified({multi_task: multi, task_count: count}, id));
    assert.deepEqual(stateOf(reply), ['blocked', 'invalid_classifier_output'], `${multi} ${count}`);
    assert.match(reply.result.router.error, /task_count/);
  }
});
