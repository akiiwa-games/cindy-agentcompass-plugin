// Sandbox end-to-end: scripts/build_plugin.py -> the built plugin (main.js in a fake Cindy host, the real worker.cjs as a
// real node child over JSON-RPC stdio) -> the real public `agentcompass roll` -> the router's classifier, allocator and
// ledger, in an isolated home with no credentials and no network beyond one local fixture port.
//
//   node test/sandbox-e2e.mjs
//
// Substituted, and only that: the Cindy host and its experimental tasks API (test/zero_cindy_host.mjs), the model behind
// the router's classifier (a local OpenAI-compatible server below) and the provider CLI (a discovery placeholder; Cindy,
// not AgentCompass, would run the worker). Real-host evidence is docs/CINDY_REAL_ACCEPTANCE_AND_CANCEL_FIX.md.
//
// Environment:
//   AGENTCOMPASS_CHECKOUT   AgentCompass source checkout (default: ../route_manager next to this repository)
//   AGENTCOMPASS_PYTHON     Python 3.11+ that runs it (default: python3, then python)
//   CINDY_SANDBOX_ROOT      new directory for the isolated home (default: a fresh temporary directory)
//   CINDY_SANDBOX_REPORT    report path (default: <sandbox>/report/sandbox-e2e-report.json)
//   CINDY_REPORT_MERGE_INTO also merge this run into that combined report, keyed by platform label
//   CINDY_SANDBOX_LABEL     platform label (default: process.platform)
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const CHECKOUT = path.resolve(process.env.AGENTCOMPASS_CHECKOUT || path.join(REPO, '..', 'route_manager'));
const ROOT = path.resolve(process.env.CINDY_SANDBOX_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-sandbox-')));
const LABEL = process.env.CINDY_SANDBOX_LABEL || process.platform;
const SESSION = 'cindy-session-1';
const TASK_BODY = 'Rename the helper foo to bar in util.py and update its two callers.';

function findPython() {
  for (const candidate of [process.env.AGENTCOMPASS_PYTHON, 'python3', 'python'].filter(Boolean)) {
    const done = spawnSync(candidate, ['-c', 'import sys;print(sys.executable);print(sys.version.split()[0])'], {encoding: 'utf8'});
    if (done.status === 0) {
      const [exe, version] = done.stdout.trim().split(/\r?\n/);
      return {exe, version};
    }
  }
  throw Error('No Python found; set AGENTCOMPASS_PYTHON.');
}

// ---- the report
const report = {kind: 'cindy-agentcompass-plugin sandbox e2e', label: LABEL, started_at: new Date().toISOString(), operations: []};
let current = null;
function operation(name, intent) {
  current = {name, intent, checks: []};
  report.operations.push(current);
  return current;
}
function check(name, ok, detail) {
  current.checks.push({name, ok: Boolean(ok), ...(ok ? {} : {detail: typeof detail === 'string' ? detail.slice(0, 2000) : JSON.stringify(detail ?? null).slice(0, 2000)})});
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${current.name} :: ${name}`);
}

// ---- the isolated world
fs.mkdirSync(ROOT, {recursive: true});
assert.equal(fs.readdirSync(ROOT).length, 0, `CINDY_SANDBOX_ROOT must be a new empty directory: ${ROOT}`);
const D = name => {const p = path.join(ROOT, name); fs.mkdirSync(p, {recursive: true}); return p;};
const home = D('home'), state = D('state'), bin = D('bin'), tmp = D('tmp'), art = D('report/cindy'), work = D('work dir');
const python = findPython();
const pathParts = [bin, path.dirname(process.execPath), path.dirname(python.exe)];
if (WIN) pathParts.push(path.join(process.env.SYSTEMROOT || 'C:\\Windows', 'System32'));
else pathParts.push('/usr/bin', '/bin');
const keep = WIN ? ['SYSTEMROOT', 'WINDIR', 'PATHEXT', 'COMSPEC'] : [];
const baseEnv = {
  ...Object.fromEntries(keep.filter(k => process.env[k]).map(k => [k, process.env[k]])),
  PATH: pathParts.join(path.delimiter), HOME: home, USERPROFILE: home, TMPDIR: tmp, TEMP: tmp, TMP: tmp,
  APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
  XDG_STATE_HOME: path.join(home, '.local', 'state'),
  CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), PASEO_HOME: path.join(home, '.paseo'),
  ROUTER_PROVIDER_HOME: home, ROUTER_STATE_DIR: state,
  ROUTER_ACCOUNTS_FILE: path.join(CHECKOUT, 'skills', 'agent-compass', 'scripts', 'fixtures', 'reference-accounts.json'),
  ROUTER_ACCOUNTS_OVERRIDE: path.join(state, 'override.json'), ROUTER_LEDGER: path.join(state, 'router-ledger.jsonl'),
  ROUTER_DISPATCH_DB: path.join(state, 'dispatch.sqlite3'), ROUTER_USAGE_CACHE: path.join(state, 'usage.json'), ROUTER_SCORE_CACHE: 'off',
  PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', NO_COLOR: '1',
};
// Discovery placeholders for the routed CLIs with synthetic sign-in data; nothing executes them (Cindy runs the worker).
for (const name of ['codex', 'claude', 'pi']) {
  const cli = path.join(bin, WIN ? `${name}.exe` : name);
  fs.writeFileSync(cli, WIN ? 'fixture discovery placeholder' : `#!/bin/sh\necho "${name} 0.0.0-fixture"\n`);
  fs.chmodSync(cli, 0o755);
}
fs.mkdirSync(baseEnv.CODEX_HOME, {recursive: true});
fs.mkdirSync(baseEnv.CLAUDE_CONFIG_DIR, {recursive: true});
fs.writeFileSync(path.join(baseEnv.CLAUDE_CONFIG_DIR, '.credentials.json'), JSON.stringify({claudeAiOauth: {accessToken: 'fixture-only',
  subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x'}}));
// The Pi scenario routes with only the Codex sign-in: with Claude signed in, this fleet prefers Claude for exploration.
const noClaude = D('claude-signed-out');
const claims = Buffer.from(JSON.stringify({'https://api.openai.com/auth': {chatgpt_plan_type: 'plus', chatgpt_account_id: 'fixture'}})).toString('base64url');
fs.writeFileSync(path.join(baseEnv.CODEX_HOME, 'auth.json'), JSON.stringify({tokens: {account_id: 'fixture', access_token: 'fixture-only', id_token: `e30.${claims}.fixture`}}));

// ---- the model behind the classifier: a fixed small-edit profile, changed by a `FIXTURE-PROFILE: <name>` line in the task
// so each harness is reached through the real allocator (profiles found by probing this fleet; the router decides).
const PROFILES = {
  deep: {work_kind: 'direction_reasoning', reasoning_depth: 4, hallucination_risk: 3, error_cost: 3, divergence: 3, context_scale: 3,
    code_complexity: 3, expected_hours: 3, reason: 'fixture: deep open-ended design'},
  review: {work_kind: 'debug_review', reasoning_depth: 3, reason: 'fixture: a focused review'},
  explore: {work_kind: 'exploration_analysis', interaction_style: 'exploration', reason: 'fixture: read-only exploration'},
  split: {multi_task: true, task_count: '2', reason: 'fixture: two independent deliverables'},
};
const scorerRequests = [];
const scorer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', d => chunks.push(d)).on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const user = (body.messages || []).find(m => m.role === 'user')?.content || '';
    scorerRequests.push({path: req.url, model: body.model, chars: user.length});
    const profile = {work_kind: 'general_implementation', reasoning_depth: 2, code_complexity: 1, context_scale: 2, divergence: 1,
      hallucination_risk: 2, error_cost: 2, needs_visual: false, needs_gui: false, local_only: false, expected_hours: 0.5,
      hours_confidence: 'medium', urgency: 'normal', interaction_style: 'engineering', multi_task: false, task_count: '1',
      reason: 'fixture classification of a small bounded edit'};
    const marker = (/FIXTURE-PROFILE: (\w+)/.exec(user) || [])[1];
    Object.assign(profile, PROFILES[marker] || {});
    scorerRequests.at(-1).profile = marker || 'default';
    const raw = JSON.stringify({choices: [{message: {content: JSON.stringify(profile)}}]});
    res.writeHead(200, {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw)});
    res.end(raw);
  });
});
await new Promise(resolve => scorer.listen(0, '127.0.0.1', resolve));
const scorerBase = `http://127.0.0.1:${scorer.address().port}/v1`;

// ---- process helpers: asynchronous, so the in-process scorer keeps answering while a child waits on it
function run(argv, {env = {}, stdin = null, cwd = work, timeout = 400000} = {}) {
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), {cwd, env: {...baseEnv, ...env}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    const out = [], err = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('close', code => {clearTimeout(timer); resolve({code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8')});});
    child.on('error', error => {clearTimeout(timer); resolve({code: -1, stdout: '', stderr: String(error)});});
    child.stdin.end(stdin ?? '');
  });
}
const agentcompass = [python.exe, '-X', 'utf8', path.join(CHECKOUT, 'agentcompass')];
const ac = (args, options) => run([...agentcompass, ...args], options);
const parse = text => {try {return JSON.parse(text);} catch {const i = text.indexOf('{'); try {return JSON.parse(text.slice(i));} catch {return null;}}};
const task = (note = '') => `${TASK_BODY} [${crypto.createHash('sha256').update(`${Date.now()}${note}${Math.random()}`).digest('hex').slice(0, 8)}]\nFIXTURE-SCENARIO: ok ${note}\n`;
const readJson = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};

async function drive(plugin, name, steps, {session = SESSION, env = {}} = {}) {
  const scenario = path.join(art, `${name}.scenario.json`), out = path.join(art, `${name}.out.json`);
  fs.writeFileSync(scenario, JSON.stringify({workdir: work, session, steps}));
  const result = await run([process.execPath, path.join(REPO, 'test', 'zero_cindy_host.mjs'), plugin, scenario, out], {env});
  return {record: readJson(out), result};
}
const count = (record, name) => (record.calls || []).filter(c => c.name === name).length;
const replies = record => Object.fromEntries((record.results || []).filter(r => r.replies).map(r => [r.label, r.replies]));
const first = (map, key) => (map[key] || [{}])[0];

let exitCode = 0;
try {
  // -------------------------------------------------------------------------------------------------------------
  operation('isolation', 'the router runs with a sandbox home, state and PATH; nothing points at the real machine');
  const inside = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'ROUTER_STATE_DIR', 'PASEO_HOME', 'ROUTER_LEDGER', 'TMPDIR'];
  check('home, state, ledger and temp are inside the sandbox', inside.every(k => path.resolve(baseEnv[k]).startsWith(ROOT)), Object.fromEntries(inside.map(k => [k, baseEnv[k]])));
  check('no credential-shaped variable is passed', !Object.keys(baseEnv).some(k => /(TOKEN|SECRET|PASSWORD|API_KEY)$/.test(k)), Object.keys(baseEnv));
  check('no Paseo, Herdr, Orca or T3 session variable is passed', !Object.keys(baseEnv).some(k => /^(PASEO_AGENT_ID|HC_|ORCA_|T3_|CINDY_)/.test(k)), Object.keys(baseEnv));
  const version = await ac(['--version']);
  report.environment = {platform: process.platform, arch: process.arch, os_release: os.release(), node: process.version, python: python.version,
    agentcompass_version: version.stdout.trim(), agentcompass_checkout: CHECKOUT, sandbox_root: ROOT, scorer: scorerBase};
  check('the public AgentCompass entry runs from the checkout', version.code === 0 && /^\d+\.\d+\.\d+/.test(version.stdout.trim()), version.stdout + version.stderr);

  operation('unit tests', 'the plugin boundary, the real worker.cjs bridge, the build script and the hotfix refusals, run inside this sandbox');
  const nodeUnits = await run([process.execPath, '--test', ...['test_market_contract.mjs', 'test_cindy_plugin.mjs', 'test_worker_bridge.mjs'].map(f => path.join(REPO, 'test', f))],
    {cwd: REPO, env: {AGENTCOMPASS_PYTHON: python.exe}});
  const [nodePass, nodeFail] = ['pass', 'fail'].map(k => Number((nodeUnits.stdout.match(new RegExp(`ℹ ${k} (\\d+)`)) || [])[1]));
  report.unit_tests = {node: {pass: nodePass, fail: nodeFail}};
  check(`node --test: ${nodePass} passed, ${nodeFail} failed`, nodeUnits.code === 0 && nodePass >= 30 && nodeFail === 0, nodeUnits.stdout.slice(-1500) + nodeUnits.stderr.slice(-500));
  const pyUnits = await run([python.exe, '-X', 'utf8', '-m', 'unittest', 'discover', '-s', path.join(REPO, 'test'), '-p', 'test_*.py'], {cwd: REPO});
  const ran = Number((pyUnits.stderr.match(/Ran (\d+) tests?/) || [])[1]);
  report.unit_tests.python = {ran, ok: pyUnits.code === 0};
  check(`python unittest: ${ran} ran`, pyUnits.code === 0 && ran >= 8 && /\nOK/.test(pyUnits.stderr), pyUnits.stderr.slice(-1500));

  operation('classifier configuration', 'agentcompass scorer --action set points the real classifier at the local fixture model');
  const set = await ac(['scorer', '--action', 'set', '--type', 'openai_compatible', '--base-url', scorerBase, '--model', 'fixture-classifier', '--api-key', 'fixture-key']);
  check('scorer set exits 0', set.code === 0, set.stdout.slice(-400) + set.stderr.slice(-400));
  const shown = await ac(['scorer', '--action', 'show']);
  check('scorer show names the OpenAI-compatible type and masks the key', shown.stdout.includes('openai_compatible') && !shown.stdout.includes('fixture-key'), shown.stdout.slice(0, 400));

  // -------------------------------------------------------------------------------------------------------------
  operation('build the plugin', 'scripts/build_plugin.py writes reviewable source bound to this AgentCompass and installs nothing');
  const mapping = path.join(ROOT, 'cindy-account-map.json');
  fs.writeFileSync(mapping, JSON.stringify([{routerProvider: 'codex', routerAccount: 'codex', providerId: 'codex', agentKind: 'codex'},
                                            {routerProvider: 'claude', routerAccount: 'claude', providerId: 'claude', agentKind: 'cc'}]));
  const plugin = path.join(ROOT, 'cindy plugin src');
  const builder = [python.exe, '-X', 'utf8', path.join(REPO, 'scripts', 'build_plugin.py')];
  const built = await run([...builder, '--output', plugin, '--account-map', mapping, '--router-cmd', CHECKOUT]);
  const builtDoc = parse(built.stdout) || {};
  check('build reports built', built.code === 0 && builtDoc.status === 'built', built.stdout.slice(0, 400) + built.stderr.slice(-400));
  check('ghost.json, main.js, worker.cjs and router.json exist', ['ghost.json', 'main.js', 'worker.cjs', 'router.json'].every(f => fs.existsSync(path.join(plugin, f))),
    fs.existsSync(plugin) ? fs.readdirSync(plugin) : 'no plugin directory');
  const config = readJson(path.join(plugin, 'router.json'));
  check('router.json binds the public roll entry of this checkout with an absolute interpreter',
    config.command?.at(-1) === 'roll' && path.isAbsolute(config.command[0]) && fs.existsSync(config.command[0]) && config.command.includes(path.join(CHECKOUT, 'agentcompass')), config);
  check('the explicit account map is carried verbatim', (config.accountMappings || []).length === 2, config);
  const ghost = readJson(path.join(plugin, 'ghost.json'));
  check('the manifest asks for session context, node and tasks and exposes roll/status/stop/cleanup',
    ghost.sessionContext === true && ghost.agent?.tasks === true && ghost.node?.protocol === 'json-rpc-stdio' &&
    JSON.stringify((ghost.tools || []).map(t => t.name)) === '["roll","status","stop","cleanup"]' && ghost.minCindyVersion === '0.1.121', ghost.tools);
  const again = await run([...builder, '--output', plugin, '--router-cmd', CHECKOUT]);
  check('building into an existing directory is refused', again.code !== 0 && again.stdout.includes('already exists'), again.stdout.slice(0, 200));
  const bad = path.join(ROOT, 'bad-map.json');
  fs.writeFileSync(bad, JSON.stringify([{routerProvider: 'codex'}]));
  const refused = await run([...builder, '--output', path.join(ROOT, 'cindy bad src'), '--account-map', bad, '--router-cmd', CHECKOUT]);
  check('an incomplete account map is refused and nothing is written', refused.code !== 0 && !fs.existsSync(path.join(ROOT, 'cindy bad src')), refused.stdout.slice(0, 200));

  operation('market contract gate', 'plugin/ as the market packs it, and the built source, pass the official repository gate (pinned validateGhostManifest, locales, icon, package rules)');
  const gate = async dir => {
    const done = await run([process.execPath, '--test', path.join(REPO, 'test', 'test_market_contract.mjs')], {cwd: REPO, env: dir ? {CINDY_MARKET_PLUGIN_DIR: dir} : {}});
    return {done, pass: Number((done.stdout.match(/ℹ pass (\d+)/) || [])[1]), fail: Number((done.stdout.match(/ℹ fail (\d+)/) || [])[1])};
  };
  const rawGate = await gate(null), builtGate = await gate(plugin);
  check(`plugin/ passes the gate (${rawGate.pass} checks)`, rawGate.done.code === 0 && rawGate.pass >= 7 && rawGate.fail === 0, rawGate.done.stdout.slice(-1500));
  check(`the built source passes the gate (${builtGate.pass} checks)`, builtGate.done.code === 0 && builtGate.pass >= 6 && builtGate.fail === 0, builtGate.done.stdout.slice(-1500));
  const shipped = JSON.parse(fs.readFileSync(path.join(REPO, 'plugin', 'ghost.json'), 'utf8'));
  const icon = fs.readFileSync(path.join(REPO, 'plugin', shipped.icon));
  check('id agentcompass, name AgentCompass, a 256 px PNG icon and exactly en/ja/ko/zh-CN locales',
    shipped.id === 'agentcompass' && shipped.name === 'AgentCompass' && icon.subarray(1, 4).toString() === 'PNG' && [128, 256].includes(icon.readUInt32BE(16)) &&
    JSON.stringify(Object.keys(shipped.locales).sort()) === '["en","ja","ko","zh-CN"]', {id: shipped.id, name: shipped.name, locales: shipped.locales});
  report.market = {id: shipped.id, version: shipped.version, icon: {bytes: icon.length, px: icon.readUInt32BE(16)}, locales: Object.keys(shipped.locales)};

  // -------------------------------------------------------------------------------------------------------------
  operation('AgentCompass core: stock Cindy shell', 'raw shell roll in Cindy has no addressable parent: the core refuses instead of routing a provider thread to Paseo');
  const stock = await ac(['roll', '--task', task('stock-cindy'), '--wait', '0'], {env: {CINDY_INPUT_HANDOFF_ROUTE: 'fixture-route-value', CLAUDE_SESSION_ID: 'provider-thread-from-cindy-shell'}});
  const stockDoc = parse(stock.stdout) || {};
  check('roll is refused (not launched) and names Cindy', stock.code !== 0 && stockDoc.status !== 'launched' && (stock.stdout + stock.stderr).toLowerCase().includes('cindy'),
    (stock.stdout + stock.stderr).slice(0, 400));

  // -------------------------------------------------------------------------------------------------------------
  const happyTask = task('cindy') + '完整原文 unchanged\r\n第二行 with trailing spaces   \r\n';
  operation('one task from roll to cleanup', 'trusted session context -> prepare through the real router -> create -> send -> status -> paged result -> cleanup');
  const forged = {session_id: 'victim-session', workdir: work, workdir_is_local: true, workdir_is_read_only: false};
  const firstLabel = "roll twice at once, with a forged session_context in the caller's arguments";
  const scorerBefore = scorerRequests.length;
  let {record, result} = await drive(plugin, 'happy', [
    {label: firstLabel, call: 'roll', args: {task: happyTask, session_context: forged}, parallel: 2},
    {label: 'status while running', call: 'status', args: {operation: '@operation'}},
    {label: 'cleanup while running', call: 'cleanup', args: {operation: '@operation'}},
    {label: 'the run finishes', fixture: {runStatus: 'completed', outputMessageId: 'out-final', pages: 3, finalText: '[Worker final report] cindy fixture result ' + '实'.repeat(5000)}},
    {label: 'status after completion', call: 'status', args: {operation: '@operation'}},
    {label: 'cleanup', call: 'cleanup', args: {operation: '@operation'}},
    {label: 'cleanup again', call: 'cleanup', args: {operation: '@operation'}},
    {label: 'the same assignment again', call: 'roll', args: {task: happyTask}},
  ]);
  let r = replies(record);
  const both = r[firstLabel] || [];
  check('both concurrent rolls succeed with one operation', both.length === 2 && both.every(x => x.ok) && new Set(both.map(x => x.result.operation)).size === 1,
    JSON.stringify(both).slice(0, 600) + result.stderr.slice(-400) + (record.workerStderr || ''));
  check('the real classifier was asked once for the task', scorerRequests.length - scorerBefore === 1, scorerRequests.slice(scorerBefore));
  check('exactly one task was created and one input sent', count(record, 'create') === 1 && count(record, 'send') === 1, record.calls);
  const operationId = both[0]?.ok ? both[0].result.operation : 'none';
  const receiptFile = path.join(home, '.agent-compass', 'cindy-plugin', operationId, 'receipt.json');
  const stored = readJson(receiptFile);
  check('the receipt belongs to the host-injected session, not the forged one', stored.parent === SESSION, stored.parent);
  const router = stored.router || {};
  check('the real router routed for the Cindy session as a native parent', router.status === 'native' && router.caller_action === 'launch_with_native_host_tool' &&
    router.parent_host === 'native' && router.parent_id === SESSION && router.parent_address === SESSION,
    Object.fromEntries(['status', 'caller_action', 'parent_host', 'parent_id', 'parent_address', 'error', 'next'].map(k => [k, router[k]])));
  const bundle = stored.bundle || {};
  check('the plugin made the launcher permission explicit for the routed harness',
    ({claude: 'bypassPermissions', codex: 'full-access', pi: 'full-access'})[bundle.harness] === bundle.modeId, bundle);
  check('codex: the router chose codex/gpt-6.1-sol, full-access, without fast mode',
    bundle.provider === 'codex' && bundle.harness === 'codex' && bundle.model === 'gpt-6.1-sol' && bundle.modeId === 'full-access' && !bundle.fast, bundle);
  const created = (record.calls || []).find(c => c.name === 'create') || {};
  check("the create request carries the router's exact model/effort and the bypass permission",
    created.route?.model === (bundle.launch_model || bundle.model) && created.route?.effort === bundle.effort && created.permissionMode === 'bypassPermissions', {created, bundle});
  const sent = (record.sent || [])[0] || {};
  const text = sent.file ? fs.readFileSync(sent.file, 'utf8') : '';
  check('the text sent to Cindy contains the whole task byte for byte', text.includes(happyTask), text.slice(0, 260));
  check('the text sent to Cindy carries the return contract for a task without a mailbox', text.includes('Cindy plugin task return channel'), text.slice(-400));
  check('the router prompt names the real Cindy session as the parent', text.includes(`Parent session agent ID: \`${SESSION}\``), text.slice(-1200));
  check("the sent text is the receipt's prompt (nothing cut)", stored.prompt === text, [String(stored.prompt || '').length, text.length]);
  const ledger = fs.existsSync(baseEnv.ROUTER_LEDGER) ? fs.readFileSync(baseEnv.ROUTER_LEDGER, 'utf8') : '';
  check('the routing decision was recorded in the ledger for this session', ledger.includes(SESSION), ledger.slice(-400));
  const running = first(r, 'status while running');
  check('status while running says there is no automatic callback and names the next call', running.ok && running.result?.status === 'running' &&
    running.result?.next_tool?.tool === 'status' && (running.result?.next_action || '').includes('No automatic callback'), running);
  check('cleanup of a running task is refused', first(r, 'cleanup while running').ok === false, r['cleanup while running']);
  const done = first(r, 'status after completion'), outcome = done.result || {};
  check('status after completion returns the exact final message with all pages saved', done.ok && outcome.status === 'completed' && outcome.output_available &&
    outcome.messages_complete && (outcome.full_result_artifacts || []).length === 3 && outcome.summary_shortened && (outcome.final_result_summary || '').includes('[Worker final report]'),
    JSON.stringify(done).slice(0, 500));
  check('every saved page exists on disk', (outcome.full_result_artifacts || []).length > 0 && outcome.full_result_artifacts.every(p => fs.existsSync(p)), outcome.full_result_artifacts);
  check('cleanup archives once and repeating it is harmless', first(r, 'cleanup').ok && first(r, 'cleanup').result?.status === 'cleaned' && first(r, 'cleanup again').ok && count(record, 'archive') === 1,
    {archive: count(record, 'archive')});
  check('rolling the same assignment again does not create or send anything new', count(record, 'create') === 1 && count(record, 'send') === 1, (record.calls || []).map(c => c.name));
  check('no duplicate create or send reached the host', record.duplicateCreate === 0 && record.duplicateSend === 0, record);

  operation('the real receipt in the plugin unit fixture', 'test/test_cindy_plugin.mjs replays the receipt the real router produced through main.js');
  const replay = await run([process.execPath, '--test', path.join(REPO, 'test', 'test_cindy_plugin.mjs')], {env: {CINDY_PUBLIC_ROUTE_FIXTURE: receiptFile}});
  check('the plugin unit tests pass with the real receipt', replay.code === 0 && replay.stdout.includes('actual public router route reaches explicit Cindy permission'),
    replay.stdout.slice(-800) + replay.stderr.slice(-400));

  // -------------------------------------------------------------------------------------------------------------
  operation('create answer lost', 'the host creates the draft but its answer never arrives: unknown_create, nothing is created or sent again, the orphan is not hidden');
  const same = task('unknown-create');
  ({record, result} = await drive(plugin, 'unknown-create', [
    {label: 'lose the create answer', fixture: {createFault: 'after'}},
    {label: 'roll', call: 'roll', args: {task: same}},
    {label: 'status', call: 'status', args: {operation: '@operation:roll'}},
    {label: 'roll again', call: 'roll', args: {task: same}},
    {label: 'cleanup', call: 'cleanup', args: {operation: '@operation:roll'}},
  ]));
  r = replies(record);
  const [one, st, rep, cl] = ['roll', 'status', 'roll again', 'cleanup'].map(k => first(r, k));
  check("roll reports unknown_create with the host's reason and the next call", one.ok && one.result?.status === 'unknown_create' && (one.result?.error || '').includes('CONNECTION_LOST') && one.result?.next_tool,
    JSON.stringify(one).slice(0, 400) + result.stderr.slice(-300));
  check('status keeps saying unknown_create and tells the caller to inspect, not resend', st.ok && st.result?.status === 'unknown_create' && (st.result?.cause || '').includes('do not resend'), st);
  check('rolling the same assignment again creates nothing new', rep.ok && rep.result?.status === 'unknown_create' && count(record, 'create') === 1, (record.calls || []).map(c => c.name));
  check('no input was ever sent and no run exists', count(record, 'send') === 0 && !(record.runs || []).length, record.calls);
  check('the orphan draft exists in the host and the plugin refuses to archive what it never saw', (record.tasks || []).length === 1 && cl.ok === false &&
    (cl.message || '').includes('No confirmed task') && count(record, 'archive') === 0, {tasks: (record.tasks || []).length, cleanup: cl});

  operation('a very large final reply', 'about 2.6 MB of final output crosses the real JSON-RPC bridge: a bounded summary, the complete text on disk');
  const unit = '[Worker final report] 很长的输出 line of text 0123456789 abcdefghij\n', times = 50000;
  ({record, result} = await drive(plugin, 'oversize-reply', [
    {label: 'roll', call: 'roll', args: {task: task('oversize')}},
    {label: 'finished', fixture: {runStatus: 'completed', outputMessageId: 'out-final', pages: 2, finalRepeat: {unit, count: times}}},
    {label: 'status', call: 'status', args: {operation: '@operation:roll'}},
    {label: 'cleanup', call: 'cleanup', args: {operation: '@operation:roll'}},
  ]));
  r = replies(record);
  const big = first(r, 'status'), bigOut = big.result || {};
  check('the bridge survives the large page and status completes', big.ok && bigOut.status === 'completed' && bigOut.messages_complete === true && !result.stderr.trim(),
    JSON.stringify(big).slice(0, 400) + result.stderr.slice(-400));
  check('the reply is bounded: summary at most 4000 characters, marked shortened, whole reply small',
    (bigOut.final_result_summary || '').length <= 4000 && bigOut.summary_shortened === true && JSON.stringify(big).length < 30000, JSON.stringify(big).length);
  const pages = (bigOut.full_result_artifacts || []).filter(p => fs.existsSync(p)).map(p => JSON.parse(fs.readFileSync(p, 'utf8')));
  const texts = pages.flatMap(p => (p.items || []).filter(i => i.id === 'out-final').map(i => i.content));
  check('the complete final message is saved byte for byte in the artifact', pages.length === 2 && texts.length === 1 && texts[0] === unit.repeat(times), texts.map(t => t.length));
  check('cleanup still archives once', first(r, 'cleanup').ok === true && count(record, 'archive') === 1, count(record, 'archive'));

  operation('host without the needed task API', 'missing or partial capabilities stop before the router is even asked; no task is created');
  const capSteps = [];
  for (const mode of ['missing', 'denied', 'no-cancel', 'no-exact'])
    capSteps.push({label: 'set ' + mode, fixture: {capabilities: mode}}, {label: mode, call: 'roll', args: {task: task('cap-' + mode)}});
  ({record, result} = await drive(plugin, 'capabilities', capSteps));
  r = replies(record);
  check('every roll is refused', Object.keys(r).length === 4 && Object.values(r).every(x => x[0].ok === false), JSON.stringify(r).slice(0, 500) + result.stderr.slice(-300));
  check('the unsupported shapes say that no worker started', ['missing', 'no-cancel', 'no-exact'].every(m => (first(r, m).message || '').includes('No worker started')),
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v[0].message])));
  check('the router was never asked and nothing was created', JSON.stringify(record.nodeCalls) === '[]' && count(record, 'create') === 0, record.nodeCalls);

  operation('context that is not trusted', 'no host context, a remote workdir or a read-only one are refused before routing');
  ({record, result} = await drive(plugin, 'context', [
    {label: 'no context at all', call: 'roll', args: {task: task('ctx-b')}, inject: false},
    {label: 'remote workdir', call: 'roll', args: {task: task('ctx-c')}, context: {session_id: SESSION, workdir: work, workdir_is_local: false, workdir_is_read_only: false}},
    {label: 'read-only workdir', call: 'roll', args: {task: task('ctx-d')}, context: {session_id: SESSION, workdir: work, workdir_is_local: true, workdir_is_read_only: true}},
  ]));
  r = replies(record);
  check('no context, a remote workdir and a read-only one are refused', ['no context at all', 'remote workdir', 'read-only workdir'].every(k => first(r, k).ok === false),
    JSON.stringify(r).slice(0, 400) + result.stderr.slice(-300));
  check('nothing reached the router, the tasks API or a model', JSON.stringify(record.nodeCalls) === '[]' && count(record, 'create') === 0 && count(record, 'send') === 0,
    {node: record.nodeCalls, calls: (record.calls || []).map(c => c.name)});

  operation('wrong catalog, oversize task', 'the exact route must exist in the catalog; a task that does not fit the send limit is never cut');
  ({record, result} = await drive(plugin, 'catalog', [
    {label: 'model missing', fixture: {catalog: 'other-model'}},
    {label: 'roll', call: 'roll', args: {task: task('catalog-a')}},
    {label: 'empty', fixture: {catalog: 'empty'}},
    {label: 'roll empty', call: 'roll', args: {task: task('catalog-b')}},
    {label: 'matching', fixture: {catalog: 'matching'}},
    {label: 'oversize', call: 'roll', args: {task: task('catalog-c') + 'x'.repeat(40000)}},
  ]));
  r = replies(record);
  check('a nearby model or an empty catalog is refused, never substituted', ['roll', 'roll empty'].every(k => first(r, k).ok === false) && (first(r, 'roll').message || '').includes('Exact routed'),
    JSON.stringify(r).slice(0, 500) + result.stderr.slice(-300));
  check('the oversize task is refused with the limit named', first(r, 'oversize').ok === false && (first(r, 'oversize').message || '').includes('32768'), r.oversize);
  check('no task was created and no model input was sent', count(record, 'create') === 0 && count(record, 'send') === 0, record.calls);

  operation('draft in the wrong project directory', 'the created draft is checked before any input is sent; it is archived, or cleanup is handed back');
  ({record, result} = await drive(plugin, 'workdir', [
    {label: 'wrong directory', fixture: {workingDir: WIN ? 'C:\\other-project' : '/other-project'}},
    {label: 'roll', call: 'roll', args: {task: task('workdir-a')}},
    {label: 'archive fails now', fixture: {archiveFails: true}},
    {label: 'roll again', call: 'roll', args: {task: task('workdir-b')}},
    {label: 'archive works', fixture: {archiveFails: false}},
    {label: 'cleanup the stuck draft', call: 'cleanup', args: {operation: '@operation:roll again'}},
  ]));
  r = replies(record);
  const w1 = first(r, 'roll'), w2 = first(r, 'roll again');
  check('the first draft is blocked and archived, with no input sent', w1.ok && w1.result?.status === 'blocked' && w1.result?.draft_cleanup === 'archived' && count(record, 'send') === 0,
    JSON.stringify(w1).slice(0, 400) + result.stderr.slice(-300));
  check('when archiving fails the reply says cleanup is needed and names the cleanup call', w2.ok && w2.result?.draft_cleanup === 'needs_cleanup' && w2.result?.next_tool?.tool === 'cleanup',
    JSON.stringify(w2).slice(0, 400));
  check('the stuck draft is archived by the cleanup tool', first(r, 'cleanup the stuck draft').ok === true && count(record, 'archive') === 3, (record.calls || []).map(c => c.name));

  operation('the draft changed under us', 'a stale expectedRevision is rejected by the host: no run exists, nothing is resent');
  ({record, result} = await drive(plugin, 'revision', [
    {label: 'stale', fixture: {staleRevision: true}},
    {label: 'roll', call: 'roll', args: {task: task('revision')}},
    {label: 'status', call: 'status', args: {operation: '@operation:roll'}},
    {label: 'status again', call: 'status', args: {operation: '@operation:roll'}},
  ]));
  r = replies(record);
  const rv = first(r, 'roll');
  check("the send conflict is reported as unknown_send with the host's reason", rv.ok && rv.result?.status === 'unknown_send' && (rv.result?.error || '').includes('REVISION_CONFLICT'),
    JSON.stringify(rv).slice(0, 400) + result.stderr.slice(-300));
  check('no run exists and the input was offered exactly once', !(record.runs || []).length && count(record, 'send') === 1, record.calls);
  check('collecting status never resends', count(record, 'send') === 1 && first(r, 'status again').ok === true, (record.calls || []).map(c => c.name));

  operation('long transcript, stop and ownership', 'twelve pages are collected across two status calls; stop cancels through the scoped API; another session cannot touch the operation');
  ({record, result} = await drive(plugin, 'pages', [
    {label: 'roll', call: 'roll', args: {task: task('pages')}},
    {label: 'stop', call: 'stop', args: {operation: '@operation:roll'}},
    {label: 'cleanup of a stopping run', call: 'cleanup', args: {operation: '@operation:roll'}},
    {label: 'foreign status', call: 'status', args: {operation: '@operation:roll'}, as: 'someone-else'},
    {label: 'finished', fixture: {runStatus: 'completed', outputMessageId: 'out-final', pages: 12, finalText: '[Worker final report] twelve pages'}},
    {label: 'first status', call: 'status', args: {operation: '@operation:roll'}},
    {label: 'second status', call: 'status', args: {operation: '@operation:roll'}},
  ]));
  r = replies(record);
  check('stop answers stopping, which is not a claim that the run ended', first(r, 'stop').ok && first(r, 'stop').result?.status === 'stopping' && count(record, 'cancel') === 1, r.stop);
  check('cleanup of a stopping run is refused', first(r, 'cleanup of a stopping run').ok === false, r['cleanup of a stopping run']);
  check('another session cannot read the operation', first(r, 'foreign status').ok === false, r['foreign status']);
  const p1 = first(r, 'first status').result || {}, p2 = first(r, 'second status').result || {};
  check('the first status stops at the page bound and says collection is incomplete', p1.messages_complete === false && (p1.full_result_artifacts || []).length === 10,
    {messages_complete: p1.messages_complete, status: p1.status});
  check('the second status finishes all twelve pages and finds the exact final message', p2.messages_complete === true && (p2.full_result_artifacts || []).length === 12 && p2.output_available === true,
    {messages_complete: p2.messages_complete, output_available: p2.output_available});

  // -------------------------------------------------------------------------------------------------------------
  operation('stop to a confirmed cancelled state, cleanup with and without archive', 'stop says stopping; only a host-confirmed cancelled run is terminal; cleanup archives, or hands back the exact task ID');
  ({record, result} = await drive(plugin, 'cancelled', [
    {label: 'roll', call: 'roll', args: {task: task('cancel-a')}},
    {label: 'stop', call: 'stop', args: {operation: '@operation:roll'}},
    {label: 'status while stopping', call: 'status', args: {operation: '@operation:roll'}},
    {label: 'host confirms cancellation', fixture: {runStatus: 'cancelled'}},
    {label: 'status after cancel', call: 'status', args: {operation: '@operation:roll'}},
    {label: 'cleanup', call: 'cleanup', args: {operation: '@operation:roll'}},
  ]));
  r = replies(record);
  const sw = first(r, 'status while stopping').result || {}, sc = first(r, 'status after cancel').result || {};
  check('stop reports stopping and status keeps it non-terminal', first(r, 'stop').result?.status === 'stopping' && sw.status === 'stopping' &&
    (sw.next_action || '').includes('No automatic callback'), {stop: r.stop, sw});
  check('after the host confirms, status reports cancelled as terminal with no invented output', sc.status === 'cancelled' && sc.output_available === false &&
    (sc.next_action || '').includes('Cleanup archives'), sc);
  check('cleanup archives the cancelled task', first(r, 'cleanup').result?.status === 'cleaned' && count(record, 'archive') === 1, r.cleanup);
  ({record, result} = await drive(plugin, 'manual-cleanup', [
    {label: 'host without archive', fixture: {capabilities: 'no-archive'}},
    {label: 'roll', call: 'roll', args: {task: task('cancel-b')}},
    {label: 'stop', call: 'stop', args: {operation: '@operation:roll'}},
    {label: 'host confirms cancellation', fixture: {runStatus: 'cancelled'}},
    {label: 'cleanup', call: 'cleanup', args: {operation: '@operation:roll'}},
    {label: 'cleanup again', call: 'cleanup', args: {operation: '@operation:roll'}},
  ]));
  r = replies(record);
  const mc = first(r, 'cleanup').result || {};
  const taskId = (record.tasks || [])[0]?.taskId;
  check('without an archive API cleanup returns manual_cleanup_required with the exact task ID, repeatably', mc.status === 'manual_cleanup_required' &&
    mc.archived === false && taskId && mc.taskId === taskId && first(r, 'cleanup again').result?.taskId === taskId && count(record, 'archive') === 0,
    {mc, taskId, stderr: result.stderr.slice(-300)});

  // -------------------------------------------------------------------------------------------------------------
  operation('zero-config market install', 'plugin/ copied as is (no router.json, no build): the worker finds `agentcompass` on PATH, reads ~/.agent-compass/cindy-plugin/account-map.json, then roll -> status -> cleanup');
  const market = path.join(ROOT, 'market install', 'agentcompass');
  fs.cpSync(path.join(REPO, 'plugin'), market, {recursive: true});
  check('the installed copy has no router.json', !fs.existsSync(path.join(market, 'router.json')), fs.readdirSync(market));
  const zcBin = D('installed bin');
  const made = await run([python.exe, '-X', 'utf8', path.join(REPO, 'test', 'make_launcher.py'), zcBin, python.exe, '-X', 'utf8', path.join(CHECKOUT, 'agentcompass')]);
  const launcherFile = made.stdout.trim();
  check(`an installed-style \`agentcompass\` launcher is on PATH (${path.basename(launcherFile)})`, made.code === 0 && fs.existsSync(launcherFile) &&
    path.basename(launcherFile) === (WIN ? 'agentcompass.exe' : 'agentcompass'), made.stdout + made.stderr);
  const stateHome = path.join(home, '.agent-compass', 'cindy-plugin');
  fs.mkdirSync(stateHome, {recursive: true});
  const accountMap = [{routerProvider: 'codex', routerAccount: 'codex', providerId: 'codex-connection', agentKind: 'codex'},
                      {routerProvider: 'pi', routerAccount: 'codex', providerId: 'pi-openai-connection', agentKind: 'pi'}];
  fs.writeFileSync(path.join(stateHome, 'account-map.json'), JSON.stringify(accountMap));
  const zcEnv = {PATH: [zcBin, baseEnv.PATH].join(path.delimiter)};
  const zcTask = task('zero-config') + '零配置 market install\n';
  ({record, result} = await drive(market, 'zero-config', [
    {label: 'roll', call: 'roll', args: {task: zcTask}},
    {label: 'status', call: 'status', args: {operation: '@operation:roll'}},
    {label: 'finished', fixture: {runStatus: 'completed', outputMessageId: 'out-final', pages: 2, finalText: '[Worker final report] zero-config result'}},
    {label: 'status after completion', call: 'status', args: {operation: '@operation:roll'}},
    {label: 'cleanup', call: 'cleanup', args: {operation: '@operation:roll'}},
  ], {env: zcEnv}));
  r = replies(record);
  const zr = first(r, 'roll'), zop = zr.result?.operation || 'none';
  const zReceipt = readJson(path.join(stateHome, zop, 'receipt.json'));
  check('roll starts a run through the discovered command', zr.ok && zr.result?.status === 'running' && count(record, 'create') === 1 && count(record, 'send') === 1,
    JSON.stringify(zr).slice(0, 500) + result.stderr.slice(-300) + (record.workerStderr || ''));
  check('the real router answered natively for the Cindy session', zReceipt.router?.status === 'native' && zReceipt.router?.parent_id === SESSION, zReceipt.router);
  check('the account map from the home directory was applied to the exact catalog route',
    JSON.stringify(zReceipt.mappings) === JSON.stringify(accountMap) && (record.calls || []).find(c => c.name === 'create')?.route?.providerId === 'codex-connection',
    {mappings: zReceipt.mappings, create: (record.calls || []).find(c => c.name === 'create')});
  const zDone = first(r, 'status after completion').result || {};
  check('status collects the exact final message and cleanup archives', zDone.status === 'completed' && zDone.output_available &&
    (zDone.final_result_summary || '').includes('zero-config result') && first(r, 'cleanup').result?.status === 'cleaned', zDone);
  check('the receipt is under ~/.agent-compass/cindy-plugin and the installed copy is unchanged', fs.existsSync(path.join(stateHome, zop, 'receipt.json')) &&
    !fs.existsSync(path.join(market, 'router.json')), fs.readdirSync(market));

  // -------------------------------------------------------------------------------------------------------------
  operation('every Cindy harness through the real router', 'Claude max and high, and Pi, reach exact catalog routes with Cindy bypassPermissions; codex is the first operation');
  const harness = async (name, profile, plug, env = {}) => {
    const out = await drive(plug, `harness-${name}`, [
      {label: 'roll', call: 'roll', args: {task: task(name) + `FIXTURE-PROFILE: ${profile}\n`}},
      {label: 'finished', fixture: {runStatus: 'completed', outputMessageId: 'out-final', finalText: `[Worker final report] ${name}`}},
      {label: 'status', call: 'status', args: {operation: '@operation:roll'}},
      {label: 'cleanup', call: 'cleanup', args: {operation: '@operation:roll'}},
    ], {env});
    const rr = replies(out.record);
    const op = first(rr, 'roll').result?.operation || 'none';
    return {...out, r: rr, receipt: readJson(path.join(stateHome, op, 'receipt.json')), create: (out.record.calls || []).find(c => c.name === 'create') || {}};
  };
  const lifecycle = h => first(h.r, 'roll').result?.status === 'running' && first(h.r, 'status').result?.status === 'completed' &&
    first(h.r, 'status').result?.output_available === true && first(h.r, 'cleanup').result?.status === 'cleaned';
  for (const [name, profile, effort] of [['claude-max', 'deep', 'max'], ['claude-high', 'review', 'high']]) {
    const h = await harness(name, profile, plugin);
    const b = h.receipt.bundle || {};
    check(`${name}: the router chose claude/claude-opus-5-5 at ${effort} and the plugin made bypassPermissions explicit`,
      b.provider === 'claude' && b.harness === 'claude' && b.model === 'claude-opus-5-5' && b.effort === effort && b.modeId === 'bypassPermissions',
      {bundle: b, router: h.receipt.router?.status, stderr: h.result.stderr.slice(-300)});
    check(`${name}: Cindy creates cc/claude/claude-opus-5-5/${effort} with bypassPermissions and the run completes`,
      JSON.stringify(h.create.route) === JSON.stringify({agentKind: 'cc', providerId: 'claude', model: 'claude-opus-5-5', effort, fastMode: false}) &&
      h.create.permissionMode === 'bypassPermissions' && lifecycle(h), {create: h.create, replies: JSON.stringify(h.r).slice(0, 600)});
  }
  const pi = await harness('pi', 'explore', market, {...zcEnv, CLAUDE_CONFIG_DIR: noClaude});
  const pb = pi.receipt.bundle || {};
  check('pi: the router chose the Pi harness on the codex account with its launch model; the fixed full-tool worker is full-access',
    pb.provider === 'pi' && pb.harness === 'pi' && pb.account === 'codex' && pb.launch_model === 'openai-codex/gpt-6.1-sol' && pb.modeId === 'full-access',
    {bundle: pb, router: pi.receipt.router?.status, stderr: pi.result.stderr.slice(-300)});
  check('pi: Cindy creates the exact pi route on the mapped connection with bypassPermissions and the run completes',
    JSON.stringify(pi.create.route) === JSON.stringify({agentKind: 'pi', providerId: 'pi-openai-connection', model: 'openai-codex/gpt-6.1-sol', effort: pb.effort, fastMode: false}) &&
    pi.create.permissionMode === 'bypassPermissions' && lifecycle(pi), {create: pi.create, replies: JSON.stringify(pi.r).slice(0, 600)});

  // -------------------------------------------------------------------------------------------------------------
  operation('answers that are not a Cindy task, and fast mode', 'split (real router) and self come back unchanged and start nothing; a fast codex route maps to Cindy fastMode');
  ({record, result} = await drive(plugin, 'split', [{label: 'roll', call: 'roll', args: {task: task('split') + 'FIXTURE-PROFILE: split\n'}}]));
  const sp = first(replies(record), 'roll');
  check('split from the real router is returned as is (task_count 2) and nothing is created', sp.ok && sp.result?.status === 'split' && String(sp.result?.task_count) === '2' &&
    count(record, 'create') === 0 && count(record, 'send') === 0 && count(record, 'models') === 0, JSON.stringify(sp).slice(0, 500) + result.stderr.slice(-300));
  // The public roll command has no path that answers `self`, and turns fast mode on only with live capacity telemetry or
  // --fast; both are therefore driven by test/fixture_router.cjs, a stand-in for the router, through the real worker.
  const fixturePlugin = path.join(ROOT, 'cindy plugin fixture router');
  const fixtureBuild = await run([...builder, '--output', fixturePlugin, '--router-cmd', JSON.stringify([process.execPath, path.join(REPO, 'test', 'fixture_router.cjs')])]);
  check('a plugin bound to the fixture router builds', fixtureBuild.code === 0, fixtureBuild.stdout.slice(0, 300) + fixtureBuild.stderr.slice(-300));
  ({record, result} = await drive(fixturePlugin, 'self-and-fast', [
    {label: 'self', call: 'roll', args: {task: task('self') + 'FIXTURE-ROUTER: self\n'}},
    {label: 'fast', call: 'roll', args: {task: task('fast') + 'FIXTURE-ROUTER: fast\n'}},
  ]));
  r = replies(record);
  const selfReply = first(r, 'self');
  check('self (fixture router) is returned as is and starts nothing', selfReply.ok && selfReply.result?.status === 'self' && selfReply.result?.fixture_router === true &&
    (selfReply.result?.next_action || '').includes('current session'), JSON.stringify(selfReply).slice(0, 400) + result.stderr.slice(-300));
  const fastCreate = (record.calls || []).find(c => c.name === 'create') || {};
  check('only the fast route created a task: one create, one send', count(record, 'create') === 1 && count(record, 'send') === 1, (record.calls || []).map(c => c.name));
  check('fast (fixture router): codex/gpt-6.1-sol fast becomes Cindy fastMode true with bypassPermissions', first(r, 'fast').ok &&
    JSON.stringify(fastCreate.route) === JSON.stringify({agentKind: 'codex', providerId: 'codex', model: 'gpt-6.1-sol', effort: 'high', fastMode: true}) &&
    fastCreate.permissionMode === 'bypassPermissions', {fast: first(r, 'fast'), create: fastCreate});
  report.fast_mode_note = 'The real router chose no fast route in this sandbox: fast mode needs live, non-stale capacity telemetry ' +
    'for the codex window or an explicit --fast, which the plugin does not pass. The fast mapping is verified through test/fixture_router.cjs.';
} catch (error) {
  operation('driver error', 'the sandbox driver itself failed');
  check('the driver completed', false, error.stack || String(error));
} finally {
  scorer.close();
}

const checks = report.operations.flatMap(o => o.checks);
report.finished_at = new Date().toISOString();
report.summary = {operations: report.operations.length, checks: checks.length, passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length,
  artifacts: art};
if (report.summary.failed) exitCode = 1;
const reportFile = process.env.CINDY_SANDBOX_REPORT || path.join(ROOT, 'report', 'sandbox-e2e-report.json');
fs.mkdirSync(path.dirname(reportFile), {recursive: true});
fs.writeFileSync(reportFile, JSON.stringify(report, null, 1) + '\n');
if (process.env.CINDY_REPORT_MERGE_INTO) {
  const combined = readJson(process.env.CINDY_REPORT_MERGE_INTO);
  combined.kind = report.kind;
  combined.runs = {...(combined.runs || {}), [LABEL]: report};
  combined.summary = Object.fromEntries(Object.entries(combined.runs).map(([k, v]) => [k, v.summary]));
  fs.writeFileSync(process.env.CINDY_REPORT_MERGE_INTO, JSON.stringify(combined, null, 1) + '\n');
}
console.log(`\n${report.summary.passed}/${report.summary.checks} checks passed in ${report.summary.operations} operations; report: ${reportFile}`);
process.exit(exitCode);
