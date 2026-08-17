/**
 * Session Rail — activation and command wiring.
 *
 * This is the only file that knows about every layer. It owns lifecycle
 * (create, start, dispose) and translates VS Code commands into calls on the
 * registry, the terminal linker, and the transcript reader. All logic lives in
 * those modules; this file stays a switchboard.
 */

import { homedir } from 'os';
import { basename } from 'path';

import * as vscode from 'vscode';

import type { AgentNode, ProjectNode, RailNode, SessionNode } from './model/types';
import { clearHistoryCache } from './scan/history';
import { clearProjectDirCache, setClaudeHome } from './scan/paths';
import { createRegistry, type RailRegistry } from './scan/registry';
import { RailStatusBar } from './status/statusBar';
import { clearAncestryCache } from './terminal/link';
import { clearOpenedTerminals, forgetTerminal, openSession, startSession } from './terminal/resume';
import { TranscriptPanel } from './transcript/panel';
import { RailTreeProvider } from './tree/provider';
import { disposeSearch, promptSearch } from './tree/search';
import { log } from './util/log';
import { showInExplorer } from './workspace/explorer';

const CONFIG_SECTION = 'sessionRail';

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Session Rail', { log: true });
  log.init(channel);
  context.subscriptions.push(channel);

  applyClaudeHome();
  syncExitedContext();

  const registry = createRegistry();
  const provider = new RailTreeProvider(registry);
  const statusBar = new RailStatusBar(registry);

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
    statusBar,
    view,
    ...registerCommands(context, registry, provider),
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

    // The view-title `+`. Takes no node, so it needs a directory of its own:
    // the home directory, the one place that is always there and belongs to no
    // project in the tree.
    register('sessionRail.newSessionHome', () => {
      const home = homedir();
      if (startSession(home, basename(home) || 'home') === 'missing-dir') {
        void vscode.window.showWarningMessage(
          `Cannot start a session in ${home}: the folder does not exist.`,
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
    register('sessionRail.searchSessions', () => promptSearch(provider)),
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
// Node narrowing
//
// Command arguments arrive as `unknown` — they come from tree selection, the
// command palette, or a keybinding, and only the tree supplies a real node.
// ─────────────────────────────────────────────────────────────

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

function applyClaudeHome(): void {
  const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('claudeHome', '').trim();
  setClaudeHome(raw.length > 0 ? raw : undefined);
  clearProjectDirCache();
}
