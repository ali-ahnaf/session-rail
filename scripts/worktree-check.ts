/**
 * Check of the ignored-file seeding that follows `git worktree add`.
 *
 * Deterministic, and it does not contradict the no-fixtures rule: nothing here
 * stands in for `~/.claude`. It builds a throwaway repo in a temp directory and
 * runs real `git`, so what is pinned is this code's agreement with git's own
 * ignore matcher — the thing it is delegating to — rather than with an
 * assumption about a file format that can drift.
 *
 * Run: npm run check:worktree
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { copyIgnoredFiles, validateWorktreeName, worktreeFolderName } from '../src/workspace/worktree';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  [${ok ? 'pass' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) {
    failures += 1;
  }
}

/**
 * A repo with one commit, an ignored file, an ignored directory holding a
 * symlink, an empty ignored directory, and a path that is ignored here but
 * tracked on the worktree's branch — the case a careless copy corrupts.
 */
function buildRepo(root: string): { repo: string; worktree: string } {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'check@example.invalid');
  git('config', 'user.name', 'worktree-check');
  writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\nempty-ignored/\nshared.txt\n');
  writeFileSync(join(repo, 'README.md'), 'tracked');
  git('add', '.');
  git('commit', '-qm', 'init');

  writeFileSync(join(repo, '.env'), 'SECRET=1');
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;');
  symlinkSync(join(repo, 'node_modules', 'pkg'), join(repo, 'node_modules', 'link'));
  mkdirSync(join(repo, 'empty-ignored'), { recursive: true });
  writeFileSync(join(repo, 'shared.txt'), 'source version');

  const worktree = join(root, 'wt');
  execFileSync('git', ['worktree', 'add', worktree, '-b', 'feat/seed'], { cwd: repo, stdio: 'pipe' });
  writeFileSync(join(worktree, 'shared.txt'), 'worktree version');
  return { repo, worktree };
}

async function main(): Promise<void> {
  console.log('Worktree naming');
  {
    check('slashes flatten in the folder', worktreeFolderName('feat/auth') === 'feat-auth');
    check('a traversal name is refused', validateWorktreeName('../escape') !== undefined);
  }

  const root = mkdtempSync(join(tmpdir(), 'session-rail-worktree-'));
  try {
    const { repo, worktree } = buildRepo(root);

    console.log('\nSeeding ignored files into a fresh worktree');
    const entries: string[] = [];
    const result = await copyIgnoredFiles(repo, worktree, (entry) => entries.push(entry));

    check('the pass reports copied', result.outcome === 'copied', result.outcome);
    check('nothing failed', result.failed === 0, String(result.failed));
    check(
      'a wholly-ignored directory is one entry, not a walk',
      entries.includes('node_modules'),
      entries.join(', '),
    );
    check('an ignored file lands', readFileSync(join(worktree, '.env'), 'utf8') === 'SECRET=1');
    check(
      'the directory lands with its contents',
      existsSync(join(worktree, 'node_modules', 'pkg', 'index.js')),
    );
    check('a symlink survives as a symlink', existsSync(join(worktree, 'node_modules', 'link')));
    check(
      'a file already in the worktree is never overwritten',
      readFileSync(join(worktree, 'shared.txt'), 'utf8') === 'worktree version',
    );
    check(
      "the worktree's .git file is untouched",
      readFileSync(join(worktree, '.git'), 'utf8').startsWith('gitdir:'),
    );
    check('an empty ignored directory is not minted', !existsSync(join(worktree, 'empty-ignored')));

    console.log('\nA repo with nothing ignored');
    const clean = mkdtempSync(join(tmpdir(), 'session-rail-clean-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: clean, stdio: 'pipe' });
      const empty = await copyIgnoredFiles(clean, worktree);
      check('reports nothing rather than failing', empty.outcome === 'nothing', empty.outcome);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }

    console.log('\nA directory that is not a repo');
    const outside = await copyIgnoredFiles(root, join(root, 'nowhere'));
    check('git refusal is reported, not thrown', outside.outcome === 'failed', outside.outcome);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log(
    `\n${failures === 0 ? 'worktree-check: all checks passed' : `worktree-check: ${failures} FAILED`}`,
  );
  if (failures > 0) {
    process.exitCode = 1;
  }
}

void main();
