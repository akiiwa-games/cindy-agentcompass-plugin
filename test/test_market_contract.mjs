// The plugin/ directory against the makecindy/cindy-official-plugins CI gate (plugin-contract.test.mjs and
// localization.test.mjs at 4223c43e): the pinned Cindy validateGhostManifest (vendored unmodified) plus the
// repository's own source, locale and package rules, re-stated here for this one plugin.
//   CINDY_MARKET_PLUGIN_DIR  check another directory (default: plugin/)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {validateGhostManifest} from './vendor/cindy-plugin-protocol/plugin-manifest.bcdea7e27f97.mjs';

const DIR = path.resolve(process.env.CINDY_MARKET_PLUGIN_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin'));
const LOCALES = ['en', 'ja', 'ko', 'zh-CN'];
const TOOLS = ['roll', 'status', 'stop', 'cleanup'];
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'ghost.json'), 'utf8'));

// Every packaged file, as `ghost_forge_pack` zips the directory. router.json is a local build artifact, never shipped.
const files = fs.readdirSync(DIR, {recursive: true, withFileTypes: true})
  .filter(entry => !entry.isDirectory())
  .map(entry => ({entry, rel: path.relative(DIR, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join('/')}))
  .filter(({rel}) => rel !== 'router.json');

const text = (value, label, max) => {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.ok(value.trim().length > 0 && value.length <= max, `${label} must contain 1-${max} characters`);
};
const semver = (value, label) => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value ?? '');
  assert.ok(match, `${label} must be major.minor.patch`);
  return match.slice(1).map(Number);
};
const safePath = value => Boolean(value) && !value.includes('\\') && !value.startsWith('/') && !/^[A-Za-z]:/.test(value) &&
  value.split('/').every(s => s && s !== '.' && s !== '..' && s !== '__MACOSX' && !/[\u0000-\u001f<>:"|?*]/.test(s) &&
    !/[ .]$/.test(s) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(s));

test('the pinned Cindy manifest validator accepts ghost.json', () => {
  const result = validateGhostManifest(manifest);
  assert.ok(result.ok, result.reason);
});

test('identity, versions and tools meet the official repository rules', () => {
  assert.equal(manifest.id, 'agentcompass');
  assert.match(manifest.id, /^[a-z0-9][a-z0-9-]{0,31}$/);
  assert.equal(manifest.name, 'AgentCompass');
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(Object.hasOwn(manifest, 'slots'), false, 'Manifest v3 must not contain slots');
  semver(manifest.version, 'version');
  assert.ok(semver(manifest.minCindyVersion, 'minCindyVersion').some(part => part > 0), 'minCindyVersion must not be 0.0.0');
  text(manifest.name, 'name', 64);
  text(manifest.description, 'description', 300);
  text(manifest.whenToUse, 'whenToUse', 300);
  assert.ok(safePath(manifest.entry), 'entry must be a safe relative path');
  assert.deepEqual(manifest.tools.map(t => t.name), TOOLS);
  for (const tool of manifest.tools) {
    assert.match(tool.name, /^[a-z][a-z0-9_-]{0,63}$/);
    text(tool.description, `tools.${tool.name}.description`, 1024);
    assert.ok(JSON.stringify(tool.parameters).length <= 16384, `tools.${tool.name}.parameters exceeds 16KB`);
  }
  // M2 & M5 regressions: agent.hiddenTasks is enabled and roll declares optional profile parameter.
  assert.equal(manifest.agent?.hiddenTasks, true, 'M2: manifest.agent.hiddenTasks must be true so classifier tasks can be hidden');
  const rollTool = manifest.tools.find(t => t.name === 'roll');
  assert.deepEqual(rollTool.parameters.required, ['task'], 'M5: only task is required on roll; profile is optional');
  const profileProp = rollTool.parameters.properties?.profile;
  assert.equal(profileProp?.type, 'object', 'M5: roll.parameters.properties.profile must be declared as an object');
  assert.equal(typeof profileProp?.description, 'string');
});

test('the icon is a real, non-empty PNG of 128 or 256 px under 512 KB', () => {
  assert.equal(manifest.icon, 'assets/icon.png');
  const bytes = fs.readFileSync(path.join(DIR, manifest.icon));
  assert.ok(bytes.length > 0 && bytes.length <= 512 * 1024, `icon is ${bytes.length} bytes`);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  const [width, height] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  assert.equal(width, height);
  assert.ok([128, 256].includes(width), `icon is ${width}x${height}`);
  assert.equal(bytes.toString('ascii', bytes.length - 8, bytes.length - 4), 'IEND');
});

test('exactly en/ja/ko/zh-CN locales, each complete for name, description, whenToUse and every tool', () => {
  assert.deepEqual(Object.keys(manifest.locales).sort(), LOCALES);
  for (const [locale, rel] of Object.entries(manifest.locales)) {
    assert.ok(safePath(rel) && rel.endsWith('.json'), `${locale}: ${rel}`);
    const file = path.join(DIR, rel);
    assert.ok(fs.statSync(file).size <= 64 * 1024, `${locale} exceeds 64 KB`);
    const raw = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(fs.readFileSync(file)));
    const allowed = new Set(['name', 'description', 'whenToUse', 'tools', 'panel', 'mainView', 'taskView', 'network', 'node', 'setup']);
    for (const field of Object.keys(raw)) assert.ok(allowed.has(field), `${locale} has unknown field ${field}`);
    text(raw.name, `${locale}.name`, 64);
    text(raw.description, `${locale}.description`, 300);
    text(raw.whenToUse, `${locale}.whenToUse`, 300);
    assert.deepEqual(Object.keys(raw.tools).sort(), [...TOOLS].sort(), `${locale} tool keys`);
    for (const [name, localized] of Object.entries(raw.tools)) {
      for (const field of Object.keys(localized)) assert.ok(['description', 'parameters'].includes(field), `${locale}.tools.${name}.${field}`);
      text(localized.description, `${locale}.tools.${name}.description`, 1024);
      // Parameter text may be localized only at a pointer where the schema itself has a title or description.
      const schema = manifest.tools.find(t => t.name === name).parameters;
      for (const [pointer, fields] of Object.entries(localized.parameters ?? {})) {
        const target = pointer.split('/').slice(1).reduce((node, key) => node?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], schema);
        for (const [field, value] of Object.entries(fields)) {
          assert.equal(typeof target?.[field], 'string', `${locale}.tools.${name}.parameters ${pointer}.${field} has no schema text`);
          text(value, `${locale}.tools.${name}.parameters ${pointer}.${field}`, field === 'title' ? 256 : 1024);
        }
      }
    }
  }
});

test('package source: safe regular files, no reserved or repository-added files, declared files present', () => {
  const folded = new Map();
  let total = 0;
  for (const {entry, rel} of files) {
    assert.ok(safePath(rel), `unsafe package path ${rel}`);
    assert.ok(entry.isFile() && !entry.isSymbolicLink(), `not a regular file: ${rel}`);
    const key = rel.normalize('NFC').toLowerCase();
    assert.ok(!folded.has(key), `case-insensitive conflict ${rel}`);
    folded.set(key, rel);
    total += fs.statSync(path.join(DIR, rel)).size;
  }
  for (const key of folded.keys()) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) assert.ok(!folded.has(parts.slice(0, i).join('/')), `file/directory conflict at ${key}`);
  }
  // The official repository adds its LICENSE, NOTICE and TRADEMARKS files at packaging time; signatures would break.
  for (const key of folded.keys()) {
    assert.ok(!/^(license|notice|trademarks\.md|trademarks\.zh-cn\.md)(\/|$)/.test(key), `${key} conflicts with a repository-added file`);
    assert.ok(!['.disabled', '.cindy-trust.json', 'cindy-signatures.json'].includes(key), `reserved file ${key}`);
  }
  assert.ok(total <= 256 * 1024 * 1024, 'package exceeds 256 MB');
  assert.ok(fs.statSync(path.join(DIR, 'ghost.json')).size <= 256 * 1024, 'ghost.json exceeds 256 KB');
  for (const rel of [manifest.entry, manifest.node.entry, manifest.icon, ...Object.values(manifest.locales)])
    assert.ok(folded.has(rel.toLowerCase()), `declared file missing: ${rel}`);
});

test('no code infers the language from the browser or the operating system', () => {
  for (const {rel} of files.filter(f => /\.(?:html|js|cjs|mjs)$/.test(f.rel)))
    assert.doesNotMatch(fs.readFileSync(path.join(DIR, rel), 'utf8'), /\bnavigator\.(?:language|languages)\b/, rel);
});

// That the worker then routes with its built-in engine, with nothing else installed, is test_worker_bridge.mjs and the
// sandbox's zero-config operation.
test('the market package is the source directory as is: no machine-bound router.json is shipped', {skip: Boolean(process.env.CINDY_MARKET_PLUGIN_DIR)}, () => {
  assert.equal(fs.existsSync(path.join(DIR, 'router.json')), false);
});

// The routing engine ships inside the package: the worker loads engine/route.mjs, and every module it reaches imports only
// Node built-ins and package files. No npm dependency, no Python, no network module.
test('the built-in engine is complete in the package and depends on nothing outside Node', () => {
  const worker = fs.readFileSync(path.join(DIR, manifest.node.entry), 'utf8');
  assert.match(worker, /path\.join\(__dirname, 'engine', 'route\.mjs'\)/);
  const seen = new Set(), queue = ['engine/route.mjs'];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    assert.ok(files.some(f => f.rel === rel), `engine module missing from the package: ${rel}`);
    const source = fs.readFileSync(path.join(DIR, rel), 'utf8');
    for (const [, spec] of source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
      if (spec.startsWith('node:')) {
        assert.ok(['node:fs', 'node:os', 'node:path'].includes(spec), `${rel} imports ${spec}`);
        continue;
      }
      assert.ok(spec.startsWith('./'), `${rel} imports a package dependency ${spec}`);
      queue.push(path.posix.join(path.posix.dirname(rel), spec));
    }
    assert.doesNotMatch(source, /\brequire\(|\bimport\(|\bfetch\(|node:(?:http|https|net|child_process)/, rel);
  }
  assert.deepEqual([...seen].sort(), ['engine/allocator.mjs', 'engine/catalog.mjs', 'engine/profiler.mjs', 'engine/route.mjs']);
});
