/**
 * Presentation layer for the session rail tree.
 *
 * Turns a `RailNode` into a `vscode.TreeItem`. No filesystem access, no registry
 * calls, no knowledge of how the tree is wired up. The one thing it reads that
 * is not on the node or in `RenderOptions` is `workbench.reduceMotion`, via
 * `motion.ts` — a user preference rather than tree state, shared with the view
 * header bar, and read at render time by design (see the motion invariant in
 * CLAUDE.md). `RailTreeItem`
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
  sessionLabel,
} from '../model/types';
import { motionAllowed } from './motion';

const FOCUS_TERMINAL_COMMAND = 'sessionRail.focusTerminal';
const SEARCH_COMMAND = 'sessionRail.searchSessions';

/**
 * The little presentation state that can't be read off a node, and that the
 * provider is the only one who knows. Passed in rather than stored here, so this
 * module keeps no state of its own. A user preference like
 * `workbench.reduceMotion` is deliberately NOT a field here — the provider has
 * no more claim on it than this module does, and threading it through would mean
 * every caller of `toTreeItem` had to remember to.
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
  /**
   * Worktree project rows the provider nests under this project. Only the
   * provider knows — nesting is its presentation state, not a node field — and
   * a project with only worktrees under it must still be expandable.
   */
  nestedWorktrees?: number;
  /**
   * Live sessions across those nested worktrees. A parent whose only activity
   * is inside a worktree must still open expanded, or the work is invisible.
   */
  nestedLive?: number;
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
  const nested = options.nestedWorktrees ?? 0;
  const nestedLive = options.nestedLive ?? 0;
  // A project with nothing running is history — with `showExited` on there can
  // be dozens of them, so they open closed. Anything live stays expanded, and
  // so does anything a search kept: a collapsed match is an invisible match.
  // Nested worktree rows count as content and their live sessions as activity,
  // or a repo whose only work happens in worktrees would render shut.
  const collapsibleState =
    node.sessions.length === 0 && nested === 0
      ? vscode.TreeItemCollapsibleState.None
      : node.liveCount > 0 || nestedLive > 0 || options.filtering === true
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;

  const pinned = options.pinned === true;
  // Over the sessions this row is rendering, which is the filtered list while a
  // search is active — so a search that hides the working session hides its
  // count and its spinner too, while the header bar (which reads the unfiltered
  // snapshot) keeps spinning.
  const working = node.sessions.filter((session) => session.state === 'generating').length;
  const item = new RailTreeItem(node.name, collapsibleState, node);
  item.id = nodeKey(node);
  const description: string[] = [];
  if (node.liveCount > 0) {
    description.push(String(node.liveCount));
  } else if (node.sessions.length > 0) {
    // A bare number here would read as a live count, which is exactly what it
    // is not.
    description.push(`${node.sessions.length} past`);
  } else if (pinned || node.worktree === true) {
    // Two rows can be here with nothing under them — a pinned placeholder and
    // an idle worktree (which the registry lists whether or not anything runs
    // in it) — and a bare label would look like a folder whose sessions failed
    // to load.
    description.push('no sessions');
  }
  if (working > 0) {
    // Text, not motion — this is the half of the working signal that survives
    // `reduceMotion` and tells a collapsed row how much is in flight.
    description.push(`${working} working`);
  }
  if (nested > 0) {
    // What a collapsed parent is holding besides its own sessions.
    description.push(`${nested} ${nested === 1 ? 'worktree' : 'worktrees'}`);
  }
  if (node.worktree === true) {
    // Static text, like `N working` — the marker must survive `reduceMotion`
    // and stay readable however the icon slot is being used.
    description.push('worktree');
  }
  if (description.length > 0) {
    item.description = description.join(' \u00b7 ');
  }
  // One slot, three claims on it, in this order: a spinner while anything under
  // here is generating, then `git-branch` on a worktree, then `pinned`. So a
  // pinned project can stop advertising its pin — pin state stays readable from
  // the `Pinned` section, the context menu, and `contextValue`, whereas a
  // worktree row nested under an ordinary-looking repo row has nowhere else to
  // say what it is except the description text beside it.
  item.iconPath =
    working > 0 && motionAllowed()
      ? new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('sessionRail.working'))
      : new vscode.ThemeIcon(
          node.worktree === true ? 'git-branch' : pinned ? 'pinned' : 'folder',
        );
  // Two flags ride the contextValue beyond the node kind, in a fixed order:
  // `project[.worktree][.pinned]`. The menus need Pin or Unpin (never both) and
  // Remove Worktree only on rows where git can actually remove one.
  let contextValue = 'project';
  if (node.worktree === true) {
    contextValue += '.worktree';
  }
  if (pinned) {
    contextValue += '.pinned';
  }
  item.contextValue = contextValue;
  item.tooltip = new vscode.MarkdownString(
    `**Project**\n\n- **Path**: \`${node.dir}\`` +
      (node.worktree === true ? '\n- **Worktree**: yes' : '') +
      (pinned ? '\n- **Pinned**: yes' : ''),
  );

  return item;
}

function buildSessionItem(node: SessionNode): RailTreeItem {
  const collapsibleState =
    node.agents.length > 0 || node.tasks.length > 0
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;

  // The summarized title when there is one, the branch while the name is only
  // the sessionId fallback, the name otherwise — see sessionLabel. The name is
  // not lost — it moves into the description, where it is still the string
  // that matches the terminal a resume would attach to.
  const item = new RailTreeItem(sessionLabel(node), collapsibleState, node);
  item.id = nodeKey(node);
  const description = sessionDescription(node);
  if (description !== undefined) {
    item.description = description;
  }
  item.iconPath = new vscode.ThemeIcon(
    node.state === 'generating' && motionAllowed() ? 'loading~spin' : 'circle-filled',
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

  const label = sessionLabel(node);
  const parts: string[] = [];
  if (label !== node.name) {
    // Displaced from the label by the title or the branch, but still worth
    // showing: it is the name the terminal and `focusTerminal`'s messages use.
    parts.push(node.name);
  }
  if (node.branch !== undefined && node.branch !== label) {
    // Skipped when the branch already IS the label — `fix-auth · fix-auth`
    // says nothing twice.
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
  if (node.state === 'generating') {
    // The state in words, so the row is readable without seeing motion or
    // separating amber from green.
    lines.push('- **Activity**: working');
  }
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
      ? new vscode.ThemeIcon(
          motionAllowed() ? 'loading~spin' : 'circle-filled',
          new vscode.ThemeColor('sessionRail.working'),
        )
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
  if (node.state === 'running') {
    lines.push('- **Activity**: working');
  }

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
