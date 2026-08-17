/**
 * Maps a Claude Code session's OS pid to the vscode.Terminal hosting it.
 *
 * `vscode.Terminal.processId` resolves to the *shell* pid, while the `claude`
 * process is typically a child (sometimes grandchild) of that shell. We walk
 * the ancestor chain of the claude pid with `ps` and match it against every
 * open terminal's shell pid, preferring the closest ancestor.
 */

import { execFile } from 'child_process';

import * as vscode from 'vscode';

import { safelyAsync } from '../util/log';

const MAX_ANCESTRY_DEPTH = 8;
const PS_TIMEOUT_MS = 1000;
const CACHE_TTL_MS = 10_000;

interface CachedChain {
  chain: readonly number[];
  fetchedAt: number;
}

const ancestryCache = new Map<number, CachedChain>();

/** Clear the cached ancestor chains. Exposed for tests and manual refresh. */
export function clearAncestryCache(): void {
  ancestryCache.clear();
}

/**
 * Read the parent pid of `pid` via `ps -o ppid= -p <pid>`. POSIX-only — never
 * called on win32. Resolves to undefined on any failure (pid gone, ps missing,
 * timeout, unparsable output).
 */
async function readParentPid(pid: number): Promise<number | undefined> {
  return safelyAsync<number | undefined>(
    `readParentPid(${pid})`,
    () =>
      new Promise<number | undefined>((resolve) => {
        const child = execFile(
          'ps',
          ['-o', 'ppid=', '-p', String(pid)],
          { timeout: PS_TIMEOUT_MS },
          (error, stdout) => {
            if (error) {
              resolve(undefined);
              return;
            }
            const parsed = Number.parseInt(stdout.trim(), 10);
            resolve(Number.isFinite(parsed) ? parsed : undefined);
          },
        );
        child.on('error', () => resolve(undefined));
      }),
    undefined,
  );
}

/**
 * Build the ancestor chain of `pid`: [pid, parent, grandparent, ...], walking
 * up at most MAX_ANCESTRY_DEPTH levels or until a pid <= 1 is reached. Results
 * are cached per starting pid for CACHE_TTL_MS.
 */
async function ancestryChain(pid: number): Promise<readonly number[]> {
  if (process.platform === 'win32') {
    // `ps` doesn't exist on Windows, so the chain is just the pid itself —
    // findTerminalForPid will only match a terminal whose *shell* pid happens
    // to equal the claude pid exactly, which is rare. In practice this means
    // the lookup degrades to "no match" on Windows, and callers (e.g.
    // focusSession) already treat a miss as a graceful no-op.
    return [pid];
  }

  const cached = ancestryCache.get(pid);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.chain;
  }

  const chain: number[] = [pid];
  let current = pid;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
    if (current <= 1) {
      break;
    }
    const parent = await readParentPid(current);
    if (parent === undefined || parent <= 1 || chain.includes(parent)) {
      // Reached the top, lost the trail, or looped back onto an already-seen
      // pid — stop without recording a duplicate or invalid entry.
      break;
    }
    chain.push(parent);
    current = parent;
  }

  ancestryCache.set(pid, { chain, fetchedAt: Date.now() });
  return chain;
}

/**
 * Find the vscode.Terminal hosting the given claude process pid, by matching
 * the terminal's shell pid against the claude pid's ancestor chain. When
 * multiple terminals match, the one whose pid is the *closest* ancestor
 * (earliest in the chain) wins.
 */
export async function findTerminalForPid(claudePid: number): Promise<vscode.Terminal | undefined> {
  const chain = await ancestryChain(claudePid);

  const terminals = vscode.window.terminals;
  const withPids = await Promise.all(
    terminals.map(async (terminal) => {
      const pid = await safelyAsync<number | undefined>(
        'terminal.processId',
        async () => terminal.processId,
        undefined,
      );
      return { terminal, pid };
    }),
  );

  let best: { terminal: vscode.Terminal; rank: number } | undefined;
  for (const { terminal, pid } of withPids) {
    if (pid === undefined) {
      continue;
    }
    const rank = chain.indexOf(pid);
    if (rank === -1) {
      continue;
    }
    if (best === undefined || rank < best.rank) {
      best = { terminal, rank };
    }
  }

  return best?.terminal;
}
