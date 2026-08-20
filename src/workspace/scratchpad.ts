/**
 * Scratchpad — a throwaway Markdown file next to the work.
 *
 * The one place this extension creates a file the user did not already have.
 * It is deliberately narrow: a new, uniquely named `.md` in a directory the
 * user picked, opened in a tab. Nothing is ever overwritten (`wx`), nothing is
 * deleted, and nothing under `~/.claude` is touched — the read-only invariant
 * still holds for Claude Code's own state.
 */

import { existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';

import * as vscode from 'vscode';

import { log } from '../util/log';

export type ScratchpadOutcome = 'created' | 'missing-dir' | 'failed';

/** How many `-2`, `-3`… suffixes to try before giving up on a name. */
const MAX_ATTEMPTS = 20;

/**
 * Create a scratchpad in `dir` and open it in a new tab.
 *
 * A missing directory is refused rather than swapped for the window default,
 * for the same reason `startSession` refuses one: the directory *is* the
 * request, so a silent fallback writes the file into the wrong repo.
 */
export async function createScratchpad(dir: string): Promise<ScratchpadOutcome> {
  if (!existsSync(dir)) {
    log.warn(`Cannot create a scratchpad in ${dir}: the directory no longer exists`);
    return 'missing-dir';
  }

  const stamp = timestamp(new Date());
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const name = attempt === 1 ? `scratchpad-${stamp}.md` : `scratchpad-${stamp}-${attempt}.md`;
    const target = join(dir, name);
    try {
      // `wx` is the whole safety story: an existing file makes this throw
      // EEXIST instead of truncating something the user cares about.
      await writeFile(target, seed(name), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }
      log.warn(`Could not create ${target}: ${describe(error)}`);
      return 'failed';
    }

    log.info(`Created scratchpad ${target}`);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (error) {
      // The file exists, which is the part that matters; report the open
      // failure but do not pretend nothing happened.
      log.warn(`Created ${target} but could not open it: ${describe(error)}`);
    }
    return 'created';
  }

  log.warn(`Could not find a free scratchpad name in ${dir} after ${MAX_ATTEMPTS} attempts`);
  return 'failed';
}

/** `2026-08-20-1432-07` — sortable, and unique enough that EEXIST is rare. */
function timestamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  );
}

function seed(name: string): string {
  return `# ${name.replace(/\.md$/, '')}\n\n`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
