/**
 * Presentation layer for the session rail tree.
 *
 * Turns a `RailNode` into a `vscode.TreeItem`. Pure — no filesystem access,
 * no registry calls, no knowledge of how the tree is wired up. `RailTreeItem`
 * keeps a reference back to the node it was built from so command handlers
 * (and future debugging) can recover the underlying data.
 */

import * as vscode from 'vscode';

import {
  AgentNode,
  FilterNode,
  ProjectNode,
  RailNode,
  SectionNode,
  SessionNode,
  SessionState,
  TaskNode,
} from '../model/types';

const FOCUS_TERMINAL_COMMAND = 'sessionRail.focusTerminal';
const SEARCH_COMMAND = 'sessionRail.searchSessions';

/**
 * The little presentation state that can't be read off a node. Passed in by the
 * provider rather than stored here, so this module stays pure.
 */
export interface RenderOptions {
  /**
   * A search is active. Project rows open regardless of their live count —
   * otherwise a history-only project whose sessions matched would render
   * collapsed and the search would look like it found nothing.
   */
  filtering?: boolean;
  /**
   * `showExited` is off, so exited and history rows are not in the snapshot and
   * therefore cannot be searched. A zero-match row says so instead of implying
   * the session never existed.
   */
  exitedHidden?: boolean;
  /**
   * This project row is pinned. Only affects a project item: it picks the
   * `pinned` icon and the `project.pinned` context value, so the row offers
   * Unpin where an unpinned one offers Pin.
   */
  pinned?: boolean;
}

/** TreeItem that keeps the RailNode it was rendered from reachable. */
export class RailTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    readonly node: RailNode,
  ) {
    super(label, collapsibleState);
  }
}

/**
 * Stable string key for a node: `${kind}:${id}`. Used both as `TreeItem.id`
 * (so VS Code preserves expansion/selection across refreshes) and as the
 * parent-map key in provider.ts, so parent lookups work even when a node
 * object arrives from a different Snapshot instance than the one the map
 * was built from (e.g. via `registry.findSession()`).
 */
export function nodeKey(node: RailNode): string {
  return `${node.kind}:${node.id}`;
}

/** Build the vscode.TreeItem for any node in the tree. */
export function toTreeItem(node: RailNode, options: RenderOptions = {}): RailTreeItem {
  switch (node.kind) {
    case 'section':
      return buildSectionItem(node);
    case 'project':
      return buildProjectItem(node, options);
    case 'session':
      return buildSessionItem(node);
    case 'agent':
      return buildAgentItem(node);
    case 'task':
      return buildTaskItem(node);
    case 'filter':
      return buildFilterItem(node, options);
    default:
      return assertNever(node);
  }
}

/**
 * The search row. Clicking it reopens the input box pre-filled with the current
 * query, so the row doubles as the way to edit or clear the search.
 *
 * `contextValue` is deliberately left unset: the row owns no context menu, and
 * every contributed menu is gated on one of the five documented values.
 */
function buildFilterItem(node: FilterNode, options: RenderOptions): RailTreeItem {
  const active = node.query.length > 0;
  const label = active ? `Search: ${node.query}` : 'Search sessions…';
  const item = new RailTreeItem(label, vscode.TreeItemCollapsibleState.None, node);
  item.id = nodeKey(node);
  if (active) {
    item.description =
      node.matches === 0
        ? // Only searchable sessions can be searched: with `showExited` off the
          // snapshot holds no exited or history rows at all, so a miss is
          // ambiguous unless the row admits what is out of scope.
          options.exitedHidden === true
          ? 'no matches · exited hidden'
          : 'no matches'
        : `${node.matches} match${node.matches === 1 ? '' : 'es'}`;
  }
  item.iconPath = new vscode.ThemeIcon(active ? 'filter-filled' : 'search');
  item.command = {
    command: SEARCH_COMMAND,
    title: 'Search sessions',
    arguments: [],
  };
  item.tooltip = new vscode.MarkdownString(
    active
      ? 'Filtering sessions by title (or name, when a session has no title yet).' +
        '\n\nClick to edit; clear the box to show everything again.' +
        (options.exitedHidden === true
          ? '\n\nOnly the sessions the tree is showing are searched — turn on ' +
            '`Show Exited Sessions` to include past ones.'
          : '')
      : 'Click to filter sessions by their title.',
  );

  return item;
}

/**
 * The `Pinned` accordion header. Expanded by default — pins exist to be visible —
 * but its `TreeItem.id` is stable, so a user who collapses it keeps it collapsed
 * across refreshes.
 *
 * `contextValue` is deliberately unset: like the search row it owns no context
 * menu, and every contributed menu is gated on one of the documented values.
 */
function buildSectionItem(node: SectionNode): RailTreeItem {
  const item = new RailTreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded, node);
  item.id = nodeKey(node);
  item.description = String(node.projects.length);
  item.iconPath = new vscode.ThemeIcon('pinned');
  item.tooltip = new vscode.MarkdownString(
    '**Pinned folders**\n\nKept at the top of the tree, in the order they were pinned. ' +
      'A pinned folder stays listed even when nothing is running in it.',
  );

  return item;
}

function buildProjectItem(node: ProjectNode, options: RenderOptions): RailTreeItem {
  // A project with nothing running is history — with `showExited` on there can
  // be dozens of them, so they open closed. Anything live stays expanded, and
  // so does anything a search kept: a collapsed match is an invisible match.
  const collapsibleState =
    node.sessions.length === 0
      ? vscode.TreeItemCollapsibleState.None
      : node.liveCount > 0 || options.filtering === true
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;

  const pinned = options.pinned === true;
  const item = new RailTreeItem(node.name, collapsibleState, node);
  item.id = nodeKey(node);
  if (node.liveCount > 0) {
    item.description = String(node.liveCount);
  } else if (node.sessions.length > 0) {
    // A bare number here would read as a live count, which is exactly what it
    // is not.
    item.description = `${node.sessions.length} past`;
  } else if (pinned) {
    // Only a pinned row can be here with nothing under it, and a bare label
    // would look like a folder whose sessions failed to load.
    item.description = 'no sessions';
  }
  item.iconPath = new vscode.ThemeIcon(pinned ? 'pinned' : 'folder');
  // The one place a contextValue carries more than a node kind: the menus need
  // to offer Pin or Unpin, never both.
  item.contextValue = pinned ? 'project.pinned' : 'project';
  item.tooltip = new vscode.MarkdownString(
    `**Project**\n\n- **Path**: \`${node.dir}\`` + (pinned ? '\n- **Pinned**: yes' : ''),
  );

  return item;
}

function buildSessionItem(node: SessionNode): RailTreeItem {
  const collapsibleState =
    node.agents.length > 0 || node.tasks.length > 0
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;

  // Claude Code's summarized title when it has one; its derived name otherwise.
  // The name is not lost — it moves into the description, where it is still the
  // string that matches the terminal a resume would attach to.
  const item = new RailTreeItem(node.title ?? node.name, collapsibleState, node);
  item.id = nodeKey(node);
  const description = sessionDescription(node);
  if (description !== undefined) {
    item.description = description;
  }
  item.iconPath = new vscode.ThemeIcon(
    'circle-filled',
    new vscode.ThemeColor(sessionStateColor(node.state)),
  );
  item.contextValue = node.alive ? 'session.live' : 'session.exited';
  item.command = {
    command: FOCUS_TERMINAL_COMMAND,
    title: 'Open terminal',
    arguments: [node],
  };
  item.tooltip = sessionTooltip(node);

  return item;
}

function sessionStateColor(state: SessionState): string {
  switch (state) {
    case 'generating':
      return 'sessionRail.working';
    case 'idle':
      return 'sessionRail.live';
    case 'waiting':
      return 'sessionRail.waiting';
    case 'exited':
      return 'sessionRail.exited';
    default:
      return assertNever(state);
  }
}

function sessionDescription(node: SessionNode): string | undefined {
  if (node.state === 'exited') {
    // History rows are ordered by recency, so the age is what tells them apart.
    return node.lastActivityAt !== undefined
      ? `exited · ${formatAge(Date.now() - node.lastActivityAt)}`
      : 'exited';
  }

  const parts: string[] = [];
  if (node.title !== undefined) {
    // Displaced from the label by the title, but still worth showing: it is the
    // name the terminal and `focusTerminal`'s messages use.
    parts.push(node.name);
  }
  if (node.branch !== undefined) {
    parts.push(node.branch);
  }
  if (node.model !== undefined) {
    parts.push(node.model);
  }
  if (node.effort !== undefined) {
    parts.push(node.effort);
  }

  if (node.state === 'generating' && node.startedAt !== undefined) {
    parts.push(formatElapsed(Date.now() - node.startedAt));
  } else if (
    (node.state === 'idle' || node.state === 'waiting') &&
    node.lastActivityAt !== undefined
  ) {
    // Spec only names the "idle " prefix for the idle state; "waiting" is
    // underspecified — reusing lastActivityAt without the prefix here.
    const elapsed = formatElapsed(Date.now() - node.lastActivityAt);
    parts.push(node.state === 'idle' ? `idle ${elapsed}` : elapsed);
  }

  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function sessionTooltip(node: SessionNode): vscode.MarkdownString {
  const lines: string[] = ['**Session**', ''];
  if (node.title !== undefined) {
    lines.push(`- **Title**: ${node.title}`);
  }
  lines.push(`- **Name**: ${node.name}`);
  lines.push(`- **Session ID**: ${node.sessionId}`);
  // A transcript-derived row has no process behind it, so `pid: 0` is a
  // sentinel rather than a fact worth showing.
  if (node.source === 'registry') {
    lines.push(`- **PID**: ${node.pid}`);
  }
  lines.push(`- **CWD**: \`${node.cwd}\``);
  if (node.entrypoint !== undefined) {
    lines.push(`- **Entrypoint**: ${node.entrypoint}`);
  }
  if (node.version !== undefined) {
    lines.push(`- **Version**: ${node.version}`);
  }
  lines.push(`- **State**: ${node.state}`);
  if (node.source === 'transcript') {
    lines.push('', 'Recovered from its transcript — the session registry no longer has it.');
  }

  return new vscode.MarkdownString(lines.join('\n'));
}

function buildAgentItem(node: AgentNode): RailTreeItem {
  const collapsibleState =
    node.children.length > 0
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;

  const item = new RailTreeItem(stripPluginPrefix(node.agentType), collapsibleState, node);
  item.id = nodeKey(node);
  item.description = agentDescription(node);
  item.iconPath =
    node.state === 'running'
      ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('sessionRail.working'))
      : new vscode.ThemeIcon('pass', new vscode.ThemeColor('sessionRail.live'));
  item.contextValue = 'agent';
  item.tooltip = agentTooltip(node);

  return item;
}

function agentDescription(node: AgentNode): string {
  const parts: string[] = [`d${node.spawnDepth}`];
  if (node.state === 'done' && node.startedAt !== undefined && node.endedAt !== undefined) {
    parts.push(formatElapsed(node.endedAt - node.startedAt));
  }
  return parts.join(' · ');
}

function agentTooltip(node: AgentNode): vscode.MarkdownString {
  const lines: string[] = ['**Agent**', ''];
  lines.push(`- **Agent type**: ${node.agentType}`);
  if (node.description !== undefined) {
    lines.push(`- **Task**: ${node.description}`);
  }
  lines.push(`- **Spawn depth**: ${node.spawnDepth}`);
  lines.push(`- **Tool use ID**: ${node.toolUseId}`);

  return new vscode.MarkdownString(lines.join('\n'));
}

function stripPluginPrefix(agentType: string): string {
  const separatorIndex = agentType.indexOf(':');
  return separatorIndex >= 0 ? agentType.slice(separatorIndex + 1) : agentType;
}

function buildTaskItem(node: TaskNode): RailTreeItem {
  const item = new RailTreeItem(node.subject, vscode.TreeItemCollapsibleState.None, node);
  item.id = nodeKey(node);
  item.contextValue = 'task';

  switch (node.status) {
    case 'pending':
      item.iconPath = new vscode.ThemeIcon('circle-outline');
      break;
    case 'in_progress':
      item.iconPath = new vscode.ThemeIcon('clock', new vscode.ThemeColor('sessionRail.working'));
      break;
    case 'completed':
      item.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('sessionRail.live'));
      item.description = 'done';
      break;
    default:
      break;
  }

  item.tooltip = taskTooltip(node);

  return item;
}

function taskTooltip(node: TaskNode): vscode.MarkdownString {
  const lines: string[] = [node.subject];
  if (node.blockedBy.length > 0) {
    lines.push('', `Blocked by: ${node.blockedBy.join(', ')}`);
  }

  return new vscode.MarkdownString(lines.join('\n'));
}

/** Elapsed/duration formatting: `mm:ss` under an hour, else `h:mm`. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours >= 1) {
    return `${hours}:${String(minutes).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Coarse age for rows measured in days, not seconds: `3d`, `5h`, `12m`, `now`. */
function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) {
    return 'now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

/** Exhaustiveness helper — the contract's unions are closed; this should be unreachable. */
function assertNever(value: never): never {
  throw new Error(`Unhandled union member: ${JSON.stringify(value)}`);
}
