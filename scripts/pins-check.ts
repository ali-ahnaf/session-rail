/**
 * Check of the pinned-folders view logic, run against a stub vscode.
 *
 * This is the one deterministic check in the repo, and the exception is
 * deliberate: everything else in Session Rail reads state Claude Code writes, so
 * fixtures would only prove the code agrees with assumptions that were already
 * wrong once. Pins are the extension's OWN state — no on-disk shape to drift, no
 * machine to depend on — so the snapshot below is a stand-in for the registry,
 * not a fixture of `~/.claude`.
 *
 * Run: npm run check:pins
 */

import * as vscode from 'vscode';

import type { ProjectNode, RailNode, SectionNode, Snapshot } from '../src/model/types';
import type { RailRegistry } from '../src/scan/registry';
import { RailTreeProvider } from '../src/tree/provider';
import { PinStore } from '../src/tree/pins';

const vscodeStub = require('./vscode-stub.js') as {
  EventEmitter: new () => { event: unknown; fire(value: unknown): void; dispose(): void };
};

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  [${ok ? 'pass' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) {
    failures += 1;
  }
}

// ─────────────────────────────────────────────────────────────
// Stand-ins
// ─────────────────────────────────────────────────────────────

/** An in-memory `Memento`, so a check does not touch real globalState. */
function fakeMemento(initial: unknown = undefined) {
  const store = new Map<string, unknown>();
  if (initial !== undefined) {
    store.set('sessionRail.pinnedProjects', initial);
  }
  return {
    keys: () => [...store.keys()],
    get: <T>(key: string, fallback?: T) => (store.has(key) ? (store.get(key) as T) : fallback),
    update: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

function project(dir: string, sessionTitles: string[]): ProjectNode {
  return {
    kind: 'project',
    id: dir,
    name: dir.slice(dir.lastIndexOf('/') + 1),
    dir,
    liveCount: sessionTitles.length,
    sessions: sessionTitles.map((title, index) => ({
      kind: 'session',
      id: `${dir}#${index}`,
      sessionId: `${dir}#${index}`,
      pid: 1000 + index,
      name: `session-${index}`,
      title,
      cwd: dir,
      state: 'idle',
      alive: true,
      source: 'registry',
      agents: [],
      tasks: [],
    })),
  };
}

function snapshotOf(projects: ProjectNode[]): Snapshot {
  return { projects, generatedAt: 0, warnings: [] };
}

/** Registry stand-in: the provider only reads `snapshot()` and `onDidChange`. */
function fakeRegistry(snapshot: Snapshot): RailRegistry {
  const emitter = new vscodeStub.EventEmitter();
  return {
    snapshot: () => snapshot,
    onDidChange: emitter.event,
  } as unknown as RailRegistry;
}

function labels(nodes: RailNode[]): string[] {
  return nodes.map((node) => (node.kind === 'section' ? `[${node.label}]` : String((node as ProjectNode).name ?? node.kind)));
}

function sectionOf(roots: RailNode[]): SectionNode | undefined {
  return roots.find((node): node is SectionNode => node.kind === 'section');
}

/** The codicon id a row rendered, or '' when it is not a ThemeIcon. */
function iconId(item: vscode.TreeItem): string {
  const icon = item.iconPath;
  return icon instanceof vscode.ThemeIcon ? icon.id : '';
}

// ─────────────────────────────────────────────────────────────
// Checks
// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const alpha = project('/work/alpha', ['deploy the api']);
  const beta = project('/work/beta', ['fix the tree']);
  const gamma = project('/work/gamma', ['write the docs']);
  const registry = fakeRegistry(snapshotOf([alpha, beta, gamma]));

  console.log('\nNo pins');
  {
    const pins = new PinStore(fakeMemento());
    const provider = new RailTreeProvider(registry, pins);
    const roots = provider.getChildren();
    check('no section row', sectionOf(roots) === undefined);
    check('search row still first', roots[0]?.kind === 'filter', labels(roots).join(', '));
    check('every project at the root', roots.length === 4, labels(roots).join(', '));
    provider.dispose();
  }

  console.log('\nPins in pin order, above the rest');
  {
    // Deliberately not snapshot order: gamma pinned first must stay first.
    const pins = new PinStore(fakeMemento(['/work/gamma', '/work/alpha/']));
    const provider = new RailTreeProvider(registry, pins);
    const roots = provider.getChildren();
    const section = sectionOf(roots);
    check('section is the row under search', roots[1]?.kind === 'section', labels(roots).join(', '));
    check(
      'pinned in pin order',
      section?.projects.map((p) => p.name).join(',') === 'gamma,alpha',
      section?.projects.map((p) => p.name).join(',') ?? 'none',
    );
    check('trailing slash matched the same folder', section?.projects.length === 2);
    check(
      'pinned projects are not repeated at the root',
      roots.filter((node) => node.kind === 'project').map((node) => (node as ProjectNode).name).join(',') === 'beta',
      labels(roots).join(', '),
    );
    check(
      'a pinned project renders with the pinned context value',
      provider.getTreeItem(section!.projects[0]).contextValue === 'project.pinned',
    );
    check(
      'an unpinned project keeps the plain one',
      provider.getTreeItem(beta).contextValue === 'project',
    );
    check(
      'the section is the parent of a pinned project',
      provider.getParent(section!.projects[0]) === section,
    );
    check(
      'a session under a pinned project still resolves its project',
      provider.getParent(section!.projects[0].sessions[0]) === section!.projects[0],
    );
    provider.dispose();
  }

  console.log('\nA pinned folder with nothing running');
  {
    const pins = new PinStore(fakeMemento(['/work/delta']));
    const provider = new RailTreeProvider(registry, pins);
    const section = sectionOf(provider.getChildren());
    check('placeholder row survives', section?.projects.length === 1);
    check('named from the path', section?.projects[0]?.name === 'delta');
    check('no sessions invented', section?.projects[0]?.sessions.length === 0);
    check(
      'row says so rather than looking empty',
      provider.getTreeItem(section!.projects[0]).description === 'no sessions',
    );

    // A search is over sessions, so a row with none of them cannot match.
    provider.setFilter('deploy');
    const filtered = provider.getChildren();
    check('placeholder drops out under a search', sectionOf(filtered) === undefined, labels(filtered).join(', '));
    check(
      'the matching project is still there',
      filtered.filter((node) => node.kind === 'project').length === 1,
      labels(filtered).join(', '),
    );
    provider.dispose();
  }

  console.log('\nSearch across pinned and unpinned');
  {
    const pins = new PinStore(fakeMemento(['/work/alpha']));
    const provider = new RailTreeProvider(registry, pins);
    provider.setFilter('the');
    const roots = provider.getChildren();
    const filterRow = roots[0];
    check(
      // 'the' hits all three titles: one pinned, two not.
      'match count spans both groups',
      filterRow?.kind === 'filter' && filterRow.matches === 3,
      filterRow?.kind === 'filter' ? String(filterRow.matches) : 'no filter row',
    );
    provider.setFilter('deploy');
    const pinnedOnly = provider.getChildren();
    check(
      'a pinned-only match keeps the section and empties the root list',
      sectionOf(pinnedOnly)?.projects.length === 1 &&
        pinnedOnly.filter((node) => node.kind === 'project').length === 0,
      labels(pinnedOnly).join(', '),
    );
    provider.dispose();
  }

  console.log('\nPinning and unpinning at runtime');
  {
    const memento = fakeMemento();
    const pins = new PinStore(memento);
    const provider = new RailTreeProvider(registry, pins);
    let events = 0;
    provider.onDidChangeTreeData(() => {
      events += 1;
    });

    await pins.pin('/work/beta');
    check('the tree was told', events === 1, String(events));
    check('the pin persisted', JSON.stringify(memento.get('sessionRail.pinnedProjects')) === '["/work/beta"]');
    check('beta moved into the section', sectionOf(provider.getChildren())?.projects[0]?.name === 'beta');

    await pins.pin('/work/beta/');
    check('pinning the same folder twice is a no-op', events === 1 && pins.list().length === 1);

    await pins.unpin('/work/beta');
    check('unpin removed the section', sectionOf(provider.getChildren()) === undefined);
    check('unpin persisted', JSON.stringify(memento.get('sessionRail.pinnedProjects')) === '[]');
    provider.dispose();
  }

  console.log('\nWorktree projects nest under their origin');
  {
    const wt: ProjectNode = {
      ...project('/work/alpha-worktrees/fix-auth', ['fix the auth flow']),
      worktree: true,
      parentDir: '/work/alpha',
    };
    const orphan: ProjectNode = {
      ...project('/work/orphan-worktrees/stray', ['stray work']),
      worktree: true,
      parentDir: '/work/nowhere',
    };
    const nestedRegistry = fakeRegistry(snapshotOf([alpha, beta, wt, orphan]));
    const pins = new PinStore(fakeMemento());
    const provider = new RailTreeProvider(nestedRegistry, pins);
    const roots = provider.getChildren();
    check(
      'a linked worktree leaves the root list',
      !roots.some((node) => node.kind === 'project' && node.dir === wt.dir),
      labels(roots).join(', '),
    );
    const alphaChildren = provider.getChildren(alpha);
    check(
      'and renders under its origin, after the sessions',
      alphaChildren[alphaChildren.length - 1] === wt,
      String(alphaChildren.length),
    );
    check('the worktree row resolves its parent project', provider.getParent(wt) === alpha);
    check(
      'a session under a nested worktree resolves the worktree',
      provider.getParent(wt.sessions[0]) === wt,
    );
    check(
      'the worktree context value survives nesting',
      provider.getTreeItem(wt).contextValue === 'project.worktree',
    );
    check(
      'a worktree row says so with its icon',
      iconId(provider.getTreeItem(wt)) === 'git-branch',
      iconId(provider.getTreeItem(wt)),
    );
    const alphaItem = provider.getTreeItem(alpha);
    check(
      'the origin row counts its worktrees',
      String(alphaItem.description).includes('1 worktree'),
      String(alphaItem.description),
    );
    check(
      'a worktree whose origin row is absent stays at the root',
      roots.some((node) => node.kind === 'project' && node.dir === orphan.dir),
      labels(roots).join(', '),
    );

    provider.setFilter('fix the auth');
    const flat = provider.getChildren();
    check(
      'a search renders flat — the matching worktree surfaces at the root',
      flat.some((node) => node.kind === 'project' && node.dir === wt.dir),
      labels(flat).join(', '),
    );
    provider.setFilter('');
    provider.dispose();
  }

  console.log('\nA worktree with no sessions still renders');
  {
    // Sessions are what mint a project row, so an idle worktree arrives from
    // the registry with an empty session list (`addIdleWorktrees`). It must
    // still nest and still be visible, or exiting the last session inside a
    // worktree looks like the worktree was removed.
    const idle: ProjectNode = {
      ...project('/work/alpha-worktrees/spike', []),
      worktree: true,
      parentDir: '/work/alpha',
    };
    const idleRegistry = fakeRegistry(snapshotOf([alpha, idle]));
    const pins = new PinStore(fakeMemento());
    const provider = new RailTreeProvider(idleRegistry, pins);
    const roots = provider.getChildren();
    check(
      'an idle worktree leaves the root list too',
      !roots.some((node) => node.kind === 'project' && node.dir === idle.dir),
      labels(roots).join(', '),
    );
    const alphaChildren = provider.getChildren(alpha);
    check(
      'and renders under its origin',
      alphaChildren.includes(idle),
      labels(alphaChildren).join(', '),
    );
    check(
      'the origin counts it as a worktree',
      String(provider.getTreeItem(alpha).description).includes('1 worktree'),
      String(provider.getTreeItem(alpha).description),
    );
    const idleItem = provider.getTreeItem(idle);
    check(
      'the row still reads as a worktree',
      idleItem.contextValue === 'project.worktree' && iconId(idleItem) === 'git-branch',
      `${String(idleItem.contextValue)} ${iconId(idleItem)}`,
    );
    check(
      'and claims no sessions in its description',
      !/\d/.test(String(idleItem.description ?? '')),
      String(idleItem.description),
    );

    // The search is over sessions: a row with none cannot match, so it drops
    // out rather than surfacing as a hit.
    provider.setFilter('spike');
    check(
      'a search drops the sessionless worktree',
      !provider.getChildren().some((node) => node.kind === 'project' && node.dir === idle.dir),
      labels(provider.getChildren()).join(', '),
    );
    provider.setFilter('');
    provider.dispose();
  }

  console.log('\nWorktrees and pins');
  {
    const wt: ProjectNode = {
      ...project('/work/alpha-worktrees/fix-auth', ['fix the auth flow']),
      worktree: true,
      parentDir: '/work/alpha',
    };
    const nestedRegistry = fakeRegistry(snapshotOf([alpha, beta, wt]));

    // A pinned worktree renders in the accordion, never twice.
    const pinnedWt = new RailTreeProvider(nestedRegistry, new PinStore(fakeMemento([wt.dir])));
    const section = sectionOf(pinnedWt.getChildren());
    check('a pinned worktree sits in the accordion', section?.projects[0] === wt);
    check(
      'and is not repeated under its origin',
      !pinnedWt.getChildren(alpha).includes(wt),
      String(pinnedWt.getChildren(alpha).length),
    );
    check('its parent is the section, not the origin', pinnedWt.getParent(wt) === section);
    check(
      'and it offers Unpin as a worktree',
      pinnedWt.getTreeItem(wt).contextValue === 'project.worktree.pinned',
    );
    // A worktree outranks a pin for the icon slot: pin state has the accordion,
    // the menu, and the contextValue to say it with; `worktree` has the icon
    // and its description segment.
    check(
      'and keeps the worktree icon while pinned',
      iconId(pinnedWt.getTreeItem(wt)) === 'git-branch',
      iconId(pinnedWt.getTreeItem(wt)),
    );
    pinnedWt.dispose();

    // A pinned origin keeps its worktree nested inside the accordion.
    const pinnedOrigin = new RailTreeProvider(nestedRegistry, new PinStore(fakeMemento([alpha.dir])));
    check(
      'a worktree follows its pinned origin into the accordion',
      pinnedOrigin.getChildren(alpha).includes(wt) && pinnedOrigin.getParent(wt) === alpha,
    );
    check(
      'the reveal chain continues to the section',
      pinnedOrigin.getParent(alpha) === sectionOf(pinnedOrigin.getChildren()),
    );
    pinnedOrigin.dispose();

    // A pinned origin with nothing running still shows its worktrees: the
    // placeholder is the parent, and it must be expandable.
    const orphanRegistry = fakeRegistry(snapshotOf([wt]));
    const placeholderPins = new RailTreeProvider(
      orphanRegistry,
      new PinStore(fakeMemento(['/work/alpha'])),
    );
    const placeholder = sectionOf(placeholderPins.getChildren())?.projects[0];
    check(
      'a placeholder origin carries its worktree',
      placeholder !== undefined && placeholderPins.getChildren(placeholder).includes(wt),
    );
    check(
      'and renders expandable despite having no sessions',
      placeholder !== undefined &&
        placeholderPins.getTreeItem(placeholder).collapsibleState !== 0,
      String(placeholder ? placeholderPins.getTreeItem(placeholder).collapsibleState : 'none'),
    );
    placeholderPins.dispose();
  }

  console.log('\nStored value from another version');
  {
    const pins = new PinStore(fakeMemento({ alpha: true }));
    check('a non-array degrades to no pins', pins.list().length === 0);
    const mixed = new PinStore(fakeMemento(['/work/alpha', 42, '', '/work/alpha']));
    check('junk entries and duplicates are dropped', mixed.list().join(',') === '/work/alpha');
  }

  console.log(`\n${failures === 0 ? 'pins-check: all checks passed' : `pins-check: ${failures} FAILED`}`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

void main();
