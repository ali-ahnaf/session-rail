/**
 * Worktree inspection — pure filesystem reads, no git subprocess.
 *
 * Lives in `scan/` because the registry needs these to mark and link worktree
 * project rows, and `scan/` may not import from `workspace/`. The write side
 * (`git worktree add`/`remove`) stays in `src/workspace/worktree.ts`, which
 * re-exports these for its callers.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import * as path from 'path';

import { safely } from '../util/log';

/** Walk up from `dir` to the nearest `.git` (dir in a clone, file in a worktree). */
export function gitRootOf(dir: string): string | undefined {
  let current = dir;
  for (;;) {
    if (existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/** True when `dir` is a linked worktree — its `.git` is a file, not a directory. */
export function isWorktreeDir(dir: string): boolean {
  return safely(
    `isWorktreeDir(${dir})`,
    () => statSync(path.join(dir, '.git')).isFile(),
    false,
  );
}

/**
 * The main repository a linked worktree belongs to, parsed from its `.git`
 * file (`gitdir: <main>/.git/worktrees/<name>`). Undefined when the file does
 * not have that shape — bare repos and future git versions may differ.
 */
export function mainRepoFor(worktreeDir: string): string | undefined {
  return safely<string | undefined>(
    `mainRepoFor(${worktreeDir})`,
    () => {
      const content = readFileSync(path.join(worktreeDir, '.git'), 'utf8');
      const match = /^gitdir:\s*(.+)$/m.exec(content);
      if (!match) {
        return undefined;
      }
      const gitdir = match[1].trim();
      const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
      const index = gitdir.lastIndexOf(marker);
      return index > 0 ? gitdir.slice(0, index) : undefined;
    },
    undefined,
  );
}
