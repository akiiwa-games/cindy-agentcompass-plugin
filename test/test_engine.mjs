// The built-in routing engine (plugin/engine/route.mjs) over the catalog a real Cindy 0.1.121 reported.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {codexHomes, codexQuota, routeTask, selfGate, splitGate} from '../plugin/engine/route.mjs';

const REAL = JSON.parse(fs.readFileSync(new URL('./fixtures/cindy-0.1.121-catalog.json', import.meta.url), 'utf8'));
// The same catalog with a Claude connection signed in, in the row shape Cindy uses for every harness.
const WITH_CLAUDE = {models: [...REAL.models,
  ...['claude-opus-5-5', 'claude-sonnet-5-5'].map(model => ({route: {agentKind: 'cc', providerId: 'anthropic', model, effort: 'high', fastMode: false},
    efforts: ['low', 'medium', 'high', 'max'], supportsFastMode: false}))]};
const OK = {source: 'test', status: 'ok', used_percent: 17};
const route = (task, catalog = REAL, quota = OK) => routeTask(task, catalog, {quota});
// Every native answer must be one row Cindy listed, at an effort and fast mode that row offers.
function inCatalog(result, catalog) {
  const b = result.route.bundle;
  const kind = {claude: 'cc', codex: 'codex', pi: 'pi'}[b.harness];
  return catalog.models.some(row => row.route.agentKind === kind && row.route.providerId === b.providerId && row.route.model === b.model &&
    (row.efforts || [row.route.effort]).includes(b.effort) && (!b.fast || row.supportsFastMode));
}

test('split: several independent deliverables come back as split with the task count; nothing is routed', () => {
  for (const [task, count] of [['Two independent tasks:\n1. Add a dark theme to the settings page.\n2. Fix the CSV export encoding bug in report.py.', '2'],
    ['Two independent tasks:\nTask 1: Fix foo.py, then run its tests.\nTask 2: Translate README.md into Japanese.', '2'],
    ['Task 1: Next.js: fix the hydration bug.\nTask 2: Django: add CSV export.', '2'],
    ['Task 1: Fix the bug in ordering logic.\nTask 2: Translate README.md into Japanese.', '2'],
    ['Task 1: write the release notes.\nTask 2: upgrade the lodash dependency.\nTask 3: add retry to the HTTP client.', '3'],
    ['以下是互不相关的任务：\n1. 给设置页加深色主题\n2. 修复 report.py 的 CSV 编码\n3. 升级 lodash\n4. 给 HTTP 客户端加重试', '>3']]) {
    const result = route(task);
    assert.equal(result.status, 'split', task);
    assert.equal(result.task_count, count);
    assert.equal(result.engine, 'builtin');
    assert.equal(result.route, undefined);
  }
  assert.equal(splitGate('Steps:\n1. Reproduce the crash.\n2. Then fix it.\n3. Then add a regression test.'), null, 'one job in steps is one task');
  assert.equal(route('Steps:\n1. Reproduce the crash.\n2. Then fix it.').status, 'native');
  assert.equal(splitGate('Task 1: First implement the helper.\nTask 2: Then test the helper created above.'), null);
  assert.equal(route('Task 1: First implement the helper.\nTask 2: Then test the helper created above.').status, 'native');
  assert.equal(splitGate('Task 1: Collect latency metrics.\nTask 2: Plot a chart based on the previous results.'), null);
  assert.equal(route('Task 1: Collect latency metrics.\nTask 2: Plot a chart based on the previous results.').status, 'native');
});

test('self: an explicit "answer here" or a short pure question is the current session\'s job', () => {
  for (const task of ['What is the difference between a mutex and a semaphore?', '直接回答：Python 的 GIL 是什么？',
    'Do not delegate this: summarise the README in two lines.',
    'No delegation please. Rename foo in util.py.']) {
    const result = route(task);
    assert.equal(result.status, 'self', task);
    assert.match(result.next_action, /current session/);
  }
  assert.equal(selfGate('Why does util.py fail? Fix it and add a test.'), null, 'a question with work in it is delegated');
  for (const workQuestion of [
    'Can you review the diff for regressions?',
    'Can you translate the supplied paragraph into Japanese?',
    'Fix the "no worker available" error in scheduler.py.',
    'Implement a worker pool with no worker thread leaks.',
  ]) {
    assert.equal(selfGate(workQuestion), null, workQuestion);
    assert.equal(route(workQuestion).status, 'native', workQuestion);
  }
});

test('native routes are exact rows of the real catalog: codex for edits, Pi for read-and-report work', () => {
  const edit = route('Rename the helper foo to bar in util.py and update its two callers.');
  assert.equal(edit.status, 'native');
  assert.equal(edit.route.bundle.harness, 'codex');
  assert.equal(edit.route.bundle.modeId, 'full-access');
  assert.ok(inCatalog(edit, REAL), JSON.stringify(edit.route.bundle));
  const explore = route('Investigate why the login request fails: trace it through logs/ and the auth module and report the findings only.');
  assert.equal(explore.decision.work_kind, 'exploration_analysis');
  assert.equal(explore.route.bundle.harness, 'pi');
  assert.match(explore.route.bundle.model, /^chatgpt\//);
  assert.ok(inCatalog(explore, REAL), JSON.stringify(explore.route.bundle));
  const review = route('Review the diff in src/auth for security regressions and subtle bugs (read-only review).', WITH_CLAUDE);
  assert.equal(review.route.bundle.harness, 'claude');
  assert.equal(review.route.bundle.modeId, 'bypassPermissions');
  assert.ok(inCatalog(review, WITH_CLAUDE));
  assert.ok(review.decision.alternatives.length > 0 && review.decision.components, 'the decision is explained');
});

test('fast mode needs the signal word, a fast-capable codex row and known quota under 60%', () => {
  const task = 'Use fast mode: rename the helper foo to bar in util.py and update its two callers.';
  const fast = route(task);
  assert.equal(fast.route.bundle.fast, true);
  assert.equal(fast.route.bundle.harness, 'codex');
  assert.ok(inCatalog(fast, REAL));
  assert.equal(route('Rename the helper foo to bar in util.py and update its two callers.').route.bundle.fast, false, 'no signal word');
  assert.equal(route(task, REAL, {source: 'test', status: 'ok', used_percent: 70}).route.bundle.fast, false, 'quota at 70%');
  assert.equal(route(task, REAL, {source: 'test', status: 'unknown'}).route.bundle.fast, false, 'unknown quota');
  assert.equal(route('加急：把 util.py 里的 foo 改名为 bar 并更新两个调用点。').decision.wants_fast, true);
  for (const optedOut of [
    'Rename foo to bar in util.py. Do not use fast mode.',
    'Rename foo to bar in util.py without fast mode.',
    'Rename foo to bar in util.py. This is not urgent.',
    'This is urgent: rename foo to bar in util.py, but do not use fast mode.',
    '把 util.py 里的 foo 改名为 bar，不要使用快速模式。',
    '把 util.py 里的 foo 改名为 bar，这件事不紧急、不用加急。',
  ]) {
    const res = route(optedOut);
    assert.equal(res.decision.wants_fast, false, optedOut);
    assert.equal(res.route.bundle.fast, false, optedOut);
  }
  for (const enabledDespiteNegatedUrgency of [
    'Rename the non-urgent helper foo to bar in util.py in fast mode.',
    'Rename foo in util.py. This is not urgent but use fast mode.',
    '把 util.py 里的 foo 改名为 bar，这件事不紧急，但请使用快速模式。',
  ]) {
    const res = route(enabledDespiteNegatedUrgency);
    assert.equal(res.decision.wants_fast, true, enabledDespiteNegatedUrgency);
    assert.equal(res.route.bundle.fast, true, enabledDespiteNegatedUrgency);
  }
});

test('quota: an exhausted Codex window moves the route to another signed-in connection', () => {
  const task = 'Rename the helper foo to bar in util.py and update its two callers.';
  assert.equal(route(task, WITH_CLAUDE).route.bundle.harness, 'codex');
  const moved = route(task, WITH_CLAUDE, {source: 'test', status: 'exhausted', used_percent: 97});
  assert.equal(moved.route.bundle.harness, 'claude');
  assert.equal(moved.decision.quota.status, 'exhausted');
  assert.ok(moved.decision.quota_penalized_routes >= 10, 'every codex and pi row on that login is marked down');
  assert.equal(moved.decision.warning, undefined);
  const only = route(task, REAL, {source: 'test', status: 'exhausted', used_percent: 97});
  assert.match(only.decision.warning, /short of quota/, 'with no other connection the route says so');
});

test('quota telemetry is the newest rate-limit snapshot the Codex CLI wrote; reset windows are ignored', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  try {
    assert.equal(codexQuota({CODEX_HOME: home}).status, 'unknown');
    const day = path.join(home, 'sessions', '2026', '11', '03');
    fs.mkdirSync(day, {recursive: true});
    const now = Date.UTC(2026, 10, 3, 12);
    const line = (used, resets) => JSON.stringify({type: 'event_msg', payload: {type: 'token_count',
      rate_limits: {limit_id: 'codex', primary: {used_percent: used, window_minutes: 300, resets_at: resets}, secondary: null, plan_type: 'pro'}}});
    fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), [line(10, now / 1000 + 600), line(96, now / 1000 + 600)].join('\n') + '\n');
    const seen = codexQuota({CODEX_HOME: home}, now);
    assert.deepEqual([seen.status, seen.used_percent, seen.plan], ['exhausted', 96, 'pro']);
    fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), line(96, now / 1000 - 1) + '\n');
    assert.equal(codexQuota({CODEX_HOME: home}, now).status, 'unknown', 'that window has reset');
    // Large multi-hundred-KB rollout log reads only the bounded tail and still extracts the trailing rate_limits snapshot.
    const padding = JSON.stringify({type: 'event_msg', payload: {type: 'tool_output', text: 'x'.repeat(4096)}}) + '\n';
    fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), padding.repeat(80) + line(42, now / 1000 + 600) + '\n');
    assert.equal(codexQuota({CODEX_HOME: home}, now).used_percent, 42);
    // A session started in an earlier date folder that was updated more recently than today's folder wins by mtime.
    const prevDay = path.join(home, 'sessions', '2026', '11', '02');
    fs.mkdirSync(prevDay, {recursive: true});
    const todayFile = path.join(day, 'rollout-a.jsonl');
    const prevFile = path.join(prevDay, 'rollout-prev.jsonl');
    fs.writeFileSync(todayFile, line(10, now / 1000 + 600) + '\n');
    fs.writeFileSync(prevFile, line(98, now / 1000 + 600) + '\n');
    fs.utimesSync(todayFile, new Date(now - 60000), new Date(now - 60000));
    fs.utimesSync(prevFile, new Date(now - 1000), new Date(now - 1000));
    const crossDay = codexQuota({CODEX_HOME: home}, now);
    assert.deepEqual([crossDay.status, crossDay.used_percent, crossDay.file], ['exhausted', 98, prevFile]);
  } finally {fs.rmSync(home, {recursive: true, force: true});}
});

test("with no CODEX_HOME the telemetry Cindy's own Codex writes (<app data>/CindyGlobal/codex-home) counts, newest first", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'user-home-'));
  try {
    const env = {APPDATA: path.join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: path.join(home, '.config')};
    const homes = codexHomes(env, home);
    assert.equal(homes[0], path.join(home, '.codex'));
    assert.match(homes[1], /CindyGlobal[\\/]codex-home$/);
    assert.deepEqual(codexHomes({CODEX_HOME: '/x'}, home), ['/x'], 'an explicit CODEX_HOME is the only place');
    const now = Date.UTC(2026, 10, 3, 12);
    const write = (root, used, age) => {
      const day = path.join(root, 'sessions', '2026', '11', '03');
      fs.mkdirSync(day, {recursive: true});
      const file = path.join(day, 'rollout-a.jsonl');
      fs.writeFileSync(file, JSON.stringify({type: 'event_msg', payload: {type: 'token_count',
        rate_limits: {primary: {used_percent: used, window_minutes: 10080, resets_at: now / 1000 + 600}, secondary: null}}}) + '\n');
      const at = new Date(now - age);
      fs.utimesSync(file, at, at);
    };
    assert.equal(codexQuota(env, now, homes).status, 'unknown', 'neither place has a session yet');
    write(homes[1], 22, 1000);
    assert.deepEqual([codexQuota(env, now, homes).used_percent, codexQuota(env, now, homes).file.startsWith(homes[1])], [22, true],
      "only Cindy's Codex has run: its snapshot is the quota");
    write(homes[0], 70, 60000);
    assert.equal(codexQuota(env, now, homes).used_percent, 22, 'the newer session wins whichever home it is in');
    // Once CindyGlobal/codex-home has session logs, standalone ~/.codex never overrides it even if newer (without reading auth.json).
    write(homes[0], 99, 100);
    assert.equal(codexQuota(env, now, homes).used_percent, 22, 'standalone ~/.codex does not override Cindy codex-home');
  } finally {fs.rmSync(home, {recursive: true, force: true});}
});

test('screenshot review classifies as visual_analysis (not GUI computer_use), multi-Codex catalogs isolate unbound quota, and empty default efforts are retained', () => {
  const visual = route('Compare screenshots of the login dialog and inspect the screenshot for layout misalignment.');
  assert.equal(visual.decision.work_kind, 'visual_analysis');
  assert.equal(visual.decision.profile.needs_visual, true);
  assert.equal(visual.decision.profile.needs_gui, false);

  const multiCodex = {models: [
    {route: {agentKind: 'codex', providerId: 'openai-a', model: 'gpt-6.1-sol', effort: 'high', fastMode: false}, efforts: ['high'], supportsFastMode: true},
    {route: {agentKind: 'codex', providerId: 'openai-b', model: 'gpt-6.1-sol', effort: 'high', fastMode: false}, efforts: ['high'], supportsFastMode: true},
  ]};
  const unbound = routeTask('Use fast mode: rename foo to bar in util.py.', multiCodex, {quota: {source: 'test', status: 'exhausted', used_percent: 98}});
  assert.equal(unbound.decision.quota_penalized_routes, 0, 'unbound single-home snapshot is not applied across multiple Codex connections');
  const bound = routeTask('Rename foo to bar in util.py.', multiCodex, {quota: {source: 'test', status: 'exhausted', used_percent: 98, providerId: 'openai-a'}});
  assert.equal(bound.route.bundle.providerId, 'openai-b', 'bound snapshot penalizes only its matching providerId');

  const emptyEffortCatalog = {models: [
    {route: {agentKind: 'codex', providerId: 'openai', model: 'gpt-6.1-sol', effort: '', fastMode: false}, efforts: [], supportsFastMode: false},
  ]};
  const emptyEffort = route('Rename foo to bar in util.py.', emptyEffortCatalog);
  assert.equal(emptyEffort.status, 'native');
  assert.equal(emptyEffort.route.bundle.effort, '', 'preserves empty effort on launch route');

  const sparkOnlyCatalog = {models: [REAL.models.at(-1)]};
  const sparkAlgo = route('Implement a standalone algorithm.', sparkOnlyCatalog);
  assert.equal(sparkAlgo.status, 'native', 'all host-offered efforts are ranked when static alias efforts do not overlap');
  assert.equal(sparkAlgo.route.bundle.effort, 'xhigh');
  const sparkRoutine = route('Batch rename foo to bar in all filenames.', sparkOnlyCatalog);
  assert.equal(sparkRoutine.route.bundle.effort, 'xhigh', 'minimal effort (2.1) is below the 2.3 routine floor while xhigh (3.3) clears it');

  const lunaOnlyCatalog = {models: [REAL.models.find(r => r.route.model === 'gpt-6-luna')]};
  const lunaAlgo = route('Implement a standalone algorithm.', lunaOnlyCatalog);
  assert.equal(lunaAlgo.status, 'native', 'all host-offered efforts are ranked even when static spec efforts partially overlap');
  assert.equal(lunaAlgo.route.bundle.effort, 'xhigh');
  for (const debugTask of ['Fix translation.py.', 'Fix the translation parser bug in parser.py.', 'Debug translation pipeline', '修复翻译模块的 bug', 'Fix the keyboard shortcuts in editor.py.', 'Fix mouse event handler in app.ts', 'Fix the React component bug in editor.tsx.']) {
    const res = route(debugTask, lunaOnlyCatalog);
    assert.equal(res.decision.work_kind, 'debug_review', debugTask);
    assert.equal(res.route.bundle.effort, 'max', debugTask);
  }
  assert.equal(route('Take a screenshot of the app.', lunaOnlyCatalog).decision.work_kind, 'computer_use');
  assert.equal(route('用鼠标点击设置里的保存', lunaOnlyCatalog).decision.work_kind, 'computer_use');
  assert.equal(route('Translate README.md into Japanese.', lunaOnlyCatalog).decision.work_kind, 'text_in_text_out');
  assert.equal(route('Translate the React component documentation into Japanese.', lunaOnlyCatalog).decision.work_kind, 'text_in_text_out');

  const multiSegmentPiCatalog = {models: [
    {route: {agentKind: 'pi', providerId: 'openrouter', model: 'openrouter/qwen/qwen3-coder-next', effort: 'high', fastMode: false}, efforts: ['medium', 'high'], supportsFastMode: false},
  ]};
  const multiSeg = route('Rename foo to bar in util.py.', multiSegmentPiCatalog);
  assert.equal(multiSeg.status, 'native', 'multi-segment Pi model IDs remain stable across canonicalization and allocator lookup');
  assert.equal(multiSeg.route.bundle.model, 'openrouter/qwen/qwen3-coder-next');
  assert.equal(route('Fix the keyboard shortcuts in editor.py.', multiSegmentPiCatalog).status, 'native');
});

test('nothing runnable: an empty or foreign catalog is blocked, never guessed', () => {
  assert.equal(route('Rename foo to bar in util.py.', {models: []}).status, 'blocked');
  assert.equal(route('Rename foo to bar in util.py.', {models: [{route: {agentKind: 'gemini', providerId: 'g', model: 'x', effort: ''}}]}).status, 'blocked');
  assert.equal(routeTask('Rename foo to bar in util.py.', undefined, {quota: OK}).status, 'blocked');
});
