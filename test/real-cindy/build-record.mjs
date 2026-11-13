// Host side: turn what a real-Cindy run left in <scratch> into the run record (acceptance.json) of the repository.
//   node test/real-cindy/build-record.mjs <scratch> <out dir> <spec.json>
// <spec.json> names the scenarios (see the keys used below) and the words to redact. The record is written redacted and then
// scanned: it fails if an e-mail address, a redacted word, an owner id or the host's user name is still in it.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [scratch, outDir, specFile] = process.argv.slice(2);
if (!scratch || !outDir || !specFile) throw new Error('usage: build-record.mjs <scratch> <out dir> <spec.json>');
const spec = JSON.parse(readFileSync(specFile, 'utf8'));
const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8').replace(/^﻿|^��|\0/g, '')) : null);
const readText = (file) => (existsSync(file) ? readFileSync(file, 'utf8').replace(/\0/g, '').replace(/^﻿/, '') : null);
const stateDir = join(scratch, 'out', 'state-final');
const hostUser = (homedir().split(/[\\/]/).pop() || '').toLowerCase();
const redactWords = [...(spec.redact || [])];
const EMAIL = /[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g;

function scrub(value) {
  const text = JSON.stringify(value);
  let t = text.replace(EMAIL, '<email>');
  for (const w of redactWords) if (w) t = t.split(w).join('<redacted>');
  t = t.replace(/owners\\\\[0-9a-f]{20}/g, 'owners\\\\<owner>').replace(/owners\/[0-9a-f]{20}/g, 'owners/<owner>');
  return JSON.parse(t);
}

// The live catalog Cindy reported (written by the throwaway catalog probe), to check every route against.
const catalog = (readText(join(scratch, 'out', 'models.jsonl')) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const inCatalog = (b) => catalog.some((r) => r.route.agentKind === b.agentKind && r.route.providerId === b.providerId && r.route.model === b.model
  && (r.efforts || [r.route.effort]).includes(b.effort) && (!b.fastMode || r.supportsFastMode));

function operation(op) {
  const dir = join(stateDir, op);
  const receipt = readJson(join(dir, 'receipt.json'));
  const router = readJson(join(dir, 'router.stdout.json'));
  const out = { operation: op, router };
  if (!receipt) return out;
  const route = receipt.route || null;
  const run = receipt.run || null;
  out.receipt = {
    state: receipt.state, delivery: receipt.delivery, taskId: receipt.taskId, runId: receipt.runId, route, createRequest: receipt.createRequest,
    run, finalMessage: receipt.finalMessage ?? null, messagesComplete: receipt.messagesComplete ?? null, error: receipt.error ?? null,
    inputText: receipt.sendRequest?.text ?? null, prompt: receipt.prompt,
    ...(run?.acceptedAt ? { accepted_at_utc: new Date(run.acceptedAt).toISOString() } : {}),
    ...(run?.completedAt ? { completed_at_utc: new Date(run.completedAt).toISOString() } : {}),
  };
  if (route && run) {
    out.checks = {
      route_is_a_row_of_the_live_catalog: inCatalog(route),
      acceptedConfig_equals_route: ['agentKind', 'providerId', 'model', 'effort', 'fastMode'].every((k) => run.acceptedConfig?.[k] === route[k]),
      task_input_is_the_task_plus_the_return_channel_contract: Boolean(receipt.sendRequest?.text) && receipt.sendRequest.text === receipt.prompt
        && /Cindy plugin task return channel:/.test(receipt.prompt) && (!spec.operations?.[op]?.task || receipt.prompt.startsWith(spec.operations[op].task)),
      messages_complete_before_final_message_taken: receipt.messagesComplete === true,
      permission_mode: receipt.createRequest?.permissionMode ?? null,
    };
  }
  return out;
}

const record = {
  record: 'Real Cindy acceptance of the Cindy plugin 0.4.0',
  note: 'Times are UTC. The model-run answers were pasted back by a Cindy agent; the receipts and router outputs under each operation are the plugin\'s own files and are the primary evidence. Names, addresses and ids of the account are redacted.',
  build: spec.build, install: readJson(join(scratch, 'out', 'install.json')), zero_config_probe: readJson(join(scratch, 'out', 'zero-config-probe.json')),
  plugin: spec.plugin, account: spec.account, setup_gate: spec.setup_gate, catalog: spec.catalog_summary,
  scenarios: spec.scenarios.map((s) => ({
    id: s.id, title: s.title, expectation: s.expectation, result: s.result, observation: s.observation ?? null,
    agent_model: s.agent_model ?? null,
    operations: (s.operations || []).map(operation),
    agent_transcript: s.transcript ? [].concat(s.transcript).map((f) => (readText(join(scratch, 'tx', f)) || '').split('\n')
      .filter((l) => !/^Note \d+:|^BEGIN|lorem lorem/.test(l)).join('\n').slice(0, 12000)).join('\n=====\n') : null,
    extra: s.extra ?? null,
  })),
  cooldown_record: readJson(join(stateDir, 'classifier-cooldowns.json')),
  findings: spec.findings, quota_attribution: spec.quota_attribution, classifications_spent: spec.classifications_spent,
};

const clean = scrub(record);
const text = JSON.stringify(clean, null, 2);
const bad = [];
if ((text.match(EMAIL) || []).some((m) => m !== '<email>')) bad.push('an e-mail address');
for (const w of redactWords) if (w && text.includes(w)) bad.push(`redacted word ${w.slice(0, 3)}…`);
if (hostUser && text.toLowerCase().includes(hostUser)) bad.push('the host user name');
if (/owners[\\/]+[0-9a-f]{20}/.test(text.replace(/owners[\\/]+<owner>/g, ''))) bad.push('an owner id');
if (bad.length) throw new Error(`record is not clean: ${bad.join(', ')}`);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'acceptance.json'), text);
process.stdout.write(`wrote ${join(outDir, 'acceptance.json')} (${text.length} bytes, ${clean.scenarios.length} scenarios)\n`);
