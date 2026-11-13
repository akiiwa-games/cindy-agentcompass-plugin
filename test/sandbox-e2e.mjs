// Sandbox end-to-end, in an isolated home with no credentials and no network beyond one local fixture port:
//   the market install (plugin/ as is: main.js in a fake Cindy host, the real worker.cjs as a real node child over
//   JSON-RPC stdio) -> the built-in AgentCompass engine over the catalog a real Cindy 0.1.121 reported;
//   scripts/build_plugin.py and config.json {"engine":"cli"} -> the real public `agentcompass roll` -> the router's
//   classifier, allocator and ledger.
//
//   node test/sandbox-e2e.mjs
//
// Substituted, and only that: the Cindy host and its experimental tasks API (test/zero_cindy_host.mjs), the model behind
// the router's classifier (a local OpenAI-compatible server below) and the provider CLI (a discovery placeholder; Cindy,
// not AgentCompass, would run the worker). Real-host evidence is docs/real-cindy-0.1.121/README.md.
//
// Environment:
//   AGENTCOMPASS_CHECKOUT   AgentCompass source checkout (default: ../AgentCompass next to this repository, or next to its main checkout from a git worktree)
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
import {CASE_FILE, defaultCheckout} from '../scripts/default-checkout.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const CHECKOUT = path.resolve(process.env.AGENTCOMPASS_CHECKOUT || defaultCheckout(REPO));
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
// The fleet fixture of the checkout, completed with the `families` declaration of its catalog as AgentCompass's own tests do (v0.6.0 needs it).
const referenceFleet = path.join(state, 'reference-accounts.json');
{
  const readDoc = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const fleet = readDoc(path.join(CHECKOUT, 'skills', 'agent-compass', 'scripts', 'fixtures', 'reference-accounts.json'));
  fleet.families = readDoc(path.join(CHECKOUT, 'skills', 'agent-compass', 'references', 'accounts.json')).families;
  // The Codex Plus plan has a weekly and a five-hour window (plan-templates.json), and the usage cache below reports both. The fixture's own Codex
  // account declares only the weekly one, and a window that is observed but not declared has no capacity: every Codex and Pi row would then be out
  // of automatic routing (`five_hour capacity_unknown`), which is what routed everything to Claude before.
  const plusWindows = readDoc(path.join(CHECKOUT, 'skills', 'agent-compass', 'references', 'plan-templates.json')).codex.plus.windows;
  fleet.accounts.codex.windows = plusWindows;
  fs.writeFileSync(referenceFleet, JSON.stringify(fleet));
}
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
  ROUTER_ACCOUNTS_FILE: referenceFleet,
  ROUTER_ACCOUNTS_OVERRIDE: path.join(state, 'override.json'), ROUTER_LEDGER: path.join(state, 'router-ledger.jsonl'),
  ROUTER_DISPATCH_DB: path.join(state, 'dispatch.sqlite3'), ROUTER_USAGE_CACHE: path.join(state, 'usage.json'), ROUTER_SCORE_CACHE: 'off',
  // The CLI refreshes its public reference data from the network by default; the sandbox routes on the checkout's own data and makes no request.
  AGENTCOMPASS_PUBLIC_DATA: 'off',
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
const claims = Buffer.from(JSON.stringify({'https://api.openai.com/auth': {chatgpt_plan_type: 'plus', chatgpt_account_id: 'fixture'}})).toString('base64url');
fs.writeFileSync(path.join(baseEnv.CODEX_HOME, 'auth.json'), JSON.stringify({tokens: {account_id: 'fixture', access_token: 'fixture-only', id_token: `e30.${claims}.fixture`}}));
// The collector's usage cache for the two signed-in accounts: AgentCompass v0.6.0 prices a route from an observed quota window and routes
// nothing automatically on an account it has never seen one of. A reading counts only for the credential it was taken with, so each row
// carries the key AgentCompass derives from the credential file (sha256 over the resolved home and the token), and the plan it reported.
{
  const key = (...values) => crypto.createHash('sha256').update(values.map(v => String(v ?? '')).join('\0')).digest('hex');
  const window = (id, used, hours) => ({id, used_pct: used, resets_at: new Date(Date.now() + hours * 3600 * 1000).toISOString()});
  const row = (credential_key, plan_label, windows, extra = {}) => ({fetched_at: new Date().toISOString(), stale: false, available: true,
    credential_key, plan_label, windows, ...extra});
  fs.writeFileSync(path.join(state, 'usage.json'), JSON.stringify({providers: {
    codex: row(key(fs.realpathSync.native(baseEnv.CODEX_HOME), 'fixture-only:fixture'), 'plus', [window('usage', 20, 100), window('five_hour', 10, 3)]),
    claude: row(key(fs.realpathSync.native(baseEnv.CLAUDE_CONFIG_DIR), 'fixture-only'), 'max20',
      [window('five_hour', 10, 3), window('seven_day', 20, 100), window('weekly_fable', 10, 100)], {plan_source: 'profile_api'}),
  }}));
}
const piAgentDir = path.join(home, '.pi', 'agent');
fs.mkdirSync(piAgentDir, {recursive: true});
fs.writeFileSync(path.join(piAgentDir, 'auth.json'), JSON.stringify({'openai-codex': {type: 'oauth', access: `e30.${claims}.fixture`, accountId: 'fixture'}}));

// ---- the model behind the classifier: a fixed small-edit profile, changed by a `FIXTURE-PROFILE: <name>` line in the task
// so each harness is reached through the real allocator (profiles found by probing this fleet; the router decides).
const PROFILES = {
  deep: {work_kind: 'direction_reasoning', reasoning_depth: 4, axis_demand: {divergence: 3, coding: 3, aesthetics: 0, tool_operation: 1},
    code_complexity: 3, expected_hours: 3, reason: 'fixture: deep open-ended design'},
  review: {work_kind: 'debug_review', reasoning_depth: 3, reason: 'fixture: a focused review'},
  explore: {work_kind: 'exploration_analysis', interaction_style: 'exploration', code_complexity: 0, access: 'read-only',
    axis_demand: {divergence: 2, coding: 0, aesthetics: 0, tool_operation: 1}, reason: 'fixture: read-only exploration'},
  split: {multi_task: true, task_count: '2', reason: 'fixture: two independent deliverables'},
};
const scorerRequests = [];
const scorer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', d => chunks.push(d)).on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const user = (body.messages || []).find(m => m.role === 'user')?.content || '';
    scorerRequests.push({path: req.url, model: body.model, chars: user.length});
    const profile = {work_kind: 'general_implementation', reasoning_depth: 2, code_complexity: 1, access: 'write',
      axis_demand: {divergence: 1, coding: 1, aesthetics: 0, tool_operation: 1}, needs_visual: false, needs_gui: false, local_only: false,
      wants_fast: false, read_only_review: false, expected_hours: 0.5,
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
  const nodeUnits = await run([process.execPath, '--test', ...['test_market_contract.mjs', 'test_engine.mjs', 'test_cindy_plugin.mjs', 'test_worker_bridge.mjs'].map(f => path.join(REPO, 'test', f))],
    {cwd: REPO, env: {AGENTCOMPASS_PYTHON: python.exe, AGENTCOMPASS_CHECKOUT: CHECKOUT}});
  const [nodePass, nodeFail] = ['pass', 'fail'].map(k => Number((nodeUnits.stdout.match(new RegExp(`ℹ ${k} (\\d+)`)) || [])[1]));
  report.unit_tests = {node: {pass: nodePass, fail: nodeFail}};
  check(`node --test: ${nodePass} passed, ${nodeFail} failed`, nodeUnits.code === 0 && nodePass >= 50 && nodeFail === 0, nodeUnits.stdout.slice(-1500) + nodeUnits.stderr.slice(-500));
  check('the unit tests compared the case file with this checkout', nodeUnits.stdout.includes(`case file compared with ${path.join(CHECKOUT, CASE_FILE)}`), nodeUnits.stdout.slice(-1500));
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
  const stock = await ac(['roll', '--task', task('stock-cindy')], {env: {CINDY_INPUT_HANDOFF_ROUTE: 'fixture-route-value', CLAUDE_SESSION_ID: 'provider-thread-from-cindy-shell'}});
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
  check('the router chose a bundle of a Cindy harness (provider = harness, a model and an effort), not fast mode: nothing here asks for it',
    ['claude', 'codex', 'pi'].includes(bundle.harness) && bundle.provider === bundle.harness && Boolean(bundle.model) && Boolean(bundle.effort) && !bundle.fast, bundle);
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
  check('cleanup of a running task is refused and names the run', first(r, 'cleanup while running').result?.status === 'cleanup_refused' &&
    /run-1 is running/.test(first(r, 'cleanup while running').result?.reason || '') && count(record, 'archive') === 1, r['cleanup while running']);
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
  check('status keeps saying unknown_create and tells the caller to inspect, not resend', st.ok && st.result?.status === 'unknown_create' && (st.result?.next_action || '').includes('nothing is created again'), st);
  check('rolling the same assignment again creates nothing new', rep.ok && rep.result?.status === 'unknown_create' && count(record, 'create') === 1, (record.calls || []).map(c => c.name));
  check('no input was ever sent and no run exists', count(record, 'send') === 0 && !(record.runs || []).length, record.calls);
  check('the orphan draft exists in the host and the plugin refuses to archive what it never saw', (record.tasks || []).length === 1 && cl.ok &&
    cl.result?.status === 'cleanup_refused' && (cl.result?.reason || '').includes('Inspect the Cindy task list') && count(record, 'archive') === 0, {tasks: (record.tasks || []).length, cleanup: cl});

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

  operation('the draft changed under us', 'a stale expectedRevision is a coded host refusal: send_rejected, the draft archived, no run exists, nothing is resent');
  ({record, result} = await drive(plugin, 'revision', [
    {label: 'stale', fixture: {staleRevision: true}},
    {label: 'roll', call: 'roll', args: {task: task('revision')}},
    {label: 'status', call: 'status', args: {operation: '@operation:roll'}},
    {label: 'status again', call: 'status', args: {operation: '@operation:roll'}},
  ]));
  r = replies(record);
  const rv = first(r, 'roll');
  check("the send conflict is reported as send_rejected with the host's code, and the draft is archived", rv.ok && rv.result?.status === 'send_rejected' &&
    rv.result?.error_code === 'REVISION_CONFLICT' && rv.result?.draft_cleanup === 'archived' && count(record, 'archive') === 1, JSON.stringify(rv).slice(0, 400) + result.stderr.slice(-300));
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
    {label: 'cleanup before all pages', call: 'cleanup', args: {operation: '@operation:roll'}},
    {label: 'second status', call: 'status', args: {operation: '@operation:roll'}},
    {label: 'cleanup', call: 'cleanup', args: {operation: '@operation:roll'}},
  ]));
  r = replies(record);
  check('stop answers stopping, which is not a claim that the run ended', first(r, 'stop').ok && first(r, 'stop').result?.status === 'stopping' && count(record, 'cancel') === 1, r.stop);
  check('cleanup of a stopping run is refused and points to stop', first(r, 'cleanup of a stopping run').result?.status === 'cleanup_refused' &&
    first(r, 'cleanup of a stopping run').result?.next_tool?.tool === 'stop', r['cleanup of a stopping run']);
  check('another session cannot read the operation', first(r, 'foreign status').ok === false, r['foreign status']);
  const p1 = first(r, 'first status').result || {}, p2 = first(r, 'second status').result || {};
  check('review 4: the first status stops at the page bound, says collection is incomplete and points to status, not cleanup', p1.messages_complete === false &&
    (p1.full_result_artifacts || []).length === 10 && p1.next_tool?.tool === 'status' && !/Cleanup archives/.test(p1.next_action || '') && /Call status again/.test(p1.next_action || ''),
    {messages_complete: p1.messages_complete, status: p1.status, next_tool: p1.next_tool, next_action: p1.next_action});
  check('review 4: cleanup before all pages are read is refused', first(r, 'cleanup before all pages').result?.status === 'cleanup_refused' &&
    /messages_complete/.test(first(r, 'cleanup before all pages').result?.reason || ''), r['cleanup before all pages']);
  check('the second status finishes all twelve pages, finds the exact final message and points to cleanup', p2.messages_complete === true &&
    (p2.full_result_artifacts || []).length === 12 && p2.output_available === true && p2.next_tool?.tool === 'cleanup',
    {messages_complete: p2.messages_complete, output_available: p2.output_available});
  check('cleanup after all pages archives', first(r, 'cleanup').result?.status === 'cleaned', r.cleanup);

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
    {label: 'status', call: 'status', args: {operation: '@operation:roll'}},
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
  // The market install: plugin/ copied as is. No router.json, no AgentCompass CLI, no account map: the built-in engine
  // routes over the catalog Cindy 0.1.121 really reported (test/fixtures), with no Codex quota telemetry unless a
  // scenario writes one.
  const market = path.join(ROOT, 'market install', 'agentcompass');
  fs.cpSync(path.join(REPO, 'plugin'), market, {recursive: true});
  const stateHome = path.join(home, '.agent-compass', 'cindy-plugin');
  const REAL = readJson(path.join(REPO, 'test', 'fixtures', 'cindy-0.1.121-catalog.json'));
  const builtinEnv = {CODEX_HOME: D('codex home without telemetry')};
  // A Codex CLI rate-limit snapshot, as codex writes it into ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
  // A Plus plan declares both windows the log reports; under AgentCompass v0.6.0 a Pro plan with a five-hour window takes every Codex row out of routing.
  const telemetry = (name, used) => {
    const dir = D(`codex home ${name}`), day = path.join(dir, 'sessions', '2026', '11', '03');
    fs.mkdirSync(day, {recursive: true});
    fs.writeFileSync(path.join(day, 'rollout-sandbox.jsonl'), JSON.stringify({type: 'event_msg', payload: {type: 'token_count', rate_limits: {limit_id: 'codex',
      primary: {used_percent: used, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 7200},
      secondary: {used_percent: used, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 86400}, plan_type: 'plus'}}}) + '\n');
    return {CODEX_HOME: dir};
  };
  const cliName = WIN ? 'agentcompass.exe' : 'agentcompass';
  const reachable = env => [...(env.PATH || baseEnv.PATH).split(path.delimiter), path.join(home, '.local', 'bin')].filter(d => fs.existsSync(path.join(d, cliName)));
  const isRow = (route, catalog) => catalog.models.some(row => ['agentKind', 'providerId', 'model'].every(k => row.route[k] === route?.[k]) &&
    (row.efforts || [row.route.effort]).includes(route.effort) && (!route.fastMode || row.supportsFastMode));
  const builtinLife = async (name, taskText, {catalog = 'real', env = builtinEnv, classifierProfile = null} = {}) => {
    const out = await drive(market, `builtin-${name}`, [
      {label: 'catalog', fixture: {catalog, ...(classifierProfile ? {classifierProfile} : {})}},
      {label: 'roll', call: 'roll', args: {task: taskText}},
      {label: 'status while running', call: 'status', args: {operation: '@operation:roll'}},
      {label: 'finished', fixture: {runStatus: 'completed', outputMessageId: 'out-final', pages: 2, finalText: `[Worker final report] ${name}`}},
      {label: 'status', call: 'status', args: {operation: '@operation:roll'}},
      {label: 'cleanup', call: 'cleanup', args: {operation: '@operation:roll'}},
    ], {env});
    const rr = replies(out.record);
    const op = first(rr, 'roll').result?.operation || 'none';
    const sent = (out.record.sent || [])[0];
    return {...out, r: rr, receipt: readJson(path.join(stateHome, op, 'receipt.json')), create: (out.record.calls || []).find(c => c.name === 'create') || {},
      sentText: sent ? fs.readFileSync(sent.file, 'utf8') : ''};
  };
  const lifecycle = h => first(h.r, 'roll').result?.status === 'running' && first(h.r, 'status').result?.status === 'completed' &&
    first(h.r, 'status').result?.output_available === true && first(h.r, 'status').result?.messages_complete === true && first(h.r, 'cleanup').result?.status === 'cleaned';

  operation('zero-config market install: built-in engine', 'plugin/ copied as is: no router.json, no AgentCompass CLI anywhere, no account map; the built-in engine routes over the real Cindy 0.1.121 catalog, then roll -> status -> cleanup');
  check('the installed copy has no router.json, no config.json or account map, and no AgentCompass CLI is reachable', !fs.existsSync(path.join(market, 'router.json')) &&
    !fs.existsSync(path.join(stateHome, 'config.json')) && !fs.existsSync(path.join(stateHome, 'account-map.json')) && reachable(baseEnv).length === 0, reachable(baseEnv));
  const zcTask = task('zero-config') + '零配置 market install\n';
  const zc = await builtinLife('zero-config', zcTask);
  check('roll starts one run through the built-in engine', first(zc.r, 'roll').ok && zc.receipt.engine === 'builtin' && zc.receipt.router?.status === 'native' &&
    zc.receipt.router?.engine === 'builtin' && count(zc.record, 'create') === 1 && count(zc.record, 'send') === 1,
    JSON.stringify(first(zc.r, 'roll')).slice(0, 500) + zc.result.stderr.slice(-300) + (zc.record.workerStderr || ''));
  check('Cindy creates a row of its own catalog (codex on the openai connection) with bypassPermissions', isRow(zc.create.route, REAL) &&
    zc.create.route.agentKind === 'codex' && zc.create.route.providerId === 'openai' && zc.create.permissionMode === 'bypassPermissions', zc.create);
  check('the decision is explained: work kind, profile_source classifier, classifier_model, wants_fast, axis_demand, score, alternatives, quota source; the classification asked Cindy once, over the quick-text channel',
    Boolean(zc.receipt.router?.decision?.work_kind && zc.receipt.router?.decision?.profile_source === 'classifier' &&
    zc.receipt.router?.decision?.classifier_model === 'fixture-quick-text' && typeof zc.receipt.router?.decision?.wants_fast === 'boolean' && Boolean(zc.receipt.router?.decision?.axis_demand) &&
    zc.receipt.router.decision.alternatives?.length && zc.receipt.router.decision.quota?.source === 'codex-cli-sessions' &&
    zc.record.oneshotCalls?.length === 1 && zc.record.oneshotCalls[0].expectJson === true && count(zc.record, 'create') === 1), zc.receipt.router?.decision);
  check('the text sent to Cindy is the whole task byte for byte plus the return channel', zc.sentText.startsWith(zcTask) && zc.sentText.includes('Cindy plugin task return channel') &&
    zc.receipt.prompt === zc.sentText, [zc.sentText.length, zcTask.length]);
  check('status reports running, then collects the exact final message; cleanup archives', first(zc.r, 'status while running').result?.status === 'running' && lifecycle(zc) &&
    (first(zc.r, 'status').result?.final_result_summary || '').includes('zero-config'), JSON.stringify(zc.r).slice(0, 700));

  operation('built-in engine: every Cindy harness', 'an edit, an exploration and a review on the full catalog, then a catalog of one harness only (Pi, Claude): the route is always an exact catalog row of a Cindy harness with its launcher mode, through to cleanup');
  const WITH_CLAUDE = {models: [...REAL.models, {route: {agentKind: 'cc', providerId: 'anthropic', model: 'claude-opus-5-5'}, efforts: ['low', 'medium', 'high', 'max']},
    {route: {agentKind: 'cc', providerId: 'anthropic', model: 'claude-sonnet-5-5'}, efforts: ['low', 'medium', 'high', 'max']}]};
  // Which harness wins on a catalog with several is the engine's net-score decision and is not asserted; a catalog with one harness leaves only that one.
  const LAUNCHER_MODE = {cc: 'bypassPermissions', codex: 'full-access', pi: 'full-access'};
  for (const [name, text, only, catalog, classifierProfile] of [
    ['edit', 'Rename the helper foo to bar in util.py and update its two callers.', null, 'real+claude',
      {work_kind: 'general_implementation', reasoning_depth: 1, code_complexity: 1}],
    ['exploration', 'Investigate why the login request fails: trace it through logs/ and the auth module and report the findings only.', null, 'real+claude',
      {work_kind: 'exploration_analysis', interaction_style: 'exploration', code_complexity: 0, access: 'read-only',
        axis_demand: {divergence: 2, coding: 0, aesthetics: 0, tool_operation: 1}}],
    ['review', 'Review the diff in src/auth for security regressions and subtle bugs (read-only review).', null, 'real+claude',
      {work_kind: 'debug_review', reasoning_depth: 3, code_complexity: 0, access: 'read-only', read_only_review: true, axis_demand: {divergence: 1, coding: 2, aesthetics: 0, tool_operation: 1}}],
    ['pi only', 'Investigate why the login request fails: trace it through logs/ and the auth module and report the findings only.', 'pi', 'pi-only',
      {work_kind: 'exploration_analysis', interaction_style: 'exploration', code_complexity: 0, access: 'read-only',
        axis_demand: {divergence: 2, coding: 0, aesthetics: 0, tool_operation: 1}}],
    ['claude only', 'Review the diff in src/auth for security regressions and subtle bugs (read-only review).', 'cc', 'claude-only',
      {work_kind: 'debug_review', reasoning_depth: 3, code_complexity: 0, access: 'read-only', read_only_review: true, axis_demand: {divergence: 1, coding: 2, aesthetics: 0, tool_operation: 1}}]]) {
    const h = await builtinLife(`harness-${name.replace(' ', '-')}`, `${text} [${name}-${Date.now()}]`, {catalog, classifierProfile});
    const b = h.receipt.bundle || {};
    const kind = h.create.route?.agentKind;
    check(`${name}: the built-in engine chose ${kind} (${b.model}/${b.effort})${only ? `, the only harness the catalog has` : ''}, with the launcher mode of that harness`,
      (only ? kind === only : kind in LAUNCHER_MODE) && b.modeId === LAUNCHER_MODE[kind] && b.providerId === h.create.route?.providerId,
      {bundle: b, kind: h.receipt.router?.decision?.work_kind, stderr: h.result.stderr.slice(-300)});
    check(`${name}: Cindy creates that exact catalog row with bypassPermissions and the run completes`, isRow(h.create.route, WITH_CLAUDE) &&
      h.create.permissionMode === 'bypassPermissions' && lifecycle(h), {create: h.create, replies: JSON.stringify(h.r).slice(0, 600)});
  }

  operation('built-in split, self, fast and quota', 'split and self come back from the built-in engine and start nothing; fast mode follows the classified profile and the Codex quota telemetry; an exhausted Codex window moves the route to Claude');
  ({record, result} = await drive(market, 'builtin-split-self', [
    {label: 'catalog', fixture: {
      catalog: 'real',
      classifierProfiles: [
        {multi_task: true, task_count: '2', reason: 'two independent tasks'},
        {multi_task: true, task_count: '3', reason: 'three independent tasks'},
        {self: true, reason: 'conceptual question for current session'},
        {self: true, reason: 'explicitly requested direct answer in current session'},
      ],
    }},
    {label: 'split', call: 'roll', args: {task: 'Two independent tasks:\n1. Add a dark theme to the settings page.\n2. Fix the CSV export encoding bug in report.py.'}},
    {label: 'split zh', call: 'roll', args: {task: '以下是互不相关的任务：\n1. 给设置页加深色主题\n2. 修复 report.py 的 CSV 编码\n3. 升级 lodash'}},
    {label: 'self', call: 'roll', args: {task: 'What is the difference between a mutex and a semaphore?'}},
    {label: 'self zh', call: 'roll', args: {task: '直接回答：Python 的 GIL 是什么？'}},
  ], {env: builtinEnv}));
  r = replies(record);
  check('split: task_count 2 and 3 from the built-in engine, with the next action for the parent', first(r, 'split').result?.status === 'split' && first(r, 'split').result?.task_count === '2' &&
    first(r, 'split zh').result?.task_count === '3' && first(r, 'split').result?.engine === 'builtin' && (first(r, 'split').result?.next_action || '').includes('Split it'),
    JSON.stringify(r).slice(0, 600) + result.stderr.slice(-300));
  check('self: both come back as self from the built-in engine', ['self', 'self zh'].every(k => first(r, k).result?.status === 'self' && first(r, k).result?.engine === 'builtin'), JSON.stringify(r).slice(0, 600));
  check('split and self created no worker task and sent no worker input', count(record, 'create') === 0 && count(record, 'send') === 0, (record.calls || []).map(c => c.name));
  const fastTask = n => `Use fast mode: rename the helper foo to bar in util.py and update its two callers. [${n}-${Date.now()}]`;
  const fastProfile = {wants_fast: true, urgency: 'high'};
  const fast = await builtinLife('fast', fastTask('fast'), {env: telemetry('fast', 12), classifierProfile: fastProfile});
  check('fast with fresh telemetry (12% used): Cindy creates codex fastMode true on a row that supports it', fast.create.route?.agentKind === 'codex' && fast.create.route?.fastMode === true &&
    isRow(fast.create.route, REAL) && fast.receipt.router?.decision?.quota?.used_percent === 12 && lifecycle(fast), {create: fast.create, quota: fast.receipt.router?.decision?.quota});
  const busy = await builtinLife('fast-busy', fastTask('busy'), {env: telemetry('busy', 70), classifierProfile: fastProfile});
  check('fast asked but the Codex window is 70% used: no fast mode', busy.create.route?.fastMode === false && lifecycle(busy), busy.create);
  const blind = await builtinLife('fast-blind', fastTask('blind'), {classifierProfile: fastProfile});
  check('fast asked with no telemetry at all: no fast mode', blind.create.route?.fastMode === false && blind.receipt.router?.decision?.quota?.status === 'unknown' && lifecycle(blind), blind.create);
  const drained = await builtinLife('quota-exhausted', `Rename the helper foo to bar in util.py and update its two callers. [drained-${Date.now()}]`,
    {catalog: 'real+claude', env: telemetry('drained', 97)});
  check('quota: with the Codex window 97% used the edit goes to Claude on its own connection', drained.create.route?.agentKind === 'cc' &&
    drained.receipt.router?.decision?.quota?.status === 'exhausted' && lifecycle(drained),
    {create: drained.create, quota: drained.receipt.router?.decision?.quota});

  // -------------------------------------------------------------------------------------------------------------
  operation('review 1: receipt save fails after an accepted send', 'the run exists although its receipt could not be written: roll returns operation, task_id and run_id; status settles the `sending` receipt from the host runs; nothing is resent');
  ({record, result} = await drive(market, 'review1-save', [
    {label: 'catalog', fixture: {catalog: 'real', saveFault: 'after-send'}},
    {label: 'roll', call: 'roll', args: {task: task('review1-save')}},
    {label: 'status', call: 'status', args: {operation: '@operation:roll'}},
  ], {env: builtinEnv}));
  r = replies(record);
  const sv = first(r, 'roll').result || {};
  check('roll answers with the handles and says the receipt was not saved', first(r, 'roll').ok && sv.operation && sv.task_id && sv.run_id && sv.receipt_saved === false &&
    count(record, 'saveFault') === 1, JSON.stringify(first(r, 'roll')).slice(0, 500) + result.stderr.slice(-300));
  check('status settles it to that run without a second send', first(r, 'status').result?.runId === sv.run_id && first(r, 'status').result?.status === 'running' &&
    count(record, 'send') === 1 && ['accepted', 'reconciled'].includes(readJson(path.join(stateHome, sv.operation || 'none', 'receipt.json')).delivery), first(r, 'status'));
  ({record, result} = await drive(market, 'review1-crash', [
    {label: 'catalog', fixture: {catalog: 'real'}},
    {label: 'roll', call: 'roll', args: {task: task('review1-crash')}},
    {label: 'crash between send and receipt', fixture: {receiptPatch: {operation: '@operation:roll', set: {state: 'sending'}, unset: ['runId', 'delivery']}}},
    {label: 'cleanup before settling', call: 'cleanup', args: {operation: '@operation:roll'}},
    {label: 'status', call: 'status', args: {operation: '@operation:roll'}},
  ], {env: builtinEnv}));
  r = replies(record);
  check('a persisted `sending` receipt with no runId is settled by status (and cleanup first settles it, then refuses the running run)',
    first(r, 'cleanup before settling').result?.status === 'cleanup_refused' && first(r, 'status').result?.runId === 'run-1' && count(record, 'send') === 1 && count(record, 'archive') === 0,
    JSON.stringify(r).slice(0, 700));

  operation('review 2: definite refusal versus unknown delivery', 'a coded refusal before any run exists is send_rejected and the draft is archived; a lost answer is unknown_send and a run is claimed only if its input message is this prompt');
  ({record, result} = await drive(market, 'review2-rejected', [
    {label: 'catalog', fixture: {catalog: 'real', staleRevision: true}},
    {label: 'roll', call: 'roll', args: {task: task('review2-rejected')}},
    {label: 'status', call: 'status', args: {operation: '@operation:roll'}},
    {label: 'cleanup', call: 'cleanup', args: {operation: '@operation:roll'}},
  ], {env: builtinEnv}));
  r = replies(record);
  const rj = first(r, 'roll').result || {};
  check('REVISION_CONFLICT is send_rejected with its code, the draft archived, no run', rj.status === 'send_rejected' && rj.error_code === 'REVISION_CONFLICT' && rj.draft_cleanup === 'archived' &&
    !(record.runs || []).length && count(record, 'send') === 1, JSON.stringify(first(r, 'roll')).slice(0, 500) + result.stderr.slice(-300));
  check('status keeps send_rejected and points to cleanup; cleanup reports it cleaned without archiving twice', first(r, 'status').result?.status === 'send_rejected' &&
    first(r, 'status').result?.next_tool?.tool === 'cleanup' && first(r, 'cleanup').result?.status === 'cleaned' && count(record, 'archive') === 1, JSON.stringify(r).slice(0, 700));
  ({record, result} = await drive(market, 'review2-foreign', [
    {label: 'catalog', fixture: {catalog: 'real', sendFault: 'lost-answer', inputOverride: 'a message the user typed into the draft'}},
    {label: 'roll', call: 'roll', args: {task: task('review2-foreign')}},
    {label: 'status', call: 'status', args: {operation: '@operation:roll'}},
    {label: 'cleanup', call: 'cleanup', args: {operation: '@operation:roll'}},
  ], {env: builtinEnv}));
  r = replies(record);
  check('a run on the same route whose input is not this prompt is not claimed; cleanup refuses the unconfirmed delivery',
    first(r, 'roll').result?.status === 'unknown_send' && first(r, 'status').result?.status === 'unknown_send' && first(r, 'cleanup').result?.status === 'cleanup_refused' &&
    count(record, 'archive') === 0 && count(record, 'send') === 1, JSON.stringify(r).slice(0, 800));
  ({record, result} = await drive(market, 'review2-claim', [
    {label: 'catalog', fixture: {catalog: 'real', sendFault: 'lost-answer'}},
    {label: 'roll', call: 'roll', args: {task: task('review2-claim')}},
    {label: 'status', call: 'status', args: {operation: '@operation:roll'}},
  ], {env: builtinEnv}));
  r = replies(record);
  check('a lost answer is unknown_send; the run whose input message is this prompt is claimed by status, never resent',
    first(r, 'roll').result?.status === 'unknown_send' && first(r, 'status').result?.runId === 'run-1' && count(record, 'send') === 1 && count(record, 'readMessages') >= 1,
    JSON.stringify(r).slice(0, 600));

  operation('review 5: one slow route does not block other sessions', 'session A rolls through the real AgentCompass CLI (seconds of routing) while session B stops its own run: B is answered first');
  ({record, result} = await drive(plugin, 'review5-concurrency', [
    {label: 'B roll', call: 'roll', args: {task: task('review5-b')}, as: 'session-b'},
    {label: 'A rolls while B stops', concurrent: [
      {label: 'A roll', call: 'roll', args: {task: task('review5-a')}},
      {label: 'B stop', call: 'stop', args: {operation: '@operation:B roll'}, as: 'session-b'},
    ]},
  ]));
  r = replies(record);
  const order = (record.results || []).find(x => x.label === 'A rolls while B stops')?.order || [];
  check('B stop is answered before A finishes routing; both succeed', order[0] === 'B stop' && first(r, 'B stop').result?.status === 'stopping' && first(r, 'A roll').result?.status === 'running',
    {order, a: first(r, 'A roll'), b: first(r, 'B stop'), stderr: result.stderr.slice(-300)});

  operation('review 6: a router that ignores stdin', 'a configured router that exits without reading an 8 MB task (EPIPE) fails that roll only; the shared worker answers the next call');
  const epipe = path.join(ROOT, 'epipe plugin');
  fs.cpSync(path.join(REPO, 'plugin'), epipe, {recursive: true});
  fs.writeFileSync(path.join(epipe, 'router.json'), JSON.stringify({command: [process.execPath, '-e', 'process.exit(0)'], stateRoot: D('epipe state')}));
  ({record, result} = await drive(epipe, 'review6-epipe', [
    {label: 'roll', call: 'roll', args: {task: {repeat: 'x', count: 8 * 1024 * 1024}}},
    {label: 'roll again', call: 'roll', args: {task: {repeat: 'y', count: 8 * 1024 * 1024}}},
    {label: 'status', call: 'status', args: {operation: 'f'.repeat(40)}},
  ]));
  r = replies(record);
  check('both rolls fail with the router reason, and the worker still answers', ['roll', 'roll again'].every(k => /Router returned no usable route/.test(first(r, k).message || '')) &&
    /Unknown operation/.test(first(r, 'status').message || '') && !/Node bridge unavailable/.test(JSON.stringify(r)), JSON.stringify(r).slice(0, 600) + (record.workerStderr || ''));

  // -------------------------------------------------------------------------------------------------------------
  // The external CLI on request: ~/.agent-compass/cindy-plugin/config.json {"engine":"cli"} for the scenarios below only.
  const zcBin = D('installed bin');
  const made = await run([python.exe, '-X', 'utf8', path.join(REPO, 'test', 'make_launcher.py'), zcBin, python.exe, '-X', 'utf8', path.join(CHECKOUT, 'agentcompass')]);
  const launcherFile = made.stdout.trim();
  const zcEnv = {PATH: [zcBin, baseEnv.PATH].join(path.delimiter)};
  const optIn = path.join(stateHome, 'config.json');
  fs.writeFileSync(optIn, JSON.stringify({engine: 'cli'}));
  try {
    operation('CLI opt-in', 'config.json {"engine":"cli"}: the worker finds the installed `agentcompass` on PATH, applies ~/.agent-compass/cindy-plugin/account-map.json, then roll -> status -> cleanup');
    check(`an installed-style \`agentcompass\` launcher is on PATH (${path.basename(launcherFile)})`, made.code === 0 && fs.existsSync(launcherFile) &&
      path.basename(launcherFile) === cliName, made.stdout + made.stderr);
    const accountMap = [{routerProvider: 'codex', routerAccount: 'codex', providerId: 'codex-connection', agentKind: 'codex'},
                        {routerProvider: 'pi', routerAccount: 'codex', providerId: 'pi-openai-connection', agentKind: 'pi'},
                        {routerProvider: 'claude', routerAccount: 'claude', providerId: 'claude-connection', agentKind: 'cc'}];
    // The connection Cindy must be asked for is the one the map names for the routed account; the router, not this test, decides the account.
    const mappedConnection = bundle => accountMap.find(m => m.routerProvider === bundle?.provider && m.routerAccount === bundle?.account)?.providerId;
    fs.writeFileSync(path.join(stateHome, 'account-map.json'), JSON.stringify(accountMap));
    ({record, result} = await drive(market, 'cli-opt-in', [
      {label: 'roll', call: 'roll', args: {task: task('cli-opt-in')}},
      {label: 'finished', fixture: {runStatus: 'completed', outputMessageId: 'out-final', pages: 2, finalText: '[Worker final report] cli opt-in result'}},
      {label: 'status after completion', call: 'status', args: {operation: '@operation:roll'}},
      {label: 'cleanup', call: 'cleanup', args: {operation: '@operation:roll'}},
    ], {env: zcEnv}));
    r = replies(record);
    const zr = first(r, 'roll'), zop = zr.result?.operation || 'none';
    const zReceipt = readJson(path.join(stateHome, zop, 'receipt.json'));
    check('roll starts a run through the discovered command; the real router answered natively for the Cindy session',
      zr.ok && zr.result?.status === 'running' && zReceipt.engine === 'cli' && zReceipt.router?.status === 'native' && zReceipt.router?.parent_id === SESSION,
      JSON.stringify(zr).slice(0, 500) + result.stderr.slice(-300) + (record.workerStderr || ''));
    check('the account map from the home directory was applied to the exact catalog route of the routed account',
      JSON.stringify(zReceipt.mappings) === JSON.stringify(accountMap) && Boolean(mappedConnection(zReceipt.bundle)) &&
      (record.calls || []).find(c => c.name === 'create')?.route?.providerId === mappedConnection(zReceipt.bundle),
      {mappings: zReceipt.mappings, bundle: zReceipt.bundle, create: (record.calls || []).find(c => c.name === 'create')});
    const zDone = first(r, 'status after completion').result || {};
    check('status collects the exact final message and cleanup archives', zDone.status === 'completed' && zDone.output_available &&
      (zDone.final_result_summary || '').includes('cli opt-in result') && first(r, 'cleanup').result?.status === 'cleaned', zDone);

    operation('every Cindy harness through the real router', 'Claude (router.json build, deep and review profiles) and Pi (CLI opt-in) reach exact catalog routes with Cindy bypassPermissions; the other harnesses are signed out so the router has only that one to choose; codex is the first operation');
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
    // Sign accounts out by moving their credential files away for the duration of one scenario; the file comes back afterwards.
    const parked = D('parked-credentials');
    const signedOut = async (files, fn) => {
      const moved = files.map((file, i) => [file, path.join(parked, String(i))]);
      for (const [from, to] of moved) fs.renameSync(from, to);
      try {return await fn();} finally {for (const [from, to] of moved) fs.renameSync(to, from);}
    };
    const codexAuth = path.join(baseEnv.CODEX_HOME, 'auth.json');
    const piAuth = path.join(piAgentDir, 'auth.json');
    const CREATE_KIND = {claude: 'cc', codex: 'codex', pi: 'pi'};
    // A routed bundle reaches Cindy as exactly its own catalog row: its harness's kind, its launch model and effort, no fast mode, bypassPermissions.
    const mirrorsBundle = h => {
      const b = h.receipt.bundle || {};
      return h.create.route?.agentKind === CREATE_KIND[b.harness] && h.create.route?.model === (b.launch_model || b.model) && h.create.route?.effort === b.effort &&
        h.create.route?.fastMode === false && h.create.permissionMode === 'bypassPermissions' && lifecycle(h);
    };
    // Claude is the only account left: both profiles must land on the claude harness, whatever model and effort the net score picks.
    for (const [name, profile] of [['claude-deep', 'deep'], ['claude-review', 'review']]) {
      const h = await signedOut([codexAuth, piAuth], () => harness(name, profile, plugin));
      const b = h.receipt.bundle || {};
      check(`${name}: with only Claude signed in the router chose the claude harness (${b.model}/${b.effort}) and the plugin made bypassPermissions explicit`,
        b.provider === 'claude' && b.harness === 'claude' && Boolean(b.model) && Boolean(b.effort) && !b.fast && b.modeId === 'bypassPermissions',
        {bundle: b, router: h.receipt.router?.status, stderr: h.result.stderr.slice(-300)});
      check(`${name}: Cindy creates the cc row of that bundle with bypassPermissions and the run completes`, mirrorsBundle(h),
        {create: h.create, bundle: b, replies: JSON.stringify(h.r).slice(0, 600)});
    }
    // Claude signed out, a read-only exploration: Codex and Pi, both on the one ChatGPT subscription, are all there is, and which of the two the net
    // score prefers is the router's decision. Whatever it picks must reach Cindy as its own catalog row on the connection the map names for that account.
    const pi = await signedOut([path.join(baseEnv.CLAUDE_CONFIG_DIR, '.credentials.json')], () => harness('explore', 'explore', market, zcEnv));
    const pb = pi.receipt.bundle || {};
    check(`explore: with Claude signed out the router routed the ChatGPT subscription: the ${pb.harness} harness (${pb.model}/${pb.effort}) with its launcher mode`,
      ['codex', 'pi'].includes(pb.harness) && pb.provider === pb.harness && pb.modeId === 'full-access' && !pb.fast,
      {bundle: pb, router: pi.receipt.router?.status, stderr: pi.result.stderr.slice(-300), reply: JSON.stringify(pi.r).slice(0, 500)});
    check('explore: Cindy creates the exact row of that bundle on its mapped connection with bypassPermissions and the run completes',
      mirrorsBundle(pi) && pi.create.route?.providerId === (mappedConnection(pb) ?? pb.account),
      {create: pi.create, bundle: pb, replies: JSON.stringify(pi.r).slice(0, 600)});

    operation('review 7: a fixed account map unblocks the retry', 'the routed account has no Cindy connection of its name: the roll fails before create; after account-map.json is written the same assignment is routed again and runs');
    fs.rmSync(path.join(stateHome, 'account-map.json'));
    const r7 = task('review7');
    ({record, result} = await drive(market, 'review7-retry', [
      {label: 'the Cindy connection has its own name', fixture: {connection: 'cindy-own-connection'}},
      {label: 'roll', call: 'roll', args: {task: r7}},
      {label: 'write the account map', fixture: {accountMap: accountMap.map(m => ({...m, providerId: `${m.routerProvider}-mapped`}))}},
      {label: 'roll again', call: 'roll', args: {task: r7}},
    ], {env: zcEnv}));
    r = replies(record);
    const r7op = first(r, 'roll again').result?.operation || 'none';
    const r7receipt = readJson(path.join(stateHome, r7op, 'receipt.json'));
    check('the first roll is refused before any create', first(r, 'roll').ok === false && /unavailable or ambiguous|No explicit/.test(first(r, 'roll').message || ''),
      JSON.stringify(first(r, 'roll')).slice(0, 400) + result.stderr.slice(-300));
    check('the retry re-reads the map, routes again and runs on the mapped connection', first(r, 'roll again').result?.status === 'running' && r7receipt.attempts === 2 &&
      r7receipt.mappings?.length === accountMap.length && (record.calls || []).find(c => c.name === 'create')?.route?.providerId === `${r7receipt.bundle?.provider}-mapped` &&
      count(record, 'create') === 1, {reply: first(r, 'roll again'), attempts: r7receipt.attempts, bundle: r7receipt.bundle});

    operation('CLI opt-in without the CLI installed', 'config.json asks for the CLI but none is installed: the built-in engine routes and says so; no error');
    fs.rmSync(path.join(stateHome, 'account-map.json'), {force: true});
    ({record, result} = await drive(market, 'cli-fallback', [
      {label: 'catalog', fixture: {catalog: 'real'}},
      {label: 'roll', call: 'roll', args: {task: task('cli-fallback')}},
    ], {env: builtinEnv}));
    const fb = first(replies(record), 'roll');
    const fbReceipt = readJson(path.join(stateHome, fb.result?.operation || 'none', 'receipt.json'));
    check('the built-in engine routed, with the fallback named', fb.result?.status === 'running' && fbReceipt.engine === 'builtin' &&
      /not installed: the built-in engine routed/.test(fbReceipt.router?.engine_note || '') && isRow((record.calls || []).find(c => c.name === 'create')?.route, REAL),
      JSON.stringify(fb).slice(0, 400) + result.stderr.slice(-300));
  } finally {
    fs.rmSync(optIn, {force: true});
    fs.rmSync(path.join(stateHome, 'account-map.json'), {force: true});
  }
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

// The report and artifacts are published: name the machine's own folders by role, never by their real paths.
const PLACES = [[ROOT, '<sandbox>'], [CHECKOUT, '<agentcompass-checkout>'], [REPO, '<repo>'], [os.tmpdir(), '<tmp>'], [os.homedir(), '<home>']]
  .filter(([p]) => p && p.length > 3).sort((a, b) => b[0].length - a[0].length);
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const redact = text => PLACES.reduce((out, [place, name]) => {
  const forms = new Set([place, place.split(path.sep).join('/'), JSON.stringify(place).slice(1, -1)]);
  return [...forms].reduce((acc, form) => acc.replace(new RegExp(escapeRe(form), 'gi'), name), out);
}, text);
for (const name of fs.readdirSync(art)) {
  const file = path.join(art, name);
  fs.writeFileSync(file, redact(fs.readFileSync(file, 'utf8')));
}
const published = JSON.parse(redact(JSON.stringify(report)));

const reportFile = process.env.CINDY_SANDBOX_REPORT || path.join(ROOT, 'report', 'sandbox-e2e-report.json');
fs.mkdirSync(path.dirname(reportFile), {recursive: true});
fs.writeFileSync(reportFile, JSON.stringify(published, null, 1) + '\n');
if (process.env.CINDY_REPORT_MERGE_INTO) {
  const combined = readJson(process.env.CINDY_REPORT_MERGE_INTO);
  combined.kind = report.kind;
  combined.runs = {...(combined.runs || {}), [LABEL]: published};
  combined.summary = Object.fromEntries(Object.entries(combined.runs).map(([k, v]) => [k, v.summary]));
  fs.writeFileSync(process.env.CINDY_REPORT_MERGE_INTO, JSON.stringify(combined, null, 1) + '\n');
}
console.log(`\n${report.summary.passed}/${report.summary.checks} checks passed in ${report.summary.operations} operations; report: ${reportFile}`);
process.exit(exitCode);
