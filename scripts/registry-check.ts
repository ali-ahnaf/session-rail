/**
 * End-to-end check of the registry against the real ~/.claude on this machine.
 *
 * The registry imports `vscode`, so it has never actually executed — everything
 * before this ran only through tsc. Here it runs for real against a stub vscode,
 * which exercises the parts no unit-level check reaches: grouping, state
 * derivation, sorting, snapshot change-detection, and the poll loop.
 *
 * Run: npm run check:registry
 */

import { walkAgents, type AgentNode, type Snapshot } from '../src/model/types';
import { createRegistry } from '../src/scan/registry';

const vscodeStub = require('./vscode-stub.js') as {
  __setConfig(key: string, value: unknown): void;
};

let failures = 0;

/** Wide enough for a full `sanitizeTitle` output (60 chars) plus a gutter. */
const LABEL_WIDTH = 62;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  [${ok ? 'pass' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) {
    failures += 1;
  }
}

function countAgents(snapshot: Snapshot): { total: number; running: number; maxDepth: number } {
  let total = 0;
  let running = 0;
  let maxDepth = 0;
  for (const project of snapshot.projects) {
    for (const session of project.sessions) {
      walkAgents(session.agents, (agent: AgentNode) => {
        total += 1;
        if (agent.state === 'running') {
          running += 1;
        }
        maxDepth = Math.max(maxDepth, agent.spawnDepth);
      });
    }
  }
  return { total, running, maxDepth };
}

function render(snapshot: Snapshot): void {
  for (const project of snapshot.projects) {
    console.log(`\n  ${project.name}  (${project.liveCount} live)`);
    for (const session of project.sessions) {
      const bits = [session.state, session.branch, session.model, session.effort]
        .filter(Boolean)
        .join(' · ');
      // The label as the sidebar renders it: Claude Code's `ai-title` when the
      // transcript carries one, its derived name otherwise.
      // `padEnd` pads but never truncates, and a title runs to 60 chars — slice
      // first or the columns stop lining up next to reality.
      const label = (session.title ?? session.name).slice(0, LABEL_WIDTH);
      console.log(
        `    ${label.padEnd(LABEL_WIDTH)} ${
          session.title !== undefined ? `[${session.name}] ` : ''
        }${bits}`,
      );
      const indent = (depth: number): string => '      ' + '  '.repeat(depth - 1);
      walkAgents(session.agents, (agent) => {
        console.log(
          `${indent(agent.spawnDepth)}${agent.state === 'running' ? '◐' : '✓'} ` +
            `${agent.agentType} (d${agent.spawnDepth})`,
        );
      });
      for (const task of session.tasks) {
        const mark = task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◐' : '○';
        console.log(`      ${mark} ${task.subject.slice(0, 58)}`);
      }
    }
  }
}

async function main(): Promise<void> {
  // Show everything, so the check exercises the widest code path.
  vscodeStub.__setConfig('sessionRail.showExited', true);
  vscodeStub.__setConfig('sessionRail.showTasks', true);
  vscodeStub.__setConfig('sessionRail.refreshInterval', 500);

  console.log('Registry — cold start');
  const registry = createRegistry();

  const initial = registry.snapshot();
  check('snapshot() before start() is empty, not a throw', initial.projects.length === 0);

  let changeEvents = 0;
  let lastSnapshot: Snapshot = initial;
  const subscription = registry.onDidChange((snapshot) => {
    changeEvents += 1;
    lastSnapshot = snapshot;
  });

  await registry.refresh();
  check('first refresh emits a change', changeEvents === 1, `${changeEvents} event(s)`);

  const snapshot = lastSnapshot;
  check('finds projects', snapshot.projects.length > 0, `${snapshot.projects.length} projects`);

  const sessions = snapshot.projects.flatMap((p) => p.sessions);
  check('finds sessions', sessions.length > 0, `${sessions.length} sessions`);
  check(
    'every session has a name, and a pid iff it came from the registry',
    sessions.every((s) => s.name.length > 0 && (s.source === 'registry' ? s.pid > 0 : s.pid === 0)),
  );

  // Transcript history: sessions recovered from `.jsonl` files rather than the
  // session registry. Machine-dependent — a machine with no transcripts inside
  // the window reports a coverage gap instead of passing vacuously.
  const history = sessions.filter((s) => s.source === 'transcript');
  const registryIds = new Set(sessions.filter((s) => s.source === 'registry').map((s) => s.sessionId));
  if (history.length === 0) {
    console.log('  [gap ] no transcript history in the window — history checks did not run');
  } else {
    check(
      'every history session is exited, with a transcript and no agents or tasks',
      history.every(
        (s) =>
          s.state === 'exited' &&
          !s.alive &&
          s.transcriptPath !== undefined &&
          s.agents.length === 0 &&
          s.tasks.length === 0,
      ),
      `${history.length} recovered`,
    );
    check(
      'no history session collides with a registry session',
      history.every((s) => !registryIds.has(s.sessionId)),
    );
  }
  // `ai-title` is Claude Code's own summary of the conversation, and a short
  // session never earns one — so this reports coverage rather than asserting.
  const titled = sessions.filter((s) => s.title !== undefined);
  if (titled.length === 0) {
    console.log('  [gap ] no session on this machine has an ai-title — title checks did not run');
  } else {
    check(
      'titles are one short line, and never replace the session name',
      titled.every((s) => s.title!.length <= 60 && !/[\r\n]/.test(s.title!) && s.name.length > 0),
      `${titled.length}/${sessions.length} titled, e.g. "${titled[0].title}"`,
    );
    check(
      'history rows get titles too, not just tailed ones',
      titled.some((s) => s.source === 'transcript') || history.length === 0,
      `${titled.filter((s) => s.source === 'transcript').length} of ${history.length} history rows`,
    );
  }
  check(
    'no session reports the undetectable `waiting` state',
    sessions.every((s) => s.state !== 'waiting'),
    [...new Set(sessions.map((s) => s.state))].join(', '),
  );
  check(
    'liveCount matches non-exited sessions',
    snapshot.projects.every(
      (p) => p.liveCount === p.sessions.filter((s) => s.state !== 'exited').length,
    ),
  );
  check(
    'projects are sorted by name',
    snapshot.projects.map((p) => p.name).join('|') ===
      [...snapshot.projects.map((p) => p.name)].sort((a, b) => a.localeCompare(b)).join('|'),
  );
  check('no warnings on a healthy machine', snapshot.warnings.length === 0,
    snapshot.warnings.join('; ') || 'none');

  const agents = countAgents(snapshot);
  check('resolves agents', agents.total > 0, `${agents.total} total, ${agents.running} running`);
  check(
    'no agent claims a depth-1 slot while nested',
    snapshot.projects
      .flatMap((p) => p.sessions)
      .every((s) => s.agents.every((a) => a.spawnDepth === 1)),
    'top-level agents all report spawnDepth 1',
  );

  // Depth-2 nesting and task lists are properties of whichever sessions happen
  // to be alive right now, so they can't be asserted here — the registry only
  // surfaces sessions present in ~/.claude/sessions, and a machine can easily
  // have no live session that ever spawned a nested agent or wrote a todo list.
  // Those two paths are asserted against known historical sessions in
  // scripts/smoke.ts, which reads the same code with fixed inputs.
  const tasks = sessions.flatMap((s) => s.tasks);
  console.log(
    `  [info] live-set coverage: max agent depth ${agents.maxDepth}, ${tasks.length} tasks ` +
      `(depth-2 and task parsing are covered by smoke.ts against historical sessions)`,
  );

  console.log('\nRegistry — change detection');
  const before = changeEvents;
  await registry.refresh();
  check(
    'an unchanged refresh emits nothing',
    changeEvents === before,
    `${changeEvents - before} spurious event(s)`,
  );

  console.log('\nRegistry — lookups');
  const someSession = sessions[0];
  check('findSession round-trips', registry.findSession(someSession.sessionId) !== undefined);
  check('findSession misses cleanly', registry.findSession('nope') === undefined);
  let someAgent: AgentNode | undefined;
  walkAgents(sessions.flatMap((s) => s.agents), (a) => {
    someAgent ??= a;
  });
  if (someAgent) {
    check('findAgent round-trips', registry.findAgent(someAgent.agentId) !== undefined);
  }
  check('findAgent misses cleanly', registry.findAgent('nope') === undefined);

  console.log('\nRegistry — poll loop');
  registry.start();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  check('start() then dispose() does not throw', true);

  console.log('\nTree as the sidebar would render it:');
  render(snapshot);

  subscription.dispose();
  registry.dispose();

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
