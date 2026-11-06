// A stand-in for the CINDY HOST around the REAL plugin that scripts/build_plugin.py produced.
//
//   real:     the built main.js (run as Cindy runs a logic page), the real worker.cjs (a real `node` child speaking
//             JSON-RPC over stdio, as Cindy's node bridge does), and through it the built-in engine or the real public
//             `agentcompass roll`
//   fixture:  the host itself - trusted session_context injection and the experimental `cindy.tasks` API.
//             Production behavior is validated separately (see docs/CINDY_REAL_ACCEPTANCE_AND_CANCEL_FIX.md).
//
// usage: node zero_cindy_host.mjs <plugin dir> <scenario.json> <out.json>
// scenario: {workdir, session, steps:[...]}. A step is
//   {label, call: "roll"|"status"|"stop"|"cleanup", args, inject?: false, context?: {...}, parallel?: n, as?: <other session id>}
//   or {label, concurrent: [call steps]}   started together; `order` records which reply came first
//   or {label, fixture: {...changes to the fake Cindy...}}   e.g. {capabilities, catalog, workingDir, staleRevision, runStatus, outputMessageId, pages, archiveFails}
//   capabilities: 'full' | 'missing' | 'denied' | 'no-cancel' | 'no-archive' | 'no-exact'
//   catalog: 'matching' (the routed row, on the connection the account map or `connection` names) | 'real' (the catalog
//            Cindy 0.1.121 reported, test/fixtures) | 'real+claude' (that plus a Claude connection) | 'other-model' | 'empty'
//   sendFault: 'lost-answer' (the run is stored, its answer never arrives)   inputOverride: text the run's input message shows
//   saveFault: 'after-send' (the receipt save after an accepted send fails once)
//   accountMap: [...] writes ~/.agent-compass/cindy-plugin/account-map.json   receiptPatch: {operation, set, unset}
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';

const [pluginDir, scenarioFile, outFile] = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
const trusted = { session_id: scenario.session, workdir: scenario.workdir, workdir_is_local: true, workdir_is_read_only: false };

// ---- the node bridge: the real worker.cjs
const worker = spawn(process.execPath, [path.join(pluginDir, 'worker.cjs')], { env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const stderr = [];
worker.stderr.on('data', d => stderr.push(d));
const pending = new Map();
let rpcId = 0;
readline.createInterface({ input: worker.stdout }).on('line', line => {
  let reply; try { reply = JSON.parse(line); } catch { return; }
  const waiter = pending.get(reply.id); pending.delete(reply.id);
  if (waiter) waiter(reply);
});
const rpc = (method, params) => new Promise(resolve => {
  const id = ++rpcId; pending.set(id, resolve);
  worker.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

// ---- the fake Cindy
const host = {
  capabilities: 'full', catalog: 'matching', workingDir: null, staleRevision: false, archiveFails: false, createFault: null, finalRepeat: null,
  connection: null, sendFault: null, saveFault: null, inputOverride: null,
  classifierProfile: null, classifierProfiles: [], classifierTasks: new Map(), classifierRuns: new Map(), classifierCalls: [],
  tasks: new Map(), runs: new Map(), createKeys: new Map(), sendKeys: new Map(), pages: 1,
  calls: [], prepared: null, nodeCalls: [], sent: [],
};
const log = (name, detail) => host.calls.push({ name, ...detail });
const logClf = (name, detail) => host.classifierCalls.push({ name, ...detail });
const publicRun = run => { if (!run) return run; const { inputText, outputText, ...rest } = run; return rest; };
const ALL_OPS = ['models', 'create', 'send', 'get', 'getRun', 'listRuns', 'readMessages', 'cancel', 'archive'];
const DEFAULT_CLASSIFIER_PROFILE = {
  work_kind: 'general_implementation',
  interaction_style: 'engineering',
  reasoning_depth: 2,
  code_complexity: 2,
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
  reason: 'fixture classification from fake Cindy host model',
};

// The catalog row a correctly configured Cindy shows for the routed account: its connection is the mapped one, else
// the connection named like the router account.
function routeOf(bundle, mappings = []) {
  const mapped = mappings.find(m => m.routerProvider === bundle.provider && m.routerAccount === bundle.account);
  return { agentKind: { claude: 'cc', codex: 'codex', pi: 'pi' }[bundle.harness], providerId: mapped ? mapped.providerId : (host.connection || bundle.account),
    model: bundle.launch_model || bundle.model, effort: bundle.effort, fastMode: Boolean(bundle.fast) };
}
const REAL = JSON.parse(fs.readFileSync(new URL('./fixtures/cindy-0.1.121-catalog.json', import.meta.url), 'utf8'));
const CLAUDE_ROWS = ['claude-opus-5-5', 'claude-sonnet-5-5'].map(model => ({ route: { agentKind: 'cc', providerId: 'anthropic', model, effort: 'high', fastMode: false },
  efforts: ['low', 'medium', 'high', 'max'], supportsFastMode: false }));
const coded = (code, message) => Object.assign(Error(code + ': ' + message), { code });
const stateHome = path.join(process.env.HOME || process.env.USERPROFILE, '.agent-compass', 'cindy-plugin');
const cindy = {
  node: {
    request: async ({ method, params }) => {
      host.nodeCalls.push(method);
      if (method === 'save' && host.saveFault === 'after-send' && params.record?.delivery === 'accepted') {
        host.saveFault = null; log('saveFault', { operation: params.operation });
        return { ok: false, message: 'EIO: the receipt could not be written' };
      }
      const reply = await rpc(method, params);
      if (reply.error) return { ok: false, message: reply.error.message };
      if (method === 'prepare' && reply.result?.bundle) host.prepared = reply.result;
      return { ok: true, result: reply.result };
    },
  },
  tasks: {
    capabilities: async () => {
      log('capabilities', {});
      if (host.capabilities === 'denied') throw Error('PERMISSION_DENIED');
      const missing = { 'no-cancel': 'cancel', 'no-archive': 'archive' }[host.capabilities];
      const operations = ALL_OPS.filter(o => o !== missing);
      return { operations, exactRoute: host.capabilities !== 'no-exact', createPermissionMode: true };
    },
    models: async () => {
      log('models', {});
      if (host.catalog === 'real') return structuredClone({ models: REAL.models });
      if (host.catalog === 'real+claude') return structuredClone({ models: [...REAL.models, ...CLAUDE_ROWS] });
      const route = host.prepared ? routeOf(host.prepared.bundle, host.prepared.mappings) : null;
      if (!route || host.catalog === 'empty') return { models: [] };
      const shown = host.catalog === 'other-model' ? { ...route, model: route.model + '-other' } : route;
      return { models: [{ route: shown, efforts: [route.effort], supportsFastMode: true }] };
    },
    create: async request => {
      if (String(request.requestKey || '').endsWith(':classify:create')) {
        logClf('create', { requestKey: request.requestKey, route: request.route, permissionMode: request.permissionMode });
        const taskId = 'clf-task-' + (host.classifierTasks.size + 1);
        const task = { taskId, revision: 1, resolvedConfig: { ...request.route }, permissionMode: request.permissionMode, planModeEnabled: false, workingDir: trusted.workdir };
        host.classifierTasks.set(taskId, task);
        return structuredClone(task);
      }
      log('create', { requestKey: request.requestKey, route: request.route, permissionMode: request.permissionMode });
      if (host.createKeys.has(request.requestKey)) { host.duplicateCreate = (host.duplicateCreate || 0) + 1; return structuredClone(host.tasks.get(host.createKeys.get(request.requestKey))); }
      const taskId = 'task-' + (host.tasks.size + 1);
      const task = { taskId, revision: 1, resolvedConfig: { ...request.route }, permissionMode: request.permissionMode, planModeEnabled: false, workingDir: host.workingDir || trusted.workdir };
      host.tasks.set(taskId, task); host.createKeys.set(request.requestKey, taskId);
      if (host.staleRevision) task.revision += 1;     // someone else changed the draft after it was created
      if (host.createFault === 'after') throw Error('CONNECTION_LOST after the draft was created');     // the host did the work, the answer never arrived
      return structuredClone({ ...task, revision: host.staleRevision ? task.revision - 1 : task.revision });
    },
    send: async request => {
      if (host.classifierTasks.has(request.taskId)) {
        const clfTask = host.classifierTasks.get(request.taskId);
        logClf('send', { taskId: request.taskId, expectedRevision: request.expectedRevision, requestKey: request.requestKey, chars: request.text.length });
        const runId = 'clf-run-' + (host.classifierRuns.size + 1);
        const nextOverride = host.classifierProfiles.length ? host.classifierProfiles.shift() : (host.classifierProfile || {});
        const profile = { ...DEFAULT_CLASSIFIER_PROFILE, ...nextOverride };
        const clfRun = {
          runId, taskId: clfTask.taskId, inputMessageId: 'clf-in-' + runId, outputMessageId: 'clf-out-' + runId,
          status: 'completed', acceptedConfig: { ...clfTask.resolvedConfig }, inputText: request.text, outputText: JSON.stringify(profile),
        };
        host.classifierRuns.set(runId, clfRun);
        clfTask.revision += 1;
        return structuredClone(publicRun(clfRun));
      }
      const task = host.tasks.get(request.taskId);
      log('send', { taskId: request.taskId, expectedRevision: request.expectedRevision, requestKey: request.requestKey, chars: request.text.length });
      if (!task) throw Error('TASK_NOT_FOUND');
      if (host.sendKeys.has(request.requestKey)) { host.duplicateSend = (host.duplicateSend || 0) + 1; return structuredClone(host.runs.get(host.sendKeys.get(request.requestKey))); }
      // Cindy refuses before it stores anything, with a coded error (the SDK throws `error.code`).
      if (request.expectedRevision !== task.revision) throw coded('REVISION_CONFLICT', 'Task configuration changed: expected ' + request.expectedRevision + ', task is at ' + task.revision);
      const id = 'run-' + (host.runs.size + 1);
      const run = { runId: id, taskId: task.taskId, inputMessageId: 'plugin-task:' + id, status: 'running', acceptedConfig: { ...task.resolvedConfig } };
      run.inputText = host.inputOverride ?? request.text;
      host.runs.set(run.runId, run); host.sendKeys.set(request.requestKey, run.runId); task.revision += 1;
      const file = path.join(path.dirname(outFile), `cindy-sent-${run.runId}.txt`);
      fs.writeFileSync(file, request.text, 'utf8');
      host.sent.push({ runId: run.runId, file, sha256: crypto.createHash('sha256').update(request.text, 'utf8').digest('hex'), chars: request.text.length });
      if (host.sendFault === 'lost-answer') { host.sendFault = null; throw Error('CONNECTION_LOST after the input was accepted'); }
      return structuredClone(publicRun(run));
    },
    getRun: async request => {
      if (host.classifierRuns.has(request.runId)) {
        logClf('getRun', { runId: request.runId });
        return structuredClone(publicRun(host.classifierRuns.get(request.runId)));
      }
      log('getRun', { runId: request.runId });
      return structuredClone(publicRun(host.runs.get(request.runId)));
    },
    listRuns: async request => {
      if (host.classifierTasks.has(request.taskId)) {
        logClf('listRuns', { taskId: request.taskId });
        return { items: [...host.classifierRuns.values()].filter(r => r.taskId === request.taskId).map(r => structuredClone(publicRun(r))), nextCursor: null };
      }
      log('listRuns', { taskId: request.taskId });
      return { items: [...host.runs.values()].filter(r => r.taskId === request.taskId).map(r => structuredClone(publicRun(r))), nextCursor: null };
    },
    // As Cindy 0.1.121 stores them: page 0 opens with the run's input message (`id` = the run's inputMessageId, role
    // user, the sent text), the last page holds the output message.
    readMessages: async request => {
      if (host.classifierTasks.has(request.taskId)) {
        logClf('readMessages', { taskId: request.taskId, after: request.after || null });
        const clfRun = [...host.classifierRuns.values()].find(r => r.taskId === request.taskId);
        return {
          items: clfRun
            ? [{ id: clfRun.inputMessageId, role: 'user', content: clfRun.inputText }, { id: clfRun.outputMessageId, role: 'assistant', content: clfRun.outputText }]
            : [],
          nextCursor: null,
        };
      }
      log('readMessages', { after: request.after || null });
      const index = request.after ? Number(request.after) : 0;
      const last = index >= host.pages - 1;
      const run = [...host.runs.values()].find(r => r.taskId === request.taskId);
      const items = [{ id: last ? (run?.outputMessageId || 'out-final') : 'noise-' + index, role: 'assistant',
        content: last ? (host.finalRepeat ? host.finalRepeat.unit.repeat(host.finalRepeat.count) : (host.finalText || '[Worker final report] fixture result')) : 'intermediate page ' + index }];
      if (index === 0 && run) items.unshift({ id: run.inputMessageId, role: 'user', content: run.inputText });
      return { items, nextCursor: last ? null : String(index + 1) };
    },
    cancel: async request => {
      if (host.classifierRuns.has(request.runId)) {
        logClf('cancel', { runId: request.runId });
        const clfRun = host.classifierRuns.get(request.runId);
        clfRun.status = 'cancelled';
        return structuredClone(publicRun(clfRun));
      }
      log('cancel', { runId: request.runId });
      const run = host.runs.get(request.runId);
      run.status = 'stopping';
      return structuredClone(publicRun(run));
    },
    archive: async request => {
      if (host.classifierTasks.has(request.taskId)) {
        logClf('archive', { taskId: request.taskId });
        const clfTask = host.classifierTasks.get(request.taskId);
        clfTask.archived = true;
        return structuredClone(clfTask);
      }
      log('archive', { taskId: request.taskId });
      if (host.archiveFails) throw coded('TASK_BUSY', 'ARCHIVE_FAILED');
      host.tasks.get(request.taskId).archived = true; return structuredClone(host.tasks.get(request.taskId));
    },
  },
  onHostMessage: callback => { host.handler = callback; },
  send: message => { host.waiters.get(message.callId)?.(message); },
};
host.waiters = new Map();
let serial = 0;
vm.runInNewContext(fs.readFileSync(path.join(pluginDir, 'main.js'), 'utf8'), { cindy, Set, Boolean, Error, JSON });
if (host.capabilities === 'missing') delete cindy.tasks;

const operations = { last: null };
function callTool(step) {
  return new Promise(resolve => {
    const callId = 'call-' + (++serial);
    host.waiters.set(callId, resolve);
    const args = { ...(step.args || {}) };
    // {repeat, count}: a large task built here, so the scenario file stays small.
    if (args.task && typeof args.task === 'object') args.task = args.task.repeat.repeat(args.task.count);
    // "@operation" is the operation the previous roll returned; "@operation:<label>" the one a labelled step returned.
    if (typeof args.operation === 'string' && args.operation.startsWith('@operation'))
      args.operation = args.operation === '@operation' ? operations.last : operations[args.operation.slice('@operation:'.length)];
    // Cindy strips whatever session_context the caller supplied and injects the real one; `inject:false` is a host that does not.
    if (step.inject !== false) args.session_context = { ...(step.context || trusted), ...(step.as ? { session_id: step.as } : {}) };
    host.handler({ type: 'tool-call', tool: step.call, callId, args });
  });
}

const results = [];
try {
  for (const step of scenario.steps) {
    if (step.fixture) {
      const f = step.fixture;
      for (const key of ['capabilities', 'catalog', 'workingDir', 'staleRevision', 'archiveFails', 'pages', 'finalText', 'finalRepeat', 'createFault',
        'connection', 'sendFault', 'saveFault', 'inputOverride', 'classifierProfile', 'classifierProfiles']) if (key in f) host[key] = structuredClone(f[key]);
      if (f.accountMap) { fs.mkdirSync(stateHome, { recursive: true }); fs.writeFileSync(path.join(stateHome, 'account-map.json'), JSON.stringify(f.accountMap)); }
      if (f.receiptPatch) {
        const op = f.receiptPatch.operation.startsWith('@operation:') ? operations[f.receiptPatch.operation.slice('@operation:'.length)] : f.receiptPatch.operation;
        const file = path.join(stateHome, op, 'receipt.json');
        const receipt = { ...JSON.parse(fs.readFileSync(file, 'utf8')), ...(f.receiptPatch.set || {}) };
        for (const key of f.receiptPatch.unset || []) delete receipt[key];
        fs.writeFileSync(file, JSON.stringify(receipt, null, 2));
      }
      if (f.capabilities === 'missing') delete cindy.tasks;
      for (const run of host.runs.values()) {
        if ('runStatus' in f) run.status = f.runStatus;
        if ('outputMessageId' in f) run.outputMessageId = f.outputMessageId;
        if ('error' in f) run.error = f.error;
      }
      results.push({ label: step.label, fixture: f });
      continue;
    }
    if (step.concurrent) {
      const order = [];
      const replies = await Promise.all(step.concurrent.map(s => callTool(s).then(reply => { order.push(s.label); return reply; })));
      step.concurrent.forEach((s, i) => {
        const operation = replies[i].ok && replies[i].result?.operation;
        if (operation) operations[s.label] = operation;
        results.push({ label: s.label, replies: [replies[i]] });
      });
      results.push({ label: step.label, order });
      continue;
    }
    const n = step.parallel || 1;
    const replies = await Promise.all(Array.from({ length: n }, () => callTool(step)));
    const operation = replies.find(r => r.ok && r.result?.operation)?.result.operation;
    if (operation) { operations.last = operation; operations[step.label] = operation; }
    results.push({ label: step.label, replies });
  }
} finally {
  worker.stdin.end();
  if (worker.pid && worker.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(worker.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else worker.kill('SIGKILL');
  }
}
fs.writeFileSync(outFile, JSON.stringify({
  results, calls: host.calls, classifierCalls: host.classifierCalls, classifierTasks: [...host.classifierTasks.values()],
  nodeCalls: host.nodeCalls, sent: host.sent, prepared: host.prepared,
  duplicateCreate: host.duplicateCreate || 0, duplicateSend: host.duplicateSend || 0,
  tasks: [...host.tasks.values()], runs: [...host.runs.values()], workerStderr: Buffer.concat(stderr).toString('utf8').slice(-2000),
}, null, 1));
process.exit(0);
