// The AgentCompass checkout near a repository: next to it, else, from a git worktree, next to its main checkout.
// A directory of that name with neither the case file nor the agentcompass entry is no checkout and hides none.
import fs from 'node:fs';
import path from 'node:path';

export const CASE_FILE = path.join('skills', 'agent-compass', 'references', 'classifier-cases.json');

const isCheckout = dir => [CASE_FILE, 'agentcompass'].some(part => fs.existsSync(path.join(dir, part)));

function nextToMainCheckout(repo) {
  try {
    const dotGit = path.join(repo, '.git');
    if (!fs.existsSync(dotGit) || !fs.statSync(dotGit).isFile()) return null;
    const m = /^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/]/i.exec(fs.readFileSync(dotGit, 'utf8').trim());
    return m ? path.resolve(m[1], '..', 'AgentCompass') : null;
  } catch {
    return null;
  }
}

export function findCheckout(repo) {
  return [path.join(repo, '..', 'AgentCompass'), nextToMainCheckout(repo)].filter(Boolean).find(isCheckout) ?? null;
}

// For a caller that goes on to use it: with none to find, the path that names what is missing.
export function defaultCheckout(repo) {
  return findCheckout(repo) ?? path.join(repo, '..', 'AgentCompass');
}
