/**
 * The open-tab picker.
 *
 * A window that has been worked in for a day holds dozens of tabs — files,
 * diffs, terminals, and the editor-area terminals this extension starts Claude
 * sessions in. VS Code's own Quick Open searches files, not tabs, so this is a
 * QuickPick over `vscode.window.tabGroups`, grouped by what each tab *is*.
 *
 * Two things the tab API does not give, and how they are recovered here:
 *
 * - **A terminal tab carries no `Terminal` handle.** `TabInputTerminal` is an
 *   empty marker, so the tab is matched to a live terminal by name, each
 *   terminal claimed at most once. Focusing then goes through `terminal.show()`
 *   rather than the tab, which is the only way to raise a terminal at all.
 * - **Panel terminals are not tabs.** They are just as much of the mess, so any
 *   terminal left unclaimed by a terminal tab is listed too, marked `panel`.
 *
 * Claude sessions are terminals like any other; what separates them is the
 * registry. Every live session's pid is resolved to its hosting terminal
 * (`terminal/link.ts`), and a terminal found that way is listed under Claude
 * Sessions with the row label the rail itself shows.
 *
 * The close button is deliberately absent on Claude rows: closing that terminal
 * kills a running agent and loses in-flight work, which is why the rail gates
 * Stop Session behind a modal confirm. Cleanup here stays limited to tabs whose
 * loss costs nothing that VS Code would not already prompt about.
 */

import * as vscode from 'vscode';

import { sessionLabel, type SessionNode } from '../model/types';
import type { RailRegistry } from '../scan/registry';
import { findTerminalForPid } from '../terminal/link';
import { log, safelyAsync } from '../util/log';

/** What a tab is, which is also what it is grouped under. */
type TabKind = 'claude' | 'file' | 'diff' | 'notebook' | 'terminal' | 'view' | 'other';

/** Group order in the pick. Only non-empty groups get a separator. */
const GROUPS: readonly { kind: TabKind; title: string }[] = [
  { kind: 'claude', title: 'Claude Sessions' },
  { kind: 'file', title: 'Files' },
  { kind: 'diff', title: 'Diffs' },
  { kind: 'notebook', title: 'Notebooks' },
  { kind: 'terminal', title: 'Terminals' },
  { kind: 'view', title: 'Views' },
  { kind: 'other', title: 'Other' },
];

const ICONS: Record<TabKind, string> = {
  claude: 'comment-discussion',
  file: 'file-code',
  diff: 'diff',
  notebook: 'notebook',
  terminal: 'terminal',
  view: 'browser',
  other: 'circle-outline',
};

interface TabEntry {
  kind: TabKind;
  label: string;
  /** Short context — folder, session title, `panel`, `unsaved`. */
  description: string;
  /** The full path or other long form, so the search reaches it. */
  detail?: string;
  /** Raise this tab. Never throws; a tab kind VS Code cannot focus says so. */
  activate: () => Promise<void>;
  /** Close it, when closing costs nothing a prompt would not cover. */
  close?: () => Promise<void>;
}

/** `entry`, not `kind` — `QuickPickItem.kind` is the separator enum. */
interface TabItem extends vscode.QuickPickItem {
  entry?: TabEntry;
}

const CLOSE_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('close'),
  tooltip: 'Close',
};

/**
 * Open the picker. Accepting a row raises that tab; the `$(close)` button on a
 * row closes it and leaves the pick open on a freshly collected list, so a
 * cleanup pass is one pass rather than one reopen per tab.
 */
export async function showTabSearch(registry: RailRegistry): Promise<void> {
  const pick = vscode.window.createQuickPick<TabItem>();
  pick.title = 'Open Tabs';
  pick.placeholder = 'Search open tabs — files, terminals, Claude sessions…';
  pick.matchOnDescription = true;
  pick.matchOnDetail = true;

  const refill = async (): Promise<void> => {
    pick.busy = true;
    pick.items = toItems(await collectTabs(registry));
    pick.busy = false;
  };

  try {
    pick.show();
    await refill();

    await new Promise<void>((resolve) => {
      pick.onDidTriggerItemButton(async (event) => {
        const close = event.item.entry?.close;
        if (close === undefined) {
          return;
        }
        await close();
        // The tab is gone but its neighbours may have changed too (a closed
        // group, a terminal that took its tab with it), so recollect rather
        // than splice.
        await refill();
      });
      pick.onDidAccept(() => {
        const entry = pick.selectedItems[0]?.entry;
        if (entry === undefined) {
          // The "nothing open" row — leave the pick as it is.
          return;
        }
        pick.hide();
        void entry.activate();
      });
      pick.onDidHide(() => resolve());
    });
  } finally {
    pick.dispose();
  }
}

/** Entries, in group order, each group's rows in tab order. */
function toItems(entries: readonly TabEntry[]): TabItem[] {
  if (entries.length === 0) {
    return [{ label: 'No open tabs.' }];
  }

  const items: TabItem[] = [];
  for (const group of GROUPS) {
    const rows = entries.filter((entry) => entry.kind === group.kind);
    if (rows.length === 0) {
      continue;
    }
    items.push({
      label: `${group.title} (${rows.length})`,
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const entry of rows) {
      items.push({
        label: `$(${ICONS[entry.kind]}) ${entry.label}`,
        description: entry.description,
        detail: entry.detail,
        buttons: entry.close ? [CLOSE_BUTTON] : undefined,
        entry,
      });
    }
  }
  return items;
}

// ─────────────────────────────────────────────────────────────
// Collection
// ─────────────────────────────────────────────────────────────

async function collectTabs(registry: RailRegistry): Promise<TabEntry[]> {
  const sessions = await claudeTerminals(registry);
  // A terminal backs at most one row: whichever terminal tab claims it first,
  // and otherwise the panel sweep below.
  const claimed = new Set<vscode.Terminal>();
  const entries: TabEntry[] = [];

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      entries.push(describeTab(tab, group, sessions, claimed));
    }
  }

  for (const terminal of vscode.window.terminals) {
    if (claimed.has(terminal)) {
      continue;
    }
    entries.push(terminalEntry(terminal, sessions.get(terminal), 'panel'));
  }

  return entries;
}

/**
 * Every live session's hosting terminal, by terminal.
 *
 * `findTerminalForPid` shells out to `ps`, but it caches per pid for 10s and
 * the calls run concurrently, so a window full of sessions costs one round of
 * ancestry walks — the pick shows `busy` while it happens.
 */
async function claudeTerminals(registry: RailRegistry): Promise<Map<vscode.Terminal, SessionNode>> {
  const found = new Map<vscode.Terminal, SessionNode>();

  const live = registry
    .snapshot()
    .projects.flatMap((project) => project.sessions)
    // `pid: 0` is the transcript-history sentinel — there is no process to walk.
    .filter((session) => session.alive && session.pid > 0);

  await Promise.all(
    live.map(async (session) => {
      const terminal = await safelyAsync(
        `claudeTerminals(${session.pid})`,
        () => findTerminalForPid(session.pid),
        undefined,
      );
      if (terminal !== undefined && !found.has(terminal)) {
        found.set(terminal, session);
      }
    }),
  );

  return found;
}

function describeTab(
  tab: vscode.Tab,
  group: vscode.TabGroup,
  sessions: ReadonlyMap<vscode.Terminal, SessionNode>,
  claimed: Set<vscode.Terminal>,
): TabEntry {
  const input: unknown = tab.input;

  if (input instanceof vscode.TabInputTerminal) {
    const terminal = claimTerminal(tab.label, claimed);
    return terminalEntry(terminal, terminal && sessions.get(terminal), tab, group);
  }

  if (input instanceof vscode.TabInputText) {
    return uriEntry('file', tab, group, input.uri, () =>
      vscode.window.showTextDocument(input.uri, {
        viewColumn: group.viewColumn,
        preview: false,
      }),
    );
  }

  if (input instanceof vscode.TabInputCustom) {
    return uriEntry('file', tab, group, input.uri, () =>
      vscode.commands.executeCommand('vscode.open', input.uri, group.viewColumn),
    );
  }

  if (input instanceof vscode.TabInputNotebook) {
    return uriEntry('notebook', tab, group, input.uri, async () => {
      const notebook = await vscode.workspace.openNotebookDocument(input.uri);
      await vscode.window.showNotebookDocument(notebook, { viewColumn: group.viewColumn });
    });
  }

  if (input instanceof vscode.TabInputTextDiff) {
    return uriEntry('diff', tab, group, input.modified, () =>
      vscode.commands.executeCommand('vscode.diff', input.original, input.modified, tab.label, {
        viewColumn: group.viewColumn,
      }),
    );
  }

  if (input instanceof vscode.TabInputNotebookDiff) {
    return uriEntry('diff', tab, group, input.modified, async () => {
      // No `vscode.diff` equivalent for notebooks; opening the modified side is
      // the closest thing the API offers.
      const notebook = await vscode.workspace.openNotebookDocument(input.modified);
      await vscode.window.showNotebookDocument(notebook, { viewColumn: group.viewColumn });
    });
  }

  // Webviews (this extension's own transcript reader included), the Settings
  // editor, walkthroughs — real tabs with no uri and no focus API.
  const kind: TabKind = input instanceof vscode.TabInputWebview ? 'view' : 'other';
  return {
    kind,
    label: tab.label,
    description: tabFlags(tab, group).join(' · '),
    activate: async () => unfocusable(tab.label),
    close: closer(tab),
  };
}

function uriEntry(
  kind: TabKind,
  tab: vscode.Tab,
  group: vscode.TabGroup,
  uri: vscode.Uri,
  show: () => Thenable<unknown>,
): TabEntry {
  const relative = vscode.workspace.asRelativePath(uri, false);
  return {
    kind,
    label: tab.label,
    description: [...tabFlags(tab, group), relative].join(' · '),
    // The path in full, so a search on a directory name reaches a file whose
    // own name does not contain it.
    detail: uri.scheme === 'file' ? uri.fsPath : uri.toString(),
    activate: async () => {
      await safelyAsync(`activate tab ${tab.label}`, async () => show(), undefined);
    },
    close: closer(tab),
  };
}

/**
 * A terminal row, from either side: a terminal tab in the editor area (`tab`
 * given) or a panel terminal (`'panel'`). A terminal hosting a live Claude
 * session becomes a Claude row instead, and loses its close button with it.
 */
function terminalEntry(
  terminal: vscode.Terminal | undefined,
  session: SessionNode | undefined,
  where: vscode.Tab | 'panel',
  group?: vscode.TabGroup,
): TabEntry {
  const tab = where === 'panel' ? undefined : where;
  const label = terminal?.name ?? tab?.label ?? 'Terminal';
  const flags = tab && group ? tabFlags(tab, group) : ['panel'];

  if (session !== undefined) {
    return {
      kind: 'claude',
      label: sessionLabel(session),
      description: [...flags, label].join(' · '),
      detail: session.cwd,
      activate: async () => terminal?.show(),
      // No close: this terminal is a running agent. Stop Session, which
      // confirms, is the way to end one.
    };
  }

  return {
    kind: 'terminal',
    label,
    description: flags.join(' · '),
    activate: async () => {
      if (terminal === undefined) {
        await unfocusable(label);
        return;
      }
      terminal.show();
    },
    close:
      terminal !== undefined
        ? async () => {
            terminal.dispose();
          }
        : closer(tab),
  };
}

/**
 * Match a terminal tab to a live terminal by name, claiming it so two tabs with
 * the same name cannot resolve to one terminal. Undefined when nothing matches
 * — the row is still listed, it just cannot be raised.
 */
function claimTerminal(label: string, claimed: Set<vscode.Terminal>): vscode.Terminal | undefined {
  for (const terminal of vscode.window.terminals) {
    if (!claimed.has(terminal) && terminal.name === label) {
      claimed.add(terminal);
      return terminal;
    }
  }
  return undefined;
}

/** The short state words that ride in front of a row's description. */
function tabFlags(tab: vscode.Tab, group: vscode.TabGroup): string[] {
  const flags: string[] = [];
  if (tab.isDirty) {
    flags.push('unsaved');
  }
  if (tab.isPinned) {
    flags.push('pinned');
  }
  if (tab.isActive && group.isActive) {
    flags.push('active');
  }
  if (vscode.window.tabGroups.all.length > 1) {
    flags.push(`group ${group.viewColumn}`);
  }
  return flags;
}

function closer(tab: vscode.Tab | undefined): (() => Promise<void>) | undefined {
  if (tab === undefined) {
    return undefined;
  }
  return async () => {
    // VS Code raises its own save prompt on a dirty tab, so nothing is lost
    // silently here.
    await safelyAsync(`close tab ${tab.label}`, async () => vscode.window.tabGroups.close(tab), false);
  };
}

async function unfocusable(label: string): Promise<void> {
  log.warn(`No VS Code API can focus the tab "${label}"`);
  void vscode.window.showInformationMessage(
    `VS Code has no way to focus "${label}" from an extension. Click its tab directly.`,
  );
}
