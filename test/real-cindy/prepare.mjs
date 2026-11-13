// Host side, step 1 of a real-Cindy acceptance in a disposable Windows Sandbox guest.
//
//   node test/real-cindy/prepare.mjs [--scratch <dir>] [--version <x.y.z>]
//
// Builds a scratch directory under the OS temp directory (never inside the repository), downloads the current official
// Windows "global" Cindy installer from Cindy's public release channel into it, verifies the Authenticode signature,
// records version and sha256, stages plugin/ and the guest scripts, and writes <scratch>/run.json (the one file the other
// scripts read their locations from) plus the Windows Sandbox configuration <scratch>/guest.wsb.
// Nothing runs the installer here. Layout:
//   <scratch>/stage   mapped read-only into the guest as C:\stage   (installer, plugin/, guest scripts, sign-in copies)
//   <scratch>/out     mapped read-write into the guest as C:\out    (logs and evidence written by guest scripts)
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const RELEASES = 'https://api.github.com/repos/makecindy/cindy/releases';

const scratch = resolve(opt('--scratch') || join(tmpdir(), `cindy-real-${randomBytes(4).toString('hex')}`));
const stage = join(scratch, 'stage');
const out = join(scratch, 'out');
mkdirSync(join(stage, 'installer'), { recursive: true });
mkdirSync(out, { recursive: true });

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'cindy-real-acceptance' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

// The newest published, non-prerelease release that carries a Windows global installer.
const wanted = opt('--version');
const releases = await getJson(`${RELEASES}?per_page=20`);
const release = releases.find((r) => !r.prerelease && !r.draft && (!wanted || r.tag_name === `v${wanted}`)
  && r.assets.some((a) => /-win32-x64-global\.exe$/.test(a.name)));
if (!release) throw new Error('no matching Cindy release with a win32-x64-global installer');
const asset = release.assets.find((a) => /-win32-x64-global\.exe$/.test(a.name));
const installer = join(stage, 'installer', asset.name);

const resp = await fetch(asset.browser_download_url, { headers: { 'user-agent': 'cindy-real-acceptance' } });
if (!resp.ok) throw new Error(`download: HTTP ${resp.status}`);
await pipeline(Readable.fromWeb(resp.body), createWriteStream(installer));
const sha256 = createHash('sha256').update(readFileSync(installer)).digest('hex');
const published = (asset.digest || '').replace(/^sha256:/, '');

// Signature check reads the file; it does not run it.
const sigJson = execFileSync('powershell', ['-NoProfile', '-Command',
  '$s = Get-AuthenticodeSignature -LiteralPath $env:CINDY_INSTALLER; [pscustomobject]@{Status=[string]$s.Status; Subject=$s.SignerCertificate.Subject; Issuer=$s.SignerCertificate.Issuer; Thumbprint=$s.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress'],
  { encoding: 'utf8', env: { ...process.env, CINDY_INSTALLER: installer } }).trim();
const signature = JSON.parse(sigJson);

const build = {
  product_version: release.tag_name.replace(/^v/, ''),
  tag: release.tag_name,
  published_at: release.published_at,
  installer: asset.name,
  size: asset.size,
  sha256,
  sha256_published_by_release: published || null,
  sha256_matches_release: published ? published.toLowerCase() === sha256 : null,
  signature,
};
if (signature.Status !== 'Valid') throw new Error(`signature is not valid: ${signature.Status}`);
if (published && published.toLowerCase() !== sha256) throw new Error('sha256 differs from the release digest');

cpSync(join(repo, 'plugin'), join(stage, 'plugin'), { recursive: true });
cpSync(here, join(stage, 'scripts'), { recursive: true, filter: (p) => !p.endsWith('.wsb') });

const run = { scratch, stage, out, installer: asset.name, build, createdAt: new Date().toISOString() };
writeFileSync(join(scratch, 'run.json'), JSON.stringify(run, null, 2));
const cfg = execFileSync(process.execPath, [join(here, 'make-sandbox-config.mjs'), scratch], { encoding: 'utf8' });
process.stdout.write(`${JSON.stringify({ scratch, build, config: cfg.trim() }, null, 2)}\n`);
if (!existsSync(join(scratch, 'guest.wsb'))) throw new Error('guest.wsb not written');
