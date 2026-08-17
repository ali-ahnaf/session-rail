/**
 * Session Rail — showing a session's directory in the VS Code Explorer.
 *
 * The Explorer can only render workspace roots and what lives under them; there
 * is no API for browsing an arbitrary directory in it. So "show this project in
 * the Explorer" means one of exactly two things:
 *
 *  - the directory is already inside a workspace root → `revealInExplorer`,
 *    which expands and selects it. No side effects at all.
 *  - it is not → append it as an extra root with `updateWorkspaceFolders`.
 *
 * `vscode.openFolder` is the tempting shape and the wrong one: it replaces the
 * window's contents, which is precisely what this command exists to avoid.
 *
 * Appending is deliberately at the END of the folder list. The API contract is
 * that adding, removing, or changing the FIRST folder terminates and restarts
 * every extension so the deprecated `rootPath` can be updated — appending past
 * index 0 sidesteps that.
 *
 * What actually happens on the transition out of a single-folder (or empty)
 * window, read out of `WorkspaceEditingService.doAddFolders` rather than
 * assumed: any state that is not already a multi-root workspace takes the
 * `createAndEnterWorkspace()` branch, which mints an untitled workspace and
 * enters it in place. `doEnterWorkspace` finishes with
 * `remoteAuthority ? hostService.reload() : extensionService.startExtensionHosts()`,
 * so locally the window survives and only the extension hosts restart, while a
 * remote window (SSH/WSL/devcontainer) takes a full window reload. That reload
 * is the one outcome worth a confirmation prompt — everything else is cheap
 * enough to just do.
 *
 * `vscode.workspace.workspaceFile` is the discriminator for "already multi-root"
 * (set for both saved `.code-workspace` and untitled workspaces, unset for a
 * single-folder or empty window) — the same condition as that branch.
 *
 * Add-only, never remove. A stray click must not tear a root out of a workspace
 * the user arranged by hand, so a directory that is already reachable is only
 * revealed. Removing a root stays the Explorer's own job.
 */

import { statSync } from 'fs';
import { homedir } from 'os';
import { dirname, resolve } from 'path';

import * as vscode from 'vscode';

import { log, safelyAsync } from '../util/log';

/** Outcome, for the caller to turn into user-visible messaging. */
export type ExplorerOutcome = 'revealed' | 'added' | 'missing-dir' | 'cancelled' | 'failed';

export async function showInExplorer(dir: string): Promise<ExplorerOutcome> {
  if (!isDirectory(dir)) {
    log.warn(`Cannot show ${dir} in the Explorer: not a directory`);
    return 'missing-dir';
  }

  const uri = vscode.Uri.file(dir);

  // Already reachable from a root — nothing to add, just point at it.
  if (vscode.workspace.getWorkspaceFolder(uri)) {
    await reveal(uri);
    return 'revealed';
  }

  if (!(await confirmIfExpensive(dir))) {
    return 'cancelled';
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  log.info(`Adding ${dir} as workspace folder #${folders.length + 1}`);

  const applied = vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri });
  if (!applied) {
    log.error(`VS Code refused to add ${dir} as a workspace folder`);
    return 'failed';
  }

  // Best effort: on the single-root transition the extension hosts restart, so
  // this code may not live long enough to run. The new root is already visible
  // either way — the reveal only expands and selects it.
  await waitForFolder(uri);
  await reveal(uri);
  return 'added';
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Two cases are expensive enough to ask about first; everything else just
 * happens, because a local window keeps its editors and terminals.
 *
 *  - a huge root. `newSessionHome` puts sessions in `os.homedir()`, so a home
 *    row is a normal thing to click — and adding it starts a recursive file
 *    watcher over the whole home directory, which can thrash the window. The
 *    filesystem root is the same mistake, larger.
 *  - a remote window that is not yet multi-root, which is the one configuration
 *    where the add reloads the window (`doEnterWorkspace` ends in
 *    `hostService.reload()` when there is a remote authority).
 */
async function confirmIfExpensive(dir: string): Promise<boolean> {
  const reason = expensiveReason(dir);
  if (!reason) {
    return true;
  }

  const choice = await vscode.window.showWarningMessage(reason, { modal: true }, 'Add folder');
  return choice === 'Add folder';
}

function expensiveReason(dir: string): string | undefined {
  const path = resolve(dir);

  if (path === resolve(homedir())) {
    return `Add your home directory (${path}) as a workspace folder? VS Code will watch every file under it, which can slow this window down.`;
  }
  if (dirname(path) === path) {
    return `Add the filesystem root (${path}) as a workspace folder? VS Code will watch every file under it, which can slow this window down.`;
  }
  if (vscode.env.remoteName !== undefined && vscode.workspace.workspaceFile === undefined) {
    return `Adding ${path} turns this into a multi-root workspace. On a remote window that reloads the window.`;
  }
  return undefined;
}

/**
 * `updateWorkspaceFolders` returns before the folder is registered, and
 * `revealInExplorer` on a path the Explorer does not know about yet does
 * nothing. Wait for the event, with a short ceiling so a swallowed event cannot
 * hang the command.
 */
function waitForFolder(uri: vscode.Uri): Promise<void> {
  if (vscode.workspace.getWorkspaceFolder(uri)) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      subscription.dispose();
      resolve();
    };
    const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (vscode.workspace.getWorkspaceFolder(uri)) {
        done();
      }
    });
    const timer = setTimeout(done, 1000);
  });
}

/**
 * `revealInExplorer` is enough on its own: its handler is
 * `openView(explorer) → setExpanded(true) → select(uri, 'force') → focus()`, so
 * the view comes forward even when the uri is a workspace root that has no
 * selectable row of its own. No separate `workbench.view.explorer` needed.
 */
async function reveal(uri: vscode.Uri): Promise<void> {
  await safelyAsync(
    'revealInExplorer',
    async () => {
      await vscode.commands.executeCommand('revealInExplorer', uri);
    },
    undefined,
  );
}
