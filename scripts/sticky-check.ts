/**
 * Check of the sticky `generating` hold, the icon mapping, and the view header
 * progress bar, run against a stub vscode.
 *
 * Deterministic, like pins-check: the clock is passed in, the nodes are built
 * here, and nothing touches the filesystem. That is allowed because everything
 * under test is the extension's own derivation, not a shape read off disk —
 * `deriveSessionState` reads only its arguments (it does write the hold back
 * onto the `SessionScan` it is handed, which is why the ticks below deliberately
 * share one), the icon table is pure presentation, and `RailProgress` is driven
 * entirely by snapshots handed to it.
 *
 * Run: npm run check:sticky
 */

import type { AgentNode, ProjectNode, SessionNode, Snapshot } from '../src/model/types';
import { deriveSessionState, type RailRegistry, type SessionScan } from '../src/scan/registry';
import { toTreeItem } from '../src/tree/items';
import { RailProgress } from '../src/tree/progress';

const vscodeStub = require('./vscode-stub.js') as {
  __setConfig(key: string, value: unknown): void;
  EventEmitter: new () => { event: unknown; fire(value: unknown): void; dispose(): void };
  progressCalls: { viewId: string | undefined; settled: boolean }[];
};

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  [${ok ? 'pass' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) {
    failures += 1;
  }
}

/**
 * A fresh per-session scan. Annotated with the real `SessionScan` on purpose:
 * `scripts/` is typechecked through tsconfig.scripts.json, so adding a required
 * field in registry.ts breaks this line instead of silently leaving the check
 * asserting against a shape the registry no longer uses.
 */
function scanOf(): SessionScan {
  return {
    spawnIndex: new Map<string, string>(),
    completed: new Set<string>(),
    lastGeneratingTick: undefined,
  };
}

function runningAgent(): AgentNode {
  return {
    kind: 'agent',
    id: 'agent-1',
    agentId: 'agent-1',
    sessionId: 'session-1',
    agentType: 'general-purpose',
    spawnDepth: 1,
    state: 'running',
    toolUseId: 'toolu_1',
    transcriptPath: '/nonexistent/agent-1.jsonl',
    children: [],
  };
}

function iconOf(item: { iconPath?: unknown }): string {
  const icon = item.iconPath as { id?: string; color?: { id?: string } } | undefined;
  return `${icon?.id ?? 'none'}${icon?.color?.id !== undefined ? ` ${icon.color.id}` : ''}`;
}

function session(state: SessionNode['state'], agents: AgentNode[] = []): SessionNode {
  return {
    kind: 'session',
    id: `s-${state}`,
    sessionId: `s-${state}`,
    pid: 1000,
    name: `session-${state}`,
    cwd: '/work/alpha',
    state,
    alive: state !== 'exited',
    source: 'registry',
    agents,
    tasks: [],
  };
}

function project(sessions: SessionNode[]): ProjectNode {
  return {
    kind: 'project',
    id: '/work/alpha',
    name: 'alpha',
    dir: '/work/alpha',
    liveCount: sessions.filter((s) => s.state !== 'exited').length,
    sessions,
  };
}

const T = 1_700_000_000_000;

function snapshotOf(projects: ProjectNode[]): Snapshot {
  return { projects, generatedAt: T, warnings: [] };
}

/** Registry stand-in: RailProgress reads `snapshot()` once and then listens. */
function fakeRegistry(read: () => Snapshot, event: unknown): RailRegistry {
  return { snapshot: read, onDidChange: event } as unknown as RailRegistry;
}

/**
 * The one place this check waits on a real clock. `RailProgress`'s off-delay is a
 * `setTimeout` it owns, so the alternative is injecting a timer into production
 * code for the sake of a check — and the whole point of the delay is that it is
 * short.
 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log('\nSticky generating hold (SESSION_STICKY_MS = 20s, window = 10s)');
  {
    // One session, polled forward on an injected clock. The scan object is the
    // hold's only memory, so it is deliberately reused across the ticks below.
    const scan = scanOf();
    const activityAt = T;

    const inWindow = deriveSessionState(true, [], activityAt, T + 5_000, scan);
    check('activity at t, evaluated at t+5s → generating (activity window)', inWindow === 'generating', inWindow);

    const heldOver = deriveSessionState(true, [], activityAt, T + 15_000, scan);
    check('evaluated at t+15s → generating (hold, window lapsed)', heldOver === 'generating', heldOver);

    const expired = deriveSessionState(true, [], activityAt, T + 31_000, scan);
    check('evaluated at t+31s → idle (hold expired)', expired === 'idle', expired);
  }
  {
    const scan = scanOf();
    deriveSessionState(true, [], T, T + 5_000, scan);
    const dead = deriveSessionState(false, [], T, T + 5_000, scan);
    check('alive === false at t+5s → exited (exit beats the hold)', dead === 'exited', dead);
  }
  {
    // No transcript activity at all, so nothing can arm the hold: the running
    // subagent is the signal, and it is not subject to SESSION_STICKY_MS.
    const scan = scanOf();
    const withAgent = deriveSessionState(true, [runningAgent()], undefined, T + 500_000, scan);
    check(
      'a running subagent with no recent activity → generating regardless of hold',
      withAgent === 'generating',
      withAgent,
    );
  }
  {
    // The hold must anchor on the last time the window fired, not on the last
    // time it returned generating, or a held session re-arms itself forever.
    const scan = scanOf();
    for (let tick = 0; tick <= 28_000; tick += 2_000) {
      deriveSessionState(true, [], T, T + tick, scan);
    }
    const settled = deriveSessionState(true, [], T, T + 31_000, scan);
    check('polling every 2s through the hold does not extend it', settled === 'idle', settled);
  }

  console.log('\nIcon mapping, motion allowed (workbench.reduceMotion: auto)');
  vscodeStub.__setConfig('workbench.reduceMotion', 'auto');
  {
    const generating = session('generating', [runningAgent()]);
    check(
      'a generating session spins',
      iconOf(toTreeItem(generating)) === 'loading~spin sessionRail.working',
      iconOf(toTreeItem(generating)),
    );
    check(
      'a running subagent spins',
      iconOf(toTreeItem(runningAgent())) === 'loading~spin sessionRail.working',
      iconOf(toTreeItem(runningAgent())),
    );
    check(
      'an idle session keeps the static live dot',
      iconOf(toTreeItem(session('idle'))) === 'circle-filled sessionRail.live',
      iconOf(toTreeItem(session('idle'))),
    );
    check(
      'an exited session keeps the static exited dot',
      iconOf(toTreeItem(session('exited'))) === 'circle-filled sessionRail.exited',
      iconOf(toTreeItem(session('exited'))),
    );
    const done: AgentNode = { ...runningAgent(), state: 'done' };
    check(
      'a finished subagent keeps its check',
      iconOf(toTreeItem(done)) === 'pass sessionRail.live',
      iconOf(toTreeItem(done)),
    );

    const working = project([generating, session('idle')]);
    const workingItem = toTreeItem(working, { pinned: true });
    check(
      'a project with a working child spins instead of showing its folder glyph',
      iconOf(workingItem) === 'loading~spin sessionRail.working',
      iconOf(workingItem),
    );
    check(
      'the project description counts the working sessions',
      String(workingItem.description).endsWith('1 working'),
      String(workingItem.description),
    );
    const quiet = toTreeItem(project([session('idle')]), { pinned: true });
    check(
      'a project with nothing working keeps its pinned glyph and no working segment',
      iconOf(quiet) === 'pinned' && !String(quiet.description).includes('working'),
      `${iconOf(quiet)} · ${String(quiet.description)}`,
    );
  }

  console.log('\nIcon mapping, motion suppressed (workbench.reduceMotion: on)');
  vscodeStub.__setConfig('workbench.reduceMotion', 'on');
  {
    const generating = session('generating', [runningAgent()]);
    check(
      'a generating session falls back to a static dot in the working color',
      iconOf(toTreeItem(generating)) === 'circle-filled sessionRail.working',
      iconOf(toTreeItem(generating)),
    );
    check(
      'a running subagent falls back to a static dot in the working color',
      iconOf(toTreeItem(runningAgent())) === 'circle-filled sessionRail.working',
      iconOf(toTreeItem(runningAgent())),
    );
    const workingItem = toTreeItem(project([generating, session('idle')]), { pinned: true });
    check(
      'a project with a working child keeps its pinned glyph',
      iconOf(workingItem) === 'pinned',
      iconOf(workingItem),
    );
    check(
      'the working count is text, so it survives reduceMotion',
      String(workingItem.description).endsWith('1 working'),
      String(workingItem.description),
    );
  }

  console.log('\nSession labels fold title, branch, and name');
  {
    // `name` here equals `sessionId.slice(0, 8)` — the registry's fallback for
    // a record with no name, which is where the branch is allowed to step in.
    const fresh: SessionNode = {
      ...session('idle'),
      sessionId: 'a1b2c3d4-0000-4000-8000-000000000000',
      name: 'a1b2c3d4',
      branch: 'fix-auth',
    };
    const freshItem = toTreeItem(fresh);
    check(
      'a fallback-named session with a branch is labeled by the branch',
      freshItem.label === 'fix-auth',
      String(freshItem.label),
    );
    check(
      'and the branch is not repeated in its description',
      !String(freshItem.description ?? '').includes('fix-auth'),
      String(freshItem.description),
    );
    check(
      'while the fallback name moves into the description',
      String(freshItem.description ?? '').includes('a1b2c3d4'),
      String(freshItem.description),
    );
    const titled = toTreeItem({ ...fresh, title: 'Fix the auth flow' });
    check(
      'a title still beats the branch',
      titled.label === 'Fix the auth flow',
      String(titled.label),
    );
    const named = toTreeItem({ ...fresh, name: 'peaceful-boat' });
    check(
      'a real record name still beats the branch',
      named.label === 'peaceful-boat',
      String(named.label),
    );
    const branchless = toTreeItem({ ...fresh, branch: undefined });
    check(
      'no branch, no title: the fallback name stays',
      branchless.label === 'a1b2c3d4',
      String(branchless.label),
    );
  }

  console.log('\nTooltips name the state in words');
  {
    const generating = session('generating', [runningAgent()]);
    const sessionTip = String((toTreeItem(generating).tooltip as { value?: string }).value);
    check('a working session tooltip has a working line', /working/.test(sessionTip), sessionTip.split('\n').filter((line) => line.includes('working')).join(' | ') || 'absent');
    const agentTip = String((toTreeItem(runningAgent()).tooltip as { value?: string }).value);
    check('a running subagent tooltip has a working line', /working/.test(agentTip), agentTip.split('\n').filter((line) => line.includes('working')).join(' | ') || 'absent');
    const idleTip = String((toTreeItem(session('idle')).tooltip as { value?: string }).value);
    check('an idle session tooltip has none', !/working/.test(idleTip));
  }

  console.log('\nView header progress bar');
  vscodeStub.__setConfig('workbench.reduceMotion', 'auto');
  {
    const emitter = new vscodeStub.EventEmitter();
    const busy = snapshotOf([project([session('generating', [runningAgent()]), session('idle')])]);
    const quiet = snapshotOf([project([session('idle')])]);
    let current = quiet;
    // Read before constructing, or every assertion below that compares against
    // `base` is a tautology — the constructor calls `apply()` itself.
    const base = vscodeStub.progressCalls.length;
    const progress = new RailProgress(fakeRegistry(() => current, emitter.event));

    check('a quiet snapshot raises no bar', vscodeStub.progressCalls.length === base);

    current = busy;
    emitter.fire(current);
    check(
      'the first generating session raises the bar on the rail view',
      vscodeStub.progressCalls.length === base + 1 &&
        vscodeStub.progressCalls[base]?.viewId === 'sessionRail.tree',
      vscodeStub.progressCalls[base]?.viewId ?? 'no call',
    );
    check('and the bar is held, not settled', vscodeStub.progressCalls[base]?.settled === false);

    emitter.fire(current);
    check(
      'a second generating tick does not stack a second bar',
      vscodeStub.progressCalls.length === base + 1,
      String(vscodeStub.progressCalls.length - base),
    );

    current = quiet;
    emitter.fire(current);
    // Both waits straddle RailProgress's 1s off-delay from a single tick, so the
    // margins are 800ms early and 600ms late. Only an event-loop stall wider than
    // that flips either — this is the one check here a loaded machine could make
    // flake.
    await wait(200);
    check(
      'the bar survives the first quiet tick — off-delay, so a one-tick gap cannot strobe it',
      vscodeStub.progressCalls[base]?.settled === false,
    );
    await wait(1_400);
    check(
      'and closes about a second after the last session clears',
      vscodeStub.progressCalls[base]?.settled === true,
    );

    current = busy;
    emitter.fire(current);
    check(
      'it raises again after closing',
      vscodeStub.progressCalls.length === base + 2 &&
        vscodeStub.progressCalls[base + 1]?.settled === false,
    );
    // Dispose with the off-timer still pending — the awkward ordering, and the one
    // the spec's risk table names: a held token plus a live timer. A leaked timer
    // is not observable through this stub (it would only reach `lower()`, which
    // records nothing), so what is asserted is the part that is observable: the
    // held bar settles, and nothing reopens afterwards.
    current = quiet;
    emitter.fire(current);
    progress.dispose();
    await wait(0);
    check(
      'dispose settles a bar that was still held — nothing outlives the extension',
      vscodeStub.progressCalls[base + 1]?.settled === true,
    );
    await wait(1_200);
    check(
      'and nothing reopens after dispose',
      vscodeStub.progressCalls.length === base + 2,
      String(vscodeStub.progressCalls.length - base),
    );
  }

  console.log('\nView header progress bar, motion suppressed (workbench.reduceMotion: on)');
  vscodeStub.__setConfig('workbench.reduceMotion', 'on');
  {
    const emitter = new vscodeStub.EventEmitter();
    const busy = snapshotOf([project([session('generating', [runningAgent()])])]);
    // Before construction, for the reason above — and it matters most here,
    // because this block is the only thing standing behind "the header progress
    // bar never appears" for a user who asked for no motion.
    const base = vscodeStub.progressCalls.length;
    const progress = new RailProgress(fakeRegistry(() => busy, emitter.event));
    check(
      'a generating snapshot raises no bar at construction',
      vscodeStub.progressCalls.length === base,
      String(vscodeStub.progressCalls.length - base),
    );
    emitter.fire(busy);
    check(
      'nor on a change event',
      vscodeStub.progressCalls.length === base,
      String(vscodeStub.progressCalls.length - base),
    );
    progress.dispose();
  }

  console.log(`\n${failures === 0 ? 'sticky-check: all checks passed' : `sticky-check: ${failures} FAILED`}`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

void main();
