/**
 * Worktree inspection — pure filesystem reads, no git subprocess.
 *
 * Lives in `scan/` because the registry needs these to mark and link worktree
 * project rows, and `scan/` may not import from `workspace/`. The write side
 * (`git worktree add`/`remove`) stays in `src/workspace/worktree.ts`, which
 * re-exports these for its callers.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
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

/**
 * Every linked worktree of a main repo, read from git's own registry at
 * `<repo>/.git/worktrees/<name>/gitdir` — the file holds the path of the
 * worktree's `.git` file, so its dirname is the worktree directory.
 *
 * Registry-side, not `git worktree list`: this runs on every poll, so it may
 * not shell out. A worktree whose directory is gone (moved or deleted but not
 * yet pruned) is skipped — the tree must never offer a row for a path that
 * cannot be opened. Returns nothing for a linked worktree or a non-repo, both
 * of which have no `worktrees/` of their own.
 */
export function worktreesOf(repoDir: string): string[] {
  return safely<string[]>(
    `worktreesOf(${repoDir})`,
    () => {
      const base = path.join(repoDir, '.git', 'worktrees');
      if (!safely(`statSync(${base})`, () => statSync(base).isDirectory(), false)) {
        return [];
      }
      const dirs: string[] = [];
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const dir = safely<string | undefined>(
          `worktreeGitdir(${entry.name})`,
          () => {
            const gitdir = readFileSync(path.join(base, entry.name, 'gitdir'), 'utf8').trim();
            return gitdir.length > 0 ? path.dirname(gitdir) : undefined;
          },
          undefined,
        );
        if (dir !== undefined && existsSync(dir)) {
          dirs.push(dir);
        }
      }
      return dirs;
    },
    [],
  );
}
