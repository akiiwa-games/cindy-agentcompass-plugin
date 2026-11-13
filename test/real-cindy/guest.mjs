// Host side: start, drive and stop the Windows Sandbox guest with the `wsb` CLI. No input ever goes to the host desktop.
//   node test/real-cindy/guest.mjs <scratch> start            start (refuses if a sandbox already runs), window kept in the background
//   node test/real-cindy/guest.mjs <scratch> setup <step>     run guest-setup.ps1 -Step <step> inside the guest, as the logged-in guest user
//   node test/real-cindy/guest.mjs <scratch> exec "<command>" run any command inside the guest
//   node test/real-cindy/guest.mjs <scratch> window [show]   minimise the guest window (default) or show it without taking focus
//   node test/real-cindy/guest.mjs <scratch> ip | list | stop
// The guest id and address are kept in <scratch>/guest.json.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [scratch, cmd, ...rest] = process.argv.slice(2);
if (!scratch || !cmd) throw new Error('usage: guest.mjs <scratch> start|setup|exec|ip|list|stop ...');
const stateFile = join(scratch, 'guest.json');
const state = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {});
const save = (o) => writeFileSync(stateFile, JSON.stringify({ ...state(), ...o }, null, 2));
const wsb = (args) => {
  const r = spawnSync('wsb', [...args, '--raw'], { encoding: 'utf8' });
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { code: r.status, json, text: (r.stdout || '') + (r.stderr || '') };
};
const running = () => wsb(['list']).json?.WindowsSandboxEnvironments ?? [];

// Minimise the guest window without activating it (SW_SHOWMINNOACTIVE), so it never takes focus from the owner.
// `window` restores it without activating (SW_SHOWNOACTIVATE) for the moment the owner must act in it.
function backgroundGuestWindow(show = 7) {
  const ps = `
Add-Type @'
using System; using System.Runtime.InteropServices;
public class W { [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c); }
'@
Get-Process | Where-Object { $_.Name -match 'WindowsSandboxClient|WindowsSandboxRemoteSession' -and $_.MainWindowHandle -ne 0 } |
  ForEach-Object { [W]::ShowWindowAsync($_.MainWindowHandle, ${show}) | Out-Null; $_.Name }`;
  return spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).stdout.trim();
}

if (cmd === 'list') { process.stdout.write(JSON.stringify(running()) + '\n'); }
else if (cmd === 'start') {
  const already = running();
  if (already.length) { process.stdout.write(JSON.stringify({ started: false, reason: 'a Windows Sandbox is already running', running: already }) + '\n'); process.exit(2); }
  const xml = readFileSync(join(scratch, 'guest.wsb'), 'utf8');
  const r = wsb(['start', '--config', xml]);
  const id = r.json?.Id ?? r.json?.id ?? running()[0];
  save({ id, startedAt: new Date().toISOString() });
  process.stdout.write(JSON.stringify({ started: !!id, id, raw: r.json ?? r.text.trim() }) + '\n');
  // `wsb start` is headless: commands run as the logged-in guest user only once a remote session exists, so connect, then
  // push the window to the background (the owner restores it from the taskbar when they need it).
  wsb(['connect', '--id', id]);
  for (let i = 0; i < 20; i += 1) { const w = backgroundGuestWindow(); if (w) { process.stdout.write(`window backgrounded: ${w.replace(/\s+/g, ' ')}\n`); break; } execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 700']); }
} else if (cmd === 'window') {
  process.stdout.write(backgroundGuestWindow(rest[0] === 'show' ? 4 : 7) + '\n');
} else if (cmd === 'exec' || cmd === 'setup') {
  const id = state().id;
  const command = cmd === 'setup'
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File C:\\stage\\scripts\\guest-setup.ps1 -Step ${rest[0]}`
    : rest.join(' ');
  const r = wsb(['exec', '--id', id, '--run-as', 'ExistingLogin', '--command', command]);
  process.stdout.write(JSON.stringify({ code: r.code, answer: r.json ?? r.text.trim() }) + '\n');
} else if (cmd === 'ip') {
  const r = wsb(['ip', '--id', state().id]);
  const ip = JSON.stringify(r.json ?? r.text).match(/\d+\.\d+\.\d+\.\d+/)?.[0];
  if (ip) save({ ip });
  process.stdout.write(JSON.stringify({ ip, raw: r.json ?? r.text.trim() }) + '\n');
} else if (cmd === 'stop') {
  const r = wsb(['stop', '--id', state().id]);
  process.stdout.write(JSON.stringify({ code: r.code, answer: r.json ?? r.text.trim(), running_after: running() }) + '\n');
} else throw new Error(`unknown command ${cmd}`);
