// A FIXTURE ROUTER, not AgentCompass: answers the plugin's `roll` call with what the real router does not produce in the
// sandbox, chosen by a `FIXTURE-ROUTER: <answer>` line in the task.
//   self  the delegate answer "do it yourself" (the public roll command has no path that returns it)
//   fast  a codex native route with fast mode (the real router turns it on only with live capacity telemetry or --fast)
// It parses the same arguments the real router gets and writes its worker prompt file the same way.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name) + 1];
const chunks = [];
process.stdin.on('data', d => chunks.push(d)).on('end', () => {
  const task = Buffer.concat(chunks).toString('utf8');
  const answer = (/FIXTURE-ROUTER: (\w+)/.exec(task) || [])[1];
  const parent = arg('--parent-id');
  if (answer === 'self') {
    process.stdout.write(JSON.stringify({status: 'self', fixture_router: true, parent_id: parent,
      next_action: 'Do this task in the current session; no worker is started.'}));
    process.exit(0);
  }
  if (answer === 'fast') {
    const prompt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-router-')), 'worker-prompt.md');
    fs.writeFileSync(prompt, `${task}\nParent session agent ID: \`${parent}\`\n`, 'utf8');
    process.stdout.write(JSON.stringify({status: 'native', fixture_router: true, parent_host: arg('--parent-host'), parent_id: parent,
      parent_address: arg('--parent-address'), worker_prompt_file: prompt,
      route: {bundle: {provider: 'codex', harness: 'codex', account: 'codex', model: 'gpt-6.1-sol', effort: 'high', fast: true}}}));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({status: 'blocked', fixture_router: true, error: 'no FIXTURE-ROUTER answer in the task'}));
  process.exit(2);
});
