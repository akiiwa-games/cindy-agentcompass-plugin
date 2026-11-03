// Windows launcher for test/run-linux-sandbox.sh in the WSL docker-desktop distro, which mounts drives under /mnt/host.
//   node scripts/run-linux-sandbox.mjs        (CINDY_SANDBOX_CACHE: runtime archive cache, default %LOCALAPPDATA%\cindy-sandbox-cache)
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const distro = process.env.CINDY_WSL_DISTRO || 'docker-desktop';
const linux = p => '/mnt/host/' + path.resolve(p).replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase()).split(path.sep).join('/');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = process.env.CINDY_SANDBOX_CACHE || path.join(process.env.LOCALAPPDATA || repo, 'cindy-sandbox-cache');
const env = {CINDY_SANDBOX_CACHE: linux(cache), ...(process.env.AGENTCOMPASS_CHECKOUT ? {AGENTCOMPASS_CHECKOUT_SRC: linux(process.env.AGENTCOMPASS_CHECKOUT)} : {})};
const exports = Object.entries(env).map(([k, v]) => `${k}='${v}'`).join(' ');
const done = spawnSync('wsl', ['-d', distro, '--', 'sh', '-c', `${exports} sh '${linux(path.join(repo, 'test', 'run-linux-sandbox.sh'))}'`], {stdio: 'inherit'});
process.exit(done.status ?? 1);
