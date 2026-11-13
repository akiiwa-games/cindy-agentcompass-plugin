// Regenerates the vendored engine from a checkout of akiiwa-games/magpie-agentcompass-router:
//   node scripts/vendor_engine.mjs <magpie checkout> [commit]
// It reads the commit, never the working tree or HEAD, so a checkout that is behind or has local changes gives the same files.
// Each file is the source at that commit with a two-line header added and its relative imports renamed. Nothing else differs.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const DEFAULT_COMMIT = 'ac494f31dda6dc516e985594208e28fca85aa5fb';

// plugin/engine/<name>.mjs: src/<source>.js
export const VENDORED_SOURCES = {
  'axis-scores': 'axis-scores',
  allocator: 'allocator',
  'candidate-eval': 'candidate-eval',
  'candidate-ranking': 'candidate-ranking',
  catalog: 'catalog',
  continuity: 'continuity',
  fleet: 'fleet',
  plans: 'plans',
  profiler: 'profiler-core',
  'quota-economy': 'quota-economy',
  'quota-loader': 'quota-loader',
  'quota-pools': 'quota-pools',
  quota: 'quota',
  'reference-data': 'reference-data',
  'task-intake': 'task-intake',
  'user-scores': 'user-scores',
};

const renamed = (text, rename) => text.replace(/from "\.\/([\w-]+)\.(m?js)"/g, (_, name, ext) => `from "./${rename(name, ext)}"`);

export function vendoredText(name, source, commit) {
  const toVendored = from => `${Object.keys(VENDORED_SOURCES).find(key => VENDORED_SOURCES[key] === from)}.mjs`;
  const header = `// Vendored from akiiwa-games/magpie-agentcompass-router src/${VENDORED_SOURCES[name]}.js at ${commit} (MIT), itself ported from AgentCompass.\n` +
    '// Only the import paths differ from the source; regenerate with scripts/vendor_engine.mjs rather than edit.\n';
  return header + renamed(source, toVendored);
}

export function sourceText(vendored) {
  const body = vendored.split('\n').slice(2).join('\n');
  return renamed(body, name => `${VENDORED_SOURCES[name]}.js`);
}

const runGit = args => execFileSync('git', args, {encoding: 'utf8', maxBuffer: 1 << 26});

export function vendorEngine(checkout, commit = DEFAULT_COMMIT, engine = fileURLToPath(new URL('../plugin/engine/', import.meta.url)), git = runGit) {
  const full = git(['-C', checkout, 'rev-parse', '--verify', `${commit}^{commit}`]).trim();
  for (const [name, source] of Object.entries(VENDORED_SOURCES)) {
    fs.writeFileSync(path.join(engine, `${name}.mjs`), vendoredText(name, git(['-C', checkout, 'show', `${full}:src/${source}.js`]), full));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [checkout, commit] = process.argv.slice(2);
  if (!checkout) throw Error('usage: node scripts/vendor_engine.mjs <magpie checkout> [commit]');
  vendorEngine(checkout, commit);
}
