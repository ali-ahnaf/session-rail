/**
 * Session Rail — activation and command wiring.
 *
 * This is the only file that knows about every layer. It owns lifecycle
 * (create, start, dispose) and translates VS Code commands into calls on the
 * registry, the terminal linker, and the transcript reader. All logic lives in
 * those modules; this file stays a switchboard.
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';

import * as vscode from 'vscode';

import type { AgentNode, ProjectNode, RailNode, SessionNode } from './model/types';
import { clearHistoryCache } from './scan/history';
import { clearProjectDirCache, setClaudeHome } from './scan/paths';
import { createRegistry, type RailRegistry } from './scan/registry';
import { RailStatusBar } from './status/statusBar';
import { clearAncestryCache } from './terminal/link';
import {
  clearOpenedTerminals,
  forgetTerminal,
  openSession,
  startSession,
  startTerminal,
} from './terminal/resume';
import { TranscriptPanel } from './transcript/panel';
import { PinStore } from './tree/pins';
import { RailProgress } from './tree/progress';
import { RailTreeProvider } from './tree/provider';
import { disposeSearch, promptSearch } from './tree/search';
import { log } from './util/log';
import { showInExplorer } from './workspace/explorer';
import { createScratchpad } from './workspace/scratchpad';
import { showTabSearch } from './workspace/tabs';
import {
  copyIgnoredFiles,
  createWorktree,
  gitRootOf,
  listLocalBranches,
  removeWorktree,
  validateWorktreeName,
  worktreeFolderName,
  worktreeParentFor,
} from './workspace/worktree';

const CONFIG_SECTION = 'sessionRail';

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Session Rail', { log: true });
  log.init(channel);
  context.subscriptions.push(channel);

  applyClaudeHome();
  syncExitedContext();

  const registry = createRegistry();
  // Pins outlive the window, so they hang off the extension's own globalState —
  // the only state this extension keeps. See tree/pins.ts for why not a setting.
  const pins = new PinStore(context.globalState);
  const provider = new RailTreeProvider(registry, pins);
  const statusBar = new RailStatusBar(registry);
  const progress = new RailProgress(registry);

  const view = vscode.window.createTreeView<RailNode>('sessionRail.tree', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    // Before `provider`: closing the box can revert the filter, which fires the
    // provider's change emitter.
    new vscode.Disposable(() => disposeSearch()),
    registry,
    provider,
    pins,
    statusBar,
    progress,
    view,
    ...registerCommands(context, registry, provider, pins),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${CONFIG_SECTION}.claudeHome`)) {
        applyClaudeHome();
        void registry.refresh();
      }
      if (event.affectsConfiguration(`${CONFIG_SECTION}.showExited`)) {
        syncExitedContext();
      }
    }),
    // Terminals come and go; drop the cached pid ancestry so a reopened
    // terminal is matched instead of a stale one.
    vscode.window.onDidOpenTerminal(() => clearAncestryCache()),
    vscode.window.onDidCloseTerminal((terminal) => {
      clearAncestryCache();
      forgetTerminal(terminal);
    }),
    new vscode.Disposable(() => TranscriptPanel.disposeAll()),
  );

  registry.start();
  log.info('Session Rail activated');
}

export function deactivate(): void {
  TranscriptPanel.disposeAll();
}

// ─────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────

function registerCommands(
  context: vscode.ExtensionContext,
  registry: RailRegistry,
  provider: RailTreeProvider,
  pins: PinStore,
): vscode.Disposable[] {
  const register = (id: string, handler: (...args: unknown[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, handler);

  return [
    register('sessionRail.refresh', async () => {
      clearProjectDirCache();
      clearHistoryCache();
      clearAncestryCache();
      clearOpenedTerminals();
      await registry.refresh();
    }),

    register('sessionRail.focusTerminal', async (node) => {
      const session = asSession(node);
      if (!session) {
        return;
      }
      // Focuses the hosting terminal when there is one, otherwise opens a new
      // terminal that resumes the session — adopting or forking it if it is
      // live elsewhere. Two outcomes need explaining: an id we refused to hand
      // to a shell, and an adopt that had to fall back to a fork.
      const outcome = await openSession(session);
      if (outcome === 'refused') {
        void vscode.window.showWarningMessage(
          `Cannot resume ${session.name}: its session id has an unexpected shape. See the Session Rail log.`,
        );
      } else if (outcome === 'fork-fallback') {
        void vscode.window.showWarningMessage(
          `Could not stop the running ${session.name}, so it was forked instead — this terminal ` +
            'continues the conversation under a new session id. See the Session Rail log.',
        );
      } else if (outcome === 'adopted') {
        // The old pid is gone and the new one has not registered yet; refresh
        // once the transition has had a moment rather than waiting a poll.
        setTimeout(() => void registry.refresh(), 400);
      }
    }),

    register('sessionRail.newSession', (node) => {
      const project = asProject(node);
      if (!project) {
        return;
      }
      // A new session takes a moment to register itself under ~/.claude, so
      // the row appears on a later poll rather than immediately.
      if (startSession(project.dir, project.name) === 'missing-dir') {
        void vscode.window.showWarningMessage(
          `Cannot start a session in ${project.dir}: the folder no longer exists.`,
        );
      }
    }),

    register('sessionRail.newWorktreeSession', async (node) => {
      const project = asProject(node);
      if (!project) {
        return;
      }
      // globalStorage is where VS Code lets this extension write; the worktree
      // module takes it as an argument so it never has to import `vscode`.
      await newWorktreeSession(project.dir, context.globalStorageUri.fsPath);
    }),

    register('sessionRail.removeWorktree', async (node) => {
      const project = asProject(node);
      if (!project) {
        return;
      }
      await removeWorktreeCommand(project, registry);
    }),

    // The view-title `+`. Takes no node, so it asks two questions the row `+`
    // already knows the answers to: *what* to open, and *where*. The what is a
    // three-way pick because the header is where work that belongs to no
    // session row starts; the where is `resolveHeaderTarget`, shared by all
    // three so a scratchpad and a session can never disagree about the folder.
    register('sessionRail.newSessionHome', async () => {
      const kind = await pickHeaderAction();
      if (!kind) {
        return;
      }

      const target = await resolveHeaderTarget(kind);
      if (!target) {
        return;
      }
      const { dir, label } = target;

      // A virtual-filesystem root has no usable local path; every branch's
      // existence check turns that into the same warning as a deleted folder.
      if (kind === 'session') {
        if (startSession(dir, label) === 'missing-dir') {
          void vscode.window.showWarningMessage(
            `Cannot start a session in ${dir}: the folder does not exist.`,
          );
        }
        return;
      }

      if (kind === 'terminal') {
        if (startTerminal(dir, label) === 'missing-dir') {
          void vscode.window.showWarningMessage(
            `Cannot open a terminal in ${dir}: the folder does not exist.`,
          );
        }
        return;
      }

      const outcome = await createScratchpad(dir);
      if (outcome === 'missing-dir') {
        void vscode.window.showWarningMessage(
          `Cannot create a scratchpad in ${dir}: the folder does not exist.`,
        );
      } else if (outcome === 'failed') {
        void vscode.window.showWarningMessage(
          `Could not create a scratchpad in ${dir}. See the Session Rail log.`,
        );
      }
    }),

    register('sessionRail.openTranscript', (node) => {
      const target = asSession(node) ?? asAgent(node);
      if (!target) {
        return;
      }
      if (!target.transcriptPath) {
        void vscode.window.showInformationMessage(
          `No transcript on disk yet for ${describe(target)}.`,
        );
        return;
      }
      TranscriptPanel.show(context, target);
    }),

    register('sessionRail.revealFolder', async (node) => {
      const dir = asProject(node)?.dir ?? asSession(node)?.cwd;
      if (!dir) {
        return;
      }
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
    }),

    register('sessionRail.showInExplorer', async (node) => {
      const project = asProject(node);
      const session = asSession(node);
      const dir = project?.dir ?? session?.cwd;
      if (!dir) {
        return;
      }

      const outcome = await showInExplorer(dir);
      if (outcome === 'missing-dir') {
        void vscode.window.showErrorMessage(`${dir} no longer exists.`);
      } else if (outcome === 'failed') {
        void vscode.window.showErrorMessage(
          `Could not add ${dir} to this workspace. See the Session Rail log.`,
        );
      }
    }),

    register('sessionRail.copySessionId', async (node) => {
      const session = asSession(node);
      if (!session) {
        return;
      }
      await vscode.env.clipboard.writeText(session.sessionId);
      void vscode.window.showInformationMessage('Session ID copied.');
    }),

    register('sessionRail.stopSession', async (node) => {
      const session = asSession(node);
      if (!session) {
        return;
      }
      await stopSession(session, registry);
    }),

    register('sessionRail.toggleTasks', async () => {
      const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
      const next = !config.get<boolean>('showTasks', true);
      await config.update('showTasks', next, vscode.ConfigurationTarget.Global);
      await registry.refresh();
    }),

    // Two commands rather than one toggle, so the view-title icon can show the
    // current state. Only one is ever visible — see the `sessionRail.exitedVisible`
    // context key.
    register('sessionRail.showExited', () => setShowExited(true, registry)),
    register('sessionRail.hideExited', () => setShowExited(false, registry)),

    // Both the search row and the view-title icon land here. The filter is
    // provider state, so this needs no registry refresh — the next poll
    // re-filters the fresh snapshot on its own.
    // Pins are pure UI state: the store fires its own change event and the
    // provider re-renders the snapshot it already holds, so neither command
    // needs a registry refresh.
    register('sessionRail.pinProject', async (node) => {
      const project = asProject(node);
      if (!project) {
        return;
      }
      await pins.pin(project.dir);
    }),

    register('sessionRail.unpinProject', async (node) => {
      const project = asProject(node);
      if (!project) {
        return;
      }
      await pins.unpin(project.dir);
    }),

    register('sessionRail.searchSessions', () => promptSearch(provider)),

    // Not a tree filter: the rail shows sessions, this searches the window's
    // own tabs. It needs the registry only to tell a Claude session's terminal
    // apart from any other terminal.
    register('sessionRail.searchTabs', () => showTabSearch(registry)),
    register('sessionRail.clearSearch', () => provider.setFilter('')),

    register('sessionRail.showLog', () => log.show()),
  ];
}

/**
 * Terminating someone's agent mid-run loses in-flight work, so this always
 * confirms — modal, and never pre-selected.
 */
async function stopSession(session: SessionNode, registry: RailRegistry): Promise<void> {
  // `pid: 0` marks a transcript-history row with no process behind it. The menu
  // never offers Stop on one, but `process.kill(0, …)` signals the whole process
  // group, so this refuses rather than trusts the menu.
  if (session.pid <= 0) {
    log.warn(`Refusing to stop ${session.name}: no live process is recorded for it`);
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Stop ${session.name}?`,
    {
      modal: true,
      detail:
        'The session is sent SIGTERM. Work it has not written to disk is lost. ' +
        'Its transcript is kept.',
    },
    'Stop session',
  );
  if (confirm !== 'Stop session') {
    return;
  }

  try {
    process.kill(session.pid, 'SIGTERM');
    log.info(`Sent SIGTERM to ${session.name} (pid ${session.pid})`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      void vscode.window.showInformationMessage(`${session.name} had already exited.`);
    } else if (code === 'EPERM') {
      void vscode.window.showErrorMessage(
        `Not permitted to stop ${session.name} (pid ${session.pid}). It belongs to another user.`,
      );
    } else {
      log.error(`Failed to stop ${session.name}`, error);
      void vscode.window.showErrorMessage(`Could not stop ${session.name}. See the Session Rail log.`);
    }
  }

  // The process needs a moment to die before the liveness probe reflects it.
  setTimeout(() => void registry.refresh(), 400);
}

// ─────────────────────────────────────────────────────────────
// Worktrees
// ─────────────────────────────────────────────────────────────

/**
 * Ask for a branch name, create the worktree, start `claude` in it. Driven only
 * from the project row's `$(git-branch)` icon — the row is the repo. `dir` may
 * be anywhere inside that repo: the worktree is made of the containing repo,
 * which is what a subdirectory-grouped row means by "this project". `base` is
 * the extension's globalStorage path, the root every worktree lands under.
 */
/**
 * The new-worktree prompt: every local branch of the repo, searchable, plus
 * whatever the user types as a new branch.
 *
 * A QuickPick rather than an InputBox because both readings of "which branch"
 * are ordinary — check out one that exists, or start one that does not — and a
 * plain input box only supported the second while silently accepting a typo of
 * the first. `createWorktree` already handles both (it retries `-b <name>` as a
 * plain checkout when the branch exists), so the pick only has to decide the
 * string.
 *
 * A QuickPick has no `validateInput`, so the reasons a choice cannot be used
 * ride on the items instead: an unusable row is listed with its reason in
 * `detail` and flagged `unusable`, and accepting it is a no-op that leaves the
 * pick open. Listing them beats hiding them — a branch missing from the list
 * reads as "this repo does not have it".
 */
interface BranchItem extends vscode.QuickPickItem {
  /** The branch name to create the worktree on. Absent on unusable rows. */
  branch?: string;
  /** True when the row explains why it cannot be picked. */
  unusable?: boolean;
}

async function pickWorktreeBranch(root: string, parent: string): Promise<string | undefined> {
  const pick = vscode.window.createQuickPick<BranchItem>();
  pick.title = `New worktree of ${basename(root)}`;
  pick.placeholder = `Pick a branch, or type a new one — created under ${parent}`;
  pick.matchOnDescription = true;
  pick.busy = true;

  try {
    const branches = await listLocalBranches(root);
    const names = new Set(branches.map((branch) => branch.name));
    const existing: BranchItem[] = branches.map((branch) => {
      // A branch git already has checked out somewhere cannot get a second
      // worktree; say where, since that is the next thing the user needs.
      if (branch.checkedOutIn !== undefined) {
        return {
          label: branch.name,
          description: branch.current ? 'current branch' : 'checked out',
          detail: `Already checked out in ${branch.checkedOutIn}.`,
          unusable: true,
        };
      }
      return { label: branch.name, branch: branch.name };
    });

    // The typed value becomes a "create" row unless a branch already owns that
    // exact name — then the branch row is the honest answer.
    const createItem = (value: string): BranchItem[] => {
      const trimmed = value.trim();
      if (trimmed.length === 0 || names.has(trimmed)) {
        return [];
      }
      const invalid = validateWorktreeName(trimmed);
      if (invalid !== undefined) {
        return [{ label: `$(plus) ${trimmed}`, detail: invalid, alwaysShow: true, unusable: true }];
      }
      // The branch keeps its slashes; the folder does not, so the existence
      // check has to be made against the path that will actually be created.
      const target = join(parent, worktreeFolderName(trimmed));
      if (existsSync(target)) {
        return [
          {
            label: `$(plus) ${trimmed}`,
            detail: `${target} already exists.`,
            alwaysShow: true,
            unusable: true,
          },
        ];
      }
      return [
        {
          label: `$(plus) ${trimmed}`,
          description: 'create new branch',
          branch: trimmed,
          alwaysShow: true,
        },
      ];
    };

    pick.items = existing;
    pick.busy = false;

    return await new Promise<string | undefined>((resolve) => {
      pick.onDidChangeValue((value) => {
        pick.items = [...createItem(value), ...existing];
      });
      pick.onDidAccept(() => {
        const selected = pick.selectedItems[0];
        if (selected === undefined || selected.unusable === true) {
          // Nothing usable chosen — leave the pick open with its reason shown.
          return;
        }
        resolve(selected.branch);
        pick.hide();
      });
      pick.onDidHide(() => resolve(undefined));
      pick.show();
    });
  } finally {
    pick.dispose();
  }
}

async function newWorktreeSession(dir: string, base: string): Promise<void> {
  const root = gitRootOf(dir);
  if (root === undefined) {
    void vscode.window.showWarningMessage(
      `Cannot create a worktree: ${dir} is not inside a git repository.`,
    );
    return;
  }

  const parent = worktreeParentFor(root, base);
  const name = await pickWorktreeBranch(root, parent);
  if (name === undefined) {
    // Escape starts nothing.
    return;
  }

  const result = await createWorktree(root, name, base);
  switch (result.outcome) {
    case 'created':
      if (result.dir === undefined) {
        return;
      }
      // Before the session, not after: a worktree checks out tracked content
      // only, so whatever `.gitignore` hides — `.env`, `node_modules/`, local
      // config — is missing until this runs, and an agent that starts first
      // fails its first command for a reason that has nothing to do with the
      // work. Best-effort like the folder add; a copy that fails still leaves
      // a usable worktree.
      await seedIgnoredFiles(root, result.dir);
      if (startSession(result.dir, name) === 'missing-dir') {
        void vscode.window.showWarningMessage(
          `Created the worktree but ${result.dir} is not readable. See the Session Rail log.`,
        );
        return;
      }
      // The session is started FIRST and the folder added second, deliberately.
      // A single-folder window becoming multi-root restarts every extension
      // host (see workspace/explorer.ts), so nothing after the add is
      // guaranteed to run — whereas the terminal is already live in the pty
      // host by then and survives the restart. Adding is best-effort: a
      // refused or cancelled add still leaves a working session, so it only
      // logs.
      await addWorktreeFolder(result.dir);
      return;
    case 'exists':
      void vscode.window.showWarningMessage(`${result.dir ?? name} already exists.`);
      return;
    case 'missing-dir':
      void vscode.window.showWarningMessage(`${root} no longer exists.`);
      return;
    case 'not-a-repo':
      void vscode.window.showWarningMessage(`${root} is not a git repository.`);
      return;
    case 'bad-name':
      void vscode.window.showWarningMessage(result.detail ?? 'That name cannot be used.');
      return;
    case 'failed':
      void vscode.window.showWarningMessage(
        `git could not create the worktree${result.detail ? `: ${result.detail}` : ''}. ` +
          'See the Session Rail log.',
      );
      return;
  }
}

/**
 * Seed a fresh worktree with the ignored files of the repo it came from,
 * unless `sessionRail.copyIgnoredToWorktree` says not to.
 *
 * The copy is shown as a notification with the current entry, because
 * `node_modules/` is one entry and can take a while — a silent pause between
 * picking a branch and the terminal opening reads as a hang. It is not
 * cancellable: half of one collapsed directory is a worse state than either
 * end, and the whole pass is skippable from settings.
 */
async function seedIgnoredFiles(root: string, worktree: string): Promise<void> {
  if (!copyIgnoredEnabled()) {
    return;
  }

  const outcome = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Copying ignored files into ${basename(worktree)}`,
    },
    (progress) =>
      copyIgnoredFiles(root, worktree, (entry) => {
        progress.report({ message: entry });
      }),
  );

  if (outcome.outcome === 'failed') {
    void vscode.window.showWarningMessage(
      `Created the worktree but could not list the ignored files of ${basename(root)}` +
        `${outcome.detail ? `: ${outcome.detail}` : ''}.`,
    );
    return;
  }
  if (outcome.failed > 0) {
    void vscode.window.showWarningMessage(
      `Copied ${outcome.copied} ignored ${outcome.copied === 1 ? 'entry' : 'entries'} into the ` +
        `worktree; ${outcome.failed} could not be copied. See the Session Rail log.`,
    );
  }
}

/**
 * Put a freshly created worktree on screen: append it as a workspace root so
 * its files are editable in the same window the session runs in.
 *
 * Reuses `showInExplorer` rather than calling `updateWorkspaceFolders` here,
 * so the worktree lands under exactly the rules that command already
 * establishes — add-only, appended past index 0, revealed when the directory
 * is already reachable from a root (a worktree of a repo that is itself a
 * root is not, so this is normally a real add).
 *
 * Everything here is best-effort. The worktree exists and the session is
 * already running by the time this is called, so a refused or cancelled add is
 * logged rather than raised: an error popup over a working session would read
 * as the worktree having failed.
 */
async function addWorktreeFolder(dir: string): Promise<void> {
  const outcome = await showInExplorer(dir);
  if (outcome !== 'revealed' && outcome !== 'added') {
    log.warn(`Did not add the worktree ${dir} to this workspace: ${outcome}`);
  }
}

/**
 * Deleting a directory of work always confirms — modal, never pre-selected —
 * and a live session blocks it outright: yanking the folder out from under a
 * running `claude` is the filesystem version of two processes on one
 * transcript. A dirty worktree gets a second, scarier confirm before --force.
 */
async function removeWorktreeCommand(project: ProjectNode, registry: RailRegistry): Promise<void> {
  if (project.liveCount > 0) {
    void vscode.window.showWarningMessage(
      `${project.name} has ${project.liveCount === 1 ? 'a running session' : 'running sessions'} — ` +
        'stop them before removing the worktree.',
    );
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Remove worktree ${project.name}?`,
    {
      modal: true,
      detail:
        `Deletes ${project.dir} and unregisters it from the repository. ` +
        'The branch and any session transcripts are kept.',
    },
    'Remove worktree',
  );
  if (confirm !== 'Remove worktree') {
    return;
  }

  let result = await removeWorktree(project.dir);
  if (result.outcome === 'dirty') {
    const force = await vscode.window.showWarningMessage(
      `${project.name} has uncommitted changes`,
      {
        modal: true,
        detail:
          'Removing it anyway discards its modified and untracked files. ' +
          'The branch is kept.',
      },
      'Discard and remove',
    );
    if (force !== 'Discard and remove') {
      return;
    }
    result = await removeWorktree(project.dir, { force: true });
  }

  if (result.outcome === 'removed') {
    await registry.refresh();
  } else if (result.outcome === 'not-a-worktree') {
    void vscode.window.showWarningMessage(`${project.dir} is not a linked git worktree.`);
  } else {
    void vscode.window.showWarningMessage(
      `git could not remove the worktree${result.detail ? `: ${result.detail}` : ''}. ` +
        'See the Session Rail log.',
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Node narrowing
//
// Command arguments arrive as `unknown` — they come from tree selection, the
// command palette, or a keybinding, and only the tree supplies a real node.
// ─────────────────────────────────────────────────────────────

/**
 * What the view-title `+` can start.
 *
 * Worktrees are deliberately not here: a worktree is always *of* a repo, and
 * the header `+` acts on the window's folder, which need not be one. It lives
 * on the project row instead, where the repo is the row.
 */
type HeaderAction = 'session' | 'scratchpad' | 'terminal';

/**
 * Ask what the `+` should open. Escape returns undefined and starts nothing.
 *
 * Order is deliberate: the session is what the button did before this pick
 * existed, so it stays first and stays the default landing item.
 */
async function pickHeaderAction(): Promise<HeaderAction | undefined> {
  // `action`, not `kind`: `QuickPickItem.kind` is VS Code's own
  // separator enum, and intersecting the two collapses the type to `never`.
  const items: (vscode.QuickPickItem & { action: HeaderAction })[] = [
    {
      action: 'session',
      label: '$(comment-discussion) Claude Session',
      detail: 'Run `claude` in a new terminal',
    },
    {
      action: 'scratchpad',
      label: '$(note) Scratchpad',
      detail: 'Create a new Markdown file and open it in a tab',
    },
    {
      action: 'terminal',
      label: '$(terminal) Terminal',
      detail: 'Open a plain shell terminal',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'What would you like to start?',
  });
  return picked?.action;
}

/**
 * The directory the header `+` acts in: the folder this window is open at,
 * which is what anything started from the header almost always means.
 * Multi-root windows are ambiguous, so ask; a window with no folder open falls
 * back to the home directory, the one place that is always there and belongs
 * to no project in the tree. Escape from the pick returns undefined.
 */
async function resolveHeaderTarget(
  kind: HeaderAction,
): Promise<{ dir: string; label: string } | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];

  if (folders.length === 0) {
    const home = homedir();
    return { dir: home, label: basename(home) || 'home' };
  }
  if (folders.length === 1) {
    // One folder is unambiguous, so it must never prompt — hence the explicit
    // branch rather than leaving it to the pick.
    return { dir: folders[0].uri.fsPath, label: folders[0].name };
  }

  const picked = await vscode.window.showWorkspaceFolderPick({
    placeHolder: PLACEHOLDERS[kind],
  });
  return picked ? { dir: picked.uri.fsPath, label: picked.name } : undefined;
}

const PLACEHOLDERS: Record<HeaderAction, string> = {
  session: 'Start a Claude session in…',
  scratchpad: 'Create a scratchpad in…',
  terminal: 'Open a terminal in…',
};

function isRailNode(value: unknown): value is RailNode {
  return typeof value === 'object' && value !== null && 'kind' in value;
}

function asSession(value: unknown): SessionNode | undefined {
  return isRailNode(value) && value.kind === 'session' ? value : undefined;
}

function asAgent(value: unknown): AgentNode | undefined {
  return isRailNode(value) && value.kind === 'agent' ? value : undefined;
}

function asProject(value: unknown): ProjectNode | undefined {
  return isRailNode(value) && value.kind === 'project' ? value : undefined;
}

function describe(node: SessionNode | AgentNode): string {
  return node.kind === 'session' ? node.name : node.agentType;
}

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

/**
 * Writes the setting, then lets the config listener flip the context key — so
 * the icon tracks the setting whether it was changed from the title bar or from
 * the Settings UI.
 */
async function setShowExited(value: boolean, registry: RailRegistry): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update('showExited', value, vscode.ConfigurationTarget.Global);
  await registry.refresh();
}

function syncExitedContext(): void {
  const showing =
    vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('showExited', false) === true;
  void vscode.commands.executeCommand('setContext', 'sessionRail.exitedVisible', showing);
}

function copyIgnoredEnabled(): boolean {
  return (
    vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<boolean>('copyIgnoredToWorktree', true) === true
  );
}

function applyClaudeHome(): void {
  const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('claudeHome', '').trim();
  setClaudeHome(raw.length > 0 ? raw : undefined);
  clearProjectDirCache();
}
