// The AgentCompass checkout to use by default: next to this repository, else, from a git worktree, next to its main checkout.
import fs from 'node:fs';
import path from 'node:path';

export function defaultCheckout(repo) {
  const sibling = path.join(repo, '..', 'route_manager');
  if (fs.existsSync(sibling)) return sibling;
  try {
    const dotGit = path.join(repo, '.git');
    if (fs.existsSync(dotGit) && fs.statSync(dotGit).isFile()) {
      const m = /^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/]/i.exec(fs.readFileSync(dotGit, 'utf8').trim());
      if (m) {
        const mainSibling = path.resolve(m[1], '..', 'route_manager');
        if (fs.existsSync(mainSibling)) return mainSibling;
      }
    }
  } catch { /* ignore */ }
  return sibling;
}
