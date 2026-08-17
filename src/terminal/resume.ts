/**
 * Opens a session: focus the terminal already hosting it, or start a fresh
 * terminal that resumes it with `claude --resume <sessionId>`. Also starts a
 * brand new session in a project directory (`startSession`).
 *
 * Why a shell terminal plus `sendText` rather than
 * `createTerminal({ shellPath: 'claude' })`: the extension host's PATH is not
 * the login shell's, so an nvm/volta/homebrew `claude` may be invisible to us
 * while being perfectly resolvable inside the terminal. Running it as a shell
 * command also makes `claude` a child of the terminal's shell, which is exactly
 * what `findTerminalForPid` walks — so once the resumed process registers
 * itself, its own tree node focuses this terminal without help from the map
 * below.
 *
 * A live session that we could not find a terminal for is running somewhere we
 * can't see (another window, a detached shell), and two processes on one
 * transcript corrupt it. There are two ways out and the user picks between them
 * (`sessionRail.openLiveSession`):
 *
 *  - adopt — SIGTERM the old process, wait for it to actually be gone, then
 *    plain `--resume`. Same session id, so the session moves into this window
 *    rather than being duplicated. The old process's in-flight work is lost.
 *  - fork — leave it running and continue the conversation under a NEW session
 *    id, which shows up as a second row.
 *
 * Adopt only ever sends a plain `--resume` after the pid is *confirmed* gone.
 * If the process will not die, or is not ours to signal, it falls back to a
 * fork — the one-process-per-transcript rule is kept by construction, never by
 * timing.
 */

import { existsSync } from 'fs';

import * as vscode from 'vscode';

import type { SessionNode } from '../model/types';
import { log } from '../util/log';
import { findTerminalForPid } from './link';

const CONFIG_SECTION = 'sessionRail';

/**
 * Session ids are UUIDs, but this reads unversioned state — anything that is
 * not a bare shell token is refused rather than quoted, so nothing that arrives
 * from disk can ever be interpreted by the shell.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Terminals this extension opened, keyed by the session id that was clicked.
 * Without it a second click spawns a second terminal: an exited session has no
 * live pid to walk, and a forked session runs under a new id, so neither can be
 * rediscovered through pid ancestry.
 */
const openedTerminals = new Map<string, vscode.Terminal>();

/** How long to wait for a SIGTERMed session to actually leave the process table. */
const TERMINATE_TIMEOUT_MS = 5000;
const TERMINATE_POLL_MS = 100;

export type OpenOutcome =
  | 'focused'
  | 'reused'
  | 'resumed'
  | 'adopted'
  | 'forked'
  /** Adopt was chosen but the old process outlived it, so it forked instead. */
  | 'fork-fallback'
  | 'refused'
  | 'cancelled';

export type StartOutcome = 'started' | 'missing-dir';

/** What to do with a live session that no terminal in this window hosts. */
type LiveChoice = 'adopt' | 'fork' | 'cancel';

/** Drop a closed terminal from the map. Wired to onDidCloseTerminal. */
export function forgetTerminal(terminal: vscode.Terminal): void {
  for (const [sessionId, candidate] of openedTerminals) {
    if (candidate === terminal) {
      openedTerminals.delete(sessionId);
    }
  }
}

/** Forget every tracked terminal. Exposed for the refresh command and tests. */
export function clearOpenedTerminals(): void {
  openedTerminals.clear();
}

/**
 * Show the session in a terminal, whatever that takes. Never throws and never
 * reports a dead end. Two outcomes need a word from the caller: 'refused' (the
 * session id was not a shape we are willing to hand to a shell) and
 * 'fork-fallback' (adopt was chosen, the old process survived it, so the
 * terminal holds a fork under a new id). 'cancelled' means the user dismissed
 * the prompt and nothing happened.
 */
export async function openSession(session: SessionNode): Promise<OpenOutcome> {
  // A transcript-history row carries `pid: 0` — there is no process to walk up
  // from, and no pid may ever be signalled from one.
  const host = session.pid > 0 ? await findTerminalForPid(session.pid) : undefined;
  if (host) {
    host.show(false);
    return 'focused';
  }

  const existing = openedTerminals.get(session.sessionId);
  if (existing) {
    existing.show(false);
    return 'reused';
  }

  if (!SAFE_SESSION_ID.test(session.sessionId)) {
    log.warn(`Refusing to resume ${session.name}: unexpected session id shape`);
    return 'refused';
  }

  log.info(
    `No terminal in this window hosts ${session.name} ` +
      `(pid ${session.pid}, entrypoint ${session.entrypoint ?? 'unknown'})`,
  );

  let fork = false;
  let fallback = false;

  // `session.alive` comes from a snapshot up to a poll old, so re-check the pid
  // before prompting: a session that exited since the last tick needs no
  // decision at all, and asking to stop a dead process reads as a bug.
  const live = session.alive && session.pid > 0 && pidRunning(session.pid);

  if (live) {
    const choice = await chooseLiveAction(session);
    if (choice === 'cancel') {
      return 'cancelled';
    }
    fork = choice === 'fork';
    if (!fork) {
      // Adopt: the plain `--resume` below is only safe once the old process is
      // gone for certain, so an unconfirmed death downgrades to a fork.
      fallback = !(await terminate(session));
      fork = fallback;
    }
  }

  log.info(
    `${fork ? 'Forking' : 'Resuming'} ${session.name} in a new terminal` +
      `${fallback ? ' — the running process could not be stopped' : ''}`,
  );

  const terminal = createSessionTerminal(session, fork);
  openedTerminals.set(session.sessionId, terminal);
  terminal.show(false);
  terminal.sendText(resumeCommand(session.sessionId, fork), true);

  if (fallback) {
    return 'fork-fallback';
  }
  if (fork) {
    return 'forked';
  }
  return live ? 'adopted' : 'resumed';
}

/**
 * Adopt or fork? The setting decides when it is explicit; otherwise ask, modal
 * and with nothing pre-selected, because adopting kills a process that may be
 * mid-run in a window the user is not looking at.
 */
async function chooseLiveAction(session: SessionNode): Promise<LiveChoice> {
  const setting = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>('openLiveSession', 'ask');
  if (setting === 'adopt' || setting === 'fork') {
    return setting;
  }

  const answer = await vscode.window.showWarningMessage(
    `${session.name} is running in a terminal this window cannot see.`,
    {
      modal: true,
      detail:
        `Move here — stop that process (SIGTERM, pid ${session.pid}) and resume the ` +
        'session in a new terminal here. Same session id, same row; work it has not ' +
        'written to disk is lost.\n\n' +
        'Fork instead — leave it running and continue the conversation under a new ' +
        'session id, which appears as a second row.',
    },
    'Move here',
    'Fork instead',
  );

  if (answer === 'Move here') {
    return 'adopt';
  }
  if (answer === 'Fork instead') {
    return 'fork';
  }
  return 'cancel';
}

/**
 * SIGTERM the session and wait until the pid is genuinely gone. Returns false
 * on anything short of proof — a signal we are not permitted to send, an
 * unexpected errno, or a process still alive after TERMINATE_TIMEOUT_MS — so
 * the caller can fall back to a fork.
 */
async function terminate(session: SessionNode): Promise<boolean> {
  try {
    process.kill(session.pid, 'SIGTERM');
    log.info(`Sent SIGTERM to ${session.name} (pid ${session.pid}) to adopt its session`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      // Exited between the poll that said "alive" and this signal. Nothing to
      // wait for, and the transcript is free.
      return true;
    }
    log.warn(`Cannot stop ${session.name} (pid ${session.pid}): ${code ?? describe(error)}`);
    return false;
  }

  const deadline = Date.now() + TERMINATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(TERMINATE_POLL_MS);
    if (!pidRunning(session.pid)) {
      return true;
    }
  }

  log.warn(
    `${session.name} (pid ${session.pid}) was still running ${TERMINATE_TIMEOUT_MS}ms after SIGTERM`,
  );
  return false;
}

/** EPERM counts as running: the pid exists, it simply is not ours. */
function pidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Start a new session in `dir` — a plain `claude` in a shell terminal rooted
 * there, for the same PATH and process-ancestry reasons as `openSession`.
 *
 * Unlike resume, a missing directory is refused rather than shrugged off: the
 * directory *is* the request here, so falling back to the window's default
 * would silently start a session pointed at the wrong repo. Nothing is tracked
 * in `openedTerminals` — a fresh session has no id yet, and pressing + twice
 * legitimately means two sessions.
 */
export function startSession(dir: string, label: string): StartOutcome {
  if (!existsSync(dir)) {
    log.warn(`Cannot start a session in ${dir}: the directory no longer exists`);
    return 'missing-dir';
  }

  log.info(`Starting a new session in ${dir}`);

  const terminal = vscode.window.createTerminal({
    name: `claude — ${label}`,
    cwd: dir,
    location: terminalLocation(),
    iconPath: new vscode.ThemeIcon('comment-discussion'),
    // Same reasoning as a resumed terminal: a restored shell with no session
    // attached reads as a broken session.
    isTransient: true,
  });
  terminal.show(false);
  terminal.sendText('claude', true);

  return 'started';
}

function createSessionTerminal(session: SessionNode, fork: boolean): vscode.Terminal {
  // A session's cwd can be gone by the time it is reopened; VS Code errors on a
  // missing cwd, so fall back to the window's default.
  const cwd = existsSync(session.cwd) ? session.cwd : undefined;
  if (cwd === undefined) {
    log.warn(`${session.cwd} no longer exists; opening ${session.name} in the default directory`);
  }

  return vscode.window.createTerminal({
    name: fork ? `${session.name} (fork)` : session.name,
    cwd,
    location: terminalLocation(),
    iconPath: new vscode.ThemeIcon('comment-discussion'),
    // Restoring this terminal after a reload would give back a bare shell with
    // no session attached, which reads as a broken session. Better it is gone.
    isTransient: true,
  });
}

function resumeCommand(sessionId: string, fork: boolean): string {
  return `claude --resume ${sessionId}${fork ? ' --fork-session' : ''}`;
}

function terminalLocation(): vscode.TerminalLocation {
  const setting = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>('terminalLocation', 'editor');
  return setting === 'panel' ? vscode.TerminalLocation.Panel : vscode.TerminalLocation.Editor;
}
