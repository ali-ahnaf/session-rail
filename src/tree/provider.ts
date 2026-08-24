/**
 * TreeDataProvider that renders a RailRegistry's Snapshot as a VS Code tree.
 *
 * Bridges the registry (data, refreshed asynchronously) to RailTreeItem
 * (presentation, built in items.ts). Maintains a parent map rebuilt on every
 * snapshot so TreeView.reveal() works via getParent().
 */

import { basename } from 'path';

import * as vscode from 'vscode';

import {
  FilterNode,
  ProjectNode,
  RailNode,
  SectionNode,
  SessionNode,
  Snapshot,
  sessionLabel,
  walkAgents,
} from '../model/types';
import type { RailRegistry } from '../scan/registry';
import { log } from '../util/log';
import { nodeKey, toTreeItem } from './items';
import { normalizeDir, type PinStore } from './pins';

export class RailTreeProvider implements vscode.TreeDataProvider<RailNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<RailNode | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<RailNode | undefined | void> =
    this.changeEmitter.event;

  private readonly registrySubscription: vscode.Disposable;
  /** Snapshot last observed via onDidChange, kept in lock-step with parentMap. */
  private snapshot: Snapshot;
  /**
   * Keyed by the same `${kind}:${id}` string used for `TreeItem.id`, not by
   * object reference — a node handed to getParent() may come from
   * `registry.findSession()`/`findAgent()` rather than from this snapshot's
   * own object graph, so reference equality can't be relied on.
   */
  private parentMap = new Map<string, RailNode>();
  private readonly loggedWarnings = new Set<string>();
  /**
   * Active search, trimmed; empty when nothing is filtered. Deliberately not a
   * setting: it is a transient query, not a preference, so it lives here and
   * dies with the window. Filtering also needs no rescan — the same snapshot is
   * re-filtered on every poll, so the registry is left alone.
   */
  private filter = '';
  /**
   * The root rows and the parent map are computed together by `recompute()`, so
   * the `Pinned` section object a child's parent lookup returns is the very one
   * `getChildren(undefined)` handed to the view.
   */
  private roots: RailNode[] = [];
  /**
   * Worktree projects nested under the project they were created from, keyed by
   * the parent's `nodeKey`. Rebuilt with the roots: a project row is either a
   * root or a child here, never both, so `TreeItem.id` stays unique. Empty while
   * a search is active — the search is over sessions and renders flat.
   */
  private worktreeChildren = new Map<string, ProjectNode[]>();
  private readonly pinSubscription: vscode.Disposable;

  // The registry is read once here and thereafter only through onDidChange, so
  // it is deliberately not retained as a field — `this.snapshot` is the single
  // source of truth the parent map stays in lock-step with.
  constructor(registry: RailRegistry, private readonly pins: PinStore) {
    this.snapshot = registry.snapshot();
    this.syncSearchContext();
    this.recompute();
    this.registrySubscription = registry.onDidChange((snapshot) => {
      this.snapshot = snapshot;
      this.recompute();
      this.changeEmitter.fire(undefined);
    });
    // Pins move rows between the section and the root list; like the filter this
    // needs no rescan, only a re-render of the snapshot already in memory.
    this.pinSubscription = this.pins.onDidChange(() => {
      this.recompute();
      this.changeEmitter.fire(undefined);
    });
  }

  /** The active search, so the input box can open pre-filled. */
  get filterQuery(): string {
    return this.filter;
  }

  /**
   * Apply (or clear, with an empty string) the session search. Cheap enough to
   * call on every keystroke — it re-filters the snapshot already in memory and
   * fires a tree change; no disk access, no registry refresh.
   */
  setFilter(query: string): void {
    const next = query.trim();
    if (next === this.filter) {
      return;
    }
    this.filter = next;
    this.syncSearchContext();
    this.recompute();
    this.changeEmitter.fire(undefined);
  }

  /** Drives the view-title clear button's visibility. */
  private syncSearchContext(): void {
    void vscode.commands.executeCommand(
      'setContext',
      'sessionRail.searchActive',
      this.filter.length > 0,
    );
  }

  getTreeItem(node: RailNode): vscode.TreeItem {
    try {
      const nested = node.kind === 'project' ? this.worktreeChildren.get(nodeKey(node)) : undefined;
      return toTreeItem(node, {
        filtering: this.filter.length > 0,
        exitedHidden: !showExited(),
        pinned: node.kind === 'project' && this.pins.has(node.dir),
        nestedWorktrees: nested?.length,
        nestedLive: nested?.reduce((sum, child) => sum + child.liveCount, 0),
      });
    } catch (error) {
      log.error('RailTreeProvider.getTreeItem failed', error);
      return new vscode.TreeItem('(error rendering item)', vscode.TreeItemCollapsibleState.None);
    }
  }

  getChildren(node?: RailNode): RailNode[] {
    try {
      if (node === undefined) {
        return this.getRootChildren();
      }

      switch (node.kind) {
        case 'section':
          return node.projects;
        case 'project':
          return [...node.sessions, ...(this.worktreeChildren.get(nodeKey(node)) ?? [])];
        case 'session':
          return [...node.agents, ...node.tasks];
        case 'agent':
          return node.children;
        case 'task':
        case 'filter':
          return [];
        default:
          return [];
      }
    } catch (error) {
      log.error('RailTreeProvider.getChildren failed', error);
      return [];
    }
  }

  getParent(node: RailNode): RailNode | undefined {
    return this.parentMap.get(nodeKey(node));
  }

  dispose(): void {
    this.pinSubscription.dispose();
    this.registrySubscription.dispose();
    this.changeEmitter.dispose();
  }

  private getRootChildren(): RailNode[] {
    const snapshot = this.snapshot;

    if (snapshot.warnings.length > 0 && snapshot.projects.length === 0) {
      for (const warning of snapshot.warnings) {
        if (!this.loggedWarnings.has(warning)) {
          this.loggedWarnings.add(warning);
          log.warn(warning);
        }
      }
      return [];
    }

    // Nothing on the machine and nothing pinned: empty, so the `viewsWelcome`
    // message gets its turn. `recompute()` produces exactly that, so the check
    // lives there rather than as a second early return here.
    return this.roots;
  }

  /**
   * Rebuild the root rows and the parent map from the current snapshot, filter,
   * and pins. Order is fixed: the search row (directly under the view header),
   * then the `Pinned` accordion, then everything unpinned.
   */
  private recompute(): void {
    const { pinned, unpinned } = this.splitRoots();
    // Worktree rows tuck under the project they were created from; the ones
    // that found a parent leave the root list.
    const { rootUnpinned, children } = this.nestWorktrees(pinned, unpinned);
    this.worktreeChildren = children;

    const rows: RailNode[] = [];
    // A search row over zero sessions would only be in the way — but once a
    // query is active it is always returned, even at zero matches, because an
    // empty root hands the view to `viewsWelcome`, which claims the machine has
    // no sessions. That would be a lie.
    if (this.snapshot.projects.length > 0 || this.filter.length > 0) {
      rows.push(this.filterNode([...pinned, ...unpinned]));
    }
    const section =
      pinned.length > 0
        ? ({ kind: 'section', id: 'pinned', label: 'Pinned', projects: pinned } as SectionNode)
        : undefined;
    if (section !== undefined) {
      rows.push(section);
    }
    rows.push(...rootUnpinned);

    this.roots = rows;
    this.rebuildParentMap(pinned, unpinned, section, children);
  }

  /**
   * Nest each unpinned worktree project under the row for its main repo —
   * `parentDir`, which the registry parsed from the worktree's `.git` file.
   *
   * Presentation only: the snapshot's `projects` list stays flat, so the status
   * bar and the header progress never walk a hierarchy. A worktree stays at the
   * root when its parent row is not visible (no sessions in the main repo and
   * it is not pinned) — a row that vanished into an absent parent would hide
   * its sessions. A *pinned* worktree also stays where the accordion puts it: a
   * node cannot render in two places, and pin order is the user's own. While a
   * search is active the tree renders flat — the search is over sessions, and
   * a parent kept alive only to carry a matching child would itself read as a
   * match.
   */
  private nestWorktrees(
    pinned: ProjectNode[],
    unpinned: ProjectNode[],
  ): { rootUnpinned: ProjectNode[]; children: Map<string, ProjectNode[]> } {
    const children = new Map<string, ProjectNode[]>();
    if (this.filter.length > 0) {
      return { rootUnpinned: unpinned, children };
    }

    // Parents can be pinned (the child then renders inside the accordion) or
    // placeholders — a pinned main repo with nothing running still shows its
    // worktrees.
    const byDir = new Map(
      [...pinned, ...unpinned].map((project) => [normalizeDir(project.dir), project]),
    );

    const rootUnpinned: ProjectNode[] = [];
    for (const project of unpinned) {
      const parent =
        project.worktree === true && project.parentDir !== undefined
          ? byDir.get(normalizeDir(project.parentDir))
          : undefined;
      if (parent === undefined || parent === project) {
        rootUnpinned.push(project);
        continue;
      }
      const siblings = children.get(nodeKey(parent));
      if (siblings === undefined) {
        children.set(nodeKey(parent), [project]);
      } else {
        siblings.push(project);
      }
    }

    return { rootUnpinned, children };
  }

  /**
   * Split the filtered projects into the pinned accordion and the rest.
   *
   * Pinned rows follow pin order, not the snapshot's activity order — a list the
   * user arranged should not reshuffle itself when a session starts. A pinned
   * folder the snapshot knows nothing about (no live session, exited rows
   * hidden, or the folder gone) still gets a synthesized row, because a pin that
   * vanishes the moment the work stops is not a pin. While a search is active
   * those placeholders drop out: the search is over sessions, and a row with
   * none of them cannot match.
   */
  private splitRoots(): { pinned: ProjectNode[]; unpinned: ProjectNode[] } {
    const visible = this.visibleProjects();
    const pinnedDirs = this.pins.list();
    if (pinnedDirs.length === 0) {
      return { pinned: [], unpinned: visible };
    }

    const byDir = new Map(visible.map((project) => [normalizeDir(project.dir), project]));
    const pinned: ProjectNode[] = [];
    for (const dir of pinnedDirs) {
      const match = byDir.get(dir);
      if (match !== undefined) {
        pinned.push(match);
      } else if (this.filter.length === 0) {
        pinned.push(placeholderProject(dir));
      }
    }

    const pinnedSet = new Set(pinnedDirs);
    return {
      pinned,
      unpinned: visible.filter((project) => !pinnedSet.has(normalizeDir(project.dir))),
    };
  }

  private filterNode(projects: ProjectNode[]): FilterNode {
    let matches = 0;
    for (const project of projects) {
      matches += project.sessions.length;
    }
    return { kind: 'filter', id: 'search', query: this.filter, matches };
  }

  /**
   * The snapshot's projects with the search applied: projects that kept no
   * session drop out, and the survivors are shallow copies whose `liveCount` is
   * recomputed — otherwise the project row's count would describe sessions the
   * search has hidden. Agents and tasks under a matched session are untouched.
   */
  private visibleProjects(): ProjectNode[] {
    if (this.filter.length === 0) {
      return this.snapshot.projects;
    }

    const needle = this.filter.toLowerCase();
    const kept: ProjectNode[] = [];
    for (const project of this.snapshot.projects) {
      const sessions = project.sessions.filter((session) => matchesQuery(session, needle));
      if (sessions.length === 0) {
        continue;
      }
      kept.push({
        ...project,
        sessions,
        liveCount: sessions.filter((session) => session.state !== 'exited').length,
      });
    }

    return kept;
  }

  /**
   * Rebuild the node → parent map. Uses walkAgents to reach nested agents; a
   * pinned project's parent is the section row it is rendered under, so
   * `reveal()` on a session inside the accordion expands the right chain.
   */
  private rebuildParentMap(
    pinned: ProjectNode[],
    unpinned: ProjectNode[],
    section: SectionNode | undefined,
    children: Map<string, ProjectNode[]>,
  ): void {
    const map = new Map<string, RailNode>();

    if (section !== undefined) {
      for (const project of pinned) {
        map.set(nodeKey(project), section);
      }
    }

    // A nested worktree's parent is the project row it renders under — set
    // after the section entries so a child never points at the accordion.
    for (const project of [...pinned, ...unpinned]) {
      for (const child of children.get(nodeKey(project)) ?? []) {
        map.set(nodeKey(child), project);
      }
    }

    for (const project of [...pinned, ...unpinned]) {
      for (const session of project.sessions) {
        map.set(nodeKey(session), project);

        for (const agent of session.agents) {
          map.set(nodeKey(agent), session);
        }
        walkAgents(session.agents, (agent) => {
          for (const child of agent.children) {
            map.set(nodeKey(child), agent);
          }
        });

        for (const task of session.tasks) {
          map.set(nodeKey(task), session);
        }
      }
    }

    this.parentMap = map;
  }
}

/**
 * Case-insensitive substring match on what the row actually shows —
 * `sessionLabel`, the same fold items.ts renders (title, then branch when the
 * name is only the sessionId fallback, then name). A live session earns its
 * title only after the first `ai-title` record lands, so matching the label
 * rather than `title` alone keeps young sessions findable. Plain substring,
 * not fuzzy — a search that matches loosely across a list of near-identical
 * titles is worse than one that misses.
 */
/**
 * A `ProjectNode` for a pinned directory the snapshot has no sessions for. Built
 * from the path alone — the tree layer does no filesystem access, so a pinned
 * folder that has since been deleted still renders here and is only reported as
 * missing when something tries to use it (`newSession` refuses it by name).
 * Mirrors `registry.ts`'s own construction: the id is the directory.
 */
function placeholderProject(dir: string): ProjectNode {
  return {
    kind: 'project',
    id: dir,
    name: basename(dir) || dir,
    dir,
    sessions: [],
    liveCount: 0,
  };
}

/**
 * Whether exited/history rows are in the snapshot at all. The registry drops
 * them when `showExited` is off, so the search can only ever cover what is
 * visible — the search row says as much when it finds nothing.
 */
function showExited(): boolean {
  return vscode.workspace.getConfiguration('sessionRail').get<boolean>('showExited', false) === true;
}

function matchesQuery(session: SessionNode, lowercaseNeedle: string): boolean {
  return sessionLabel(session).toLowerCase().includes(lowercaseNeedle);
}
