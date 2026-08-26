/**
 * Git worktrees — one directory per parallel session.
 *
 * The orca model: run several Claude Code sessions against one repo without
 * them stomping each other's working tree, by giving each its own worktree.
 * Worktrees live outside every repo, under
 * `<globalStorage>/worktrees/<repo>/<branch>`, so the repo itself stays
 * untouched — not even an ignored directory appears in it — and every worktree
 * groups as its own project row (its `.git` is a file, which `gitRootFor`
 * already treats as a root). The `<repo>` level is not decoration: the base is
 * shared by every repo on the machine, and without it two repos with a `main`
 * branch would collide on one path.
 *
 * The base is `context.globalStorageUri.fsPath` — the directory VS Code hands
 * this extension to write in. It is passed down rather than read here, so this
 * module stays free of `vscode` and the checks can drive it with a temp dir.
 * The obvious-looking `~/.vscode/extensions/session-rail/` is deliberately NOT
 * used: that is VS Code's own extension install directory, which it prunes.
 * globalStorage survives extension updates and is pruned by nothing.
 *
 * This module shells out to `git` — the one place the extension does. Always
 * `execFile` with an args array, never a shell string, and the name is
 * validated before it becomes a path and a branch. Nothing here touches
 * `~/.claude`; like the scratchpad, these are writes into directories the user
 * explicitly asked for.
 */

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';

import { gitRootOf, isWorktreeDir, mainRepoFor } from '../scan/worktree';
import { log } from '../util/log';

// The read side (pure fs inspection) lives in scan/worktree.ts so the registry
// can use it without importing from this layer; re-exported here so callers of
// the write side have one module to deal with.
export { gitRootOf, isWorktreeDir, mainRepoFor };

const GIT_TIMEOUT_MS = 15_000;

/**
 * The name becomes a folder and a branch, so it is validated the way
 * `SAFE_SESSION_ID` is: refuse anything surprising rather than trust it.
 * Slashes are allowed (branch-style names like `feat/auth` are idiomatic);
 * `..` segments and lone separators are not.
 */
export const SAFE_WORKTREE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

const MAX_NAME_LENGTH = 100;

/** Error message for a rejected name, or undefined when it is usable. */
export function validateWorktreeName(name: string): string | undefined {
  if (name.length === 0) {
    return 'Enter a name.';
  }
  if (name.length > MAX_NAME_LENGTH) {
    return `Keep it under ${MAX_NAME_LENGTH} characters.`;
  }
  if (!SAFE_WORKTREE_NAME.test(name)) {
    return 'Use letters, digits, dots, dashes, underscores, or slashes, starting with a letter or digit.';
  }
  const segments = name.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return 'Slash-separated segments must not be empty, `.`, or `..`.';
  }
  if (name.endsWith('.lock')) {
    // git refuses branch names ending in `.lock`; fail it here with a reason.
    return 'A branch name cannot end in `.lock`.';
  }
  return undefined;
}

/**
 * The subdirectory of globalStorage worktrees live in — so anything else this
 * extension ever stores there cannot be mistaken for a repo.
 */
export const WORKTREE_DIR = 'worktrees';

/**
 * Where worktrees of `repoRoot` live: `<base>/worktrees/<repo>`.
 *
 * Deliberately outside the repo — a worktree nested inside its own main repo
 * shows up as untracked in every `git status` and confuses tools that walk the
 * tree. The per-repo level keeps two repos' identically-named branches apart.
 */
export function worktreeParentFor(repoRoot: string, base: string): string {
  return path.join(base, WORKTREE_DIR, path.basename(repoRoot));
}

/**
 * The folder for a branch: slashes flattened to dashes.
 *
 * Branch names are idiomatically `feat/auth`, but as a path that would mint an
 * intermediate `feat` directory and leave the row labelled `auth` — so the
 * folder is one flat segment and the branch keeps its real name. The two are
 * no longer the same string; every path built for a worktree goes through here
 * and every git branch argument does not.
 */
export function worktreeFolderName(branch: string): string {
  return branch.split('/').join('-');
}

export interface CreateWorktreeResult {
  outcome: 'created' | 'missing-dir' | 'not-a-repo' | 'bad-name' | 'exists' | 'failed';
  /** The new worktree directory, on 'created'. */
  dir?: string;
  /** The decisive git stderr line, on 'failed'. */
  detail?: string;
}

/**
 * Create a worktree of the repo containing `dir`, branched `name` and foldered
 * `worktreeFolderName(name)`.
 *
 * Tries `git worktree add -b <name>` first (new branch from HEAD); when git
 * refuses because the branch already exists, retries as a plain checkout of
 * that branch. Any other git failure is reported, never retried. git creates
 * the leading directories itself, which is what makes the shared base and the
 * `<repo>` level appear on first use with no mkdir here.
 */
export async function createWorktree(
  dir: string,
  name: string,
  base: string,
): Promise<CreateWorktreeResult> {
  if (!existsSync(dir)) {
    log.warn(`Cannot create a worktree from ${dir}: the directory no longer exists`);
    return { outcome: 'missing-dir' };
  }
  const invalid = validateWorktreeName(name);
  if (invalid !== undefined) {
    log.warn(`Refusing worktree name "${name}": ${invalid}`);
    return { outcome: 'bad-name', detail: invalid };
  }
  const root = gitRootOf(dir);
  if (root === undefined) {
    log.warn(`Cannot create a worktree from ${dir}: not inside a git repository`);
    return { outcome: 'not-a-repo' };
  }

  const target = path.join(worktreeParentFor(root, base), worktreeFolderName(name));
  if (existsSync(target)) {
    return { outcome: 'exists', dir: target };
  }

  const fresh = await runGit(['worktree', 'add', target, '-b', name], root);
  if (fresh.ok) {
    log.info(`Created worktree ${target} on new branch ${name}`);
    return { outcome: 'created', dir: target };
  }

  if (/already exists/i.test(fresh.stderr)) {
    // The branch exists; check it out into the worktree instead.
    const checkout = await runGit(['worktree', 'add', target, name], root);
    if (checkout.ok) {
      log.info(`Created worktree ${target} on existing branch ${name}`);
      return { outcome: 'created', dir: target };
    }
    return { outcome: 'failed', detail: firstLine(checkout.stderr) };
  }

  return { outcome: 'failed', detail: firstLine(fresh.stderr) };
}

export interface RemoveWorktreeResult {
  outcome: 'removed' | 'not-a-worktree' | 'dirty' | 'failed';
  detail?: string;
}

/**
 * Remove a linked worktree via `git worktree remove`, run from its main repo.
 *
 * git refuses a worktree with modified or untracked files unless forced;
 * that refusal is surfaced as 'dirty' so the caller can confirm before
 * retrying with `force` — the branch is never deleted either way.
 */
export async function removeWorktree(
  worktreeDir: string,
  options: { force?: boolean } = {},
): Promise<RemoveWorktreeResult> {
  if (!isWorktreeDir(worktreeDir)) {
    log.warn(`Refusing to remove ${worktreeDir}: it is not a linked git worktree`);
    return { outcome: 'not-a-worktree' };
  }
  const main = mainRepoFor(worktreeDir);
  if (main === undefined) {
    return { outcome: 'failed', detail: 'could not locate the main repository from its .git file' };
  }

  const args = ['worktree', 'remove'];
  if (options.force === true) {
    args.push('--force');
  }
  args.push(worktreeDir);

  const result = await runGit(args, main);
  if (result.ok) {
    log.info(`Removed worktree ${worktreeDir}`);
    return { outcome: 'removed' };
  }
  if (/contains modified or untracked files|use --force/i.test(result.stderr)) {
    return { outcome: 'dirty' };
  }
  return { outcome: 'failed', detail: firstLine(result.stderr) };
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run git with an args array — no shell, bounded by GIT_TIMEOUT_MS. */
function runGit(args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise<GitResult>((resolve) => {
    const child = execFile(
      'git',
      [...args],
      { cwd, timeout: GIT_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          log.warn(`git ${args.join(' ')} failed in ${cwd}: ${firstLine(stderr) || error.message}`);
        }
        resolve({ ok: error === null, stdout, stderr });
      },
    );
    child.on('error', (error) => {
      // Spawn failure (git missing) — the callback above may not fire.
      resolve({ ok: false, stdout: '', stderr: error.message });
    });
  });
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
}

/** A local branch of a repo, as offered in the new-worktree picker. */
export interface LocalBranch {
  /** Branch name as git prints it, slashes intact (`feat/auth`). */
  name: string;
  /**
   * The directory this branch is currently checked out in — the main repo or
   * an existing worktree — or undefined when it is checked out nowhere. git
   * refuses a second worktree on a branch, so this is what makes an
   * unusable choice visible before it is made.
   */
  checkedOutIn?: string;
  /** True when this is HEAD of the repo the picker was opened from. */
  current: boolean;
}

/**
 * Every local branch of `repoRoot`, most recently committed first.
 *
 * `%(worktreepath)` is empty unless the branch is checked out somewhere, which
 * covers the main repo and every linked worktree in one read. It arrived in
 * git 2.23; on anything older the field prints literally, so it is only
 * trusted when it looks like an absolute path. A failure here is not fatal —
 * the picker still accepts a typed name — so it degrades to an empty list.
 */
export async function listLocalBranches(repoRoot: string): Promise<LocalBranch[]> {
  const result = await runGit(
    [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)%09%(worktreepath)%09%(HEAD)',
      'refs/heads',
    ],
    repoRoot,
  );
  if (!result.ok) {
    return [];
  }
  const branches: LocalBranch[] = [];
  for (const line of result.stdout.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    const [name, worktreePath, head] = line.split('\t');
    if (name === undefined || name.length === 0) {
      continue;
    }
    const checkedOutIn =
      worktreePath !== undefined && path.isAbsolute(worktreePath.trim())
        ? worktreePath.trim()
        : undefined;
    branches.push({ name, checkedOutIn, current: head === '*' });
  }
  return branches;
}
