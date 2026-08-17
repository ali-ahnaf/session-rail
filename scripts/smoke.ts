/**
 * Smoke test for the scan layer, run against the real ~/.claude on this machine.
 *
 * Not a unit test — there are no fixtures. It asserts the invariants that matter
 * against live state, including one hand-verified ground truth: in session
 * c5476e2d the agent a316978cce571e28e is a depth-2 child of ac4f0c9f15b73b541,
 * confirmed by matching toolUseId before any of this code existed.
 *
 * Run: npm run smoke
 */

import * as fs from 'fs';
import * as path from 'path';

import type { AgentNode, TranscriptRecord } from '../src/model/types';
import { walkAgents } from '../src/model/types';
import { buildAgentForest, readAgentMetas } from '../src/scan/agents';
import {
  agentIdFromFilename,
  resolveProjectDir,
  sessionTranscriptPath,
  subagentsDir,
} from '../src/scan/paths';
import { isAlive, readSessionRecords } from '../src/scan/sessions';
import { readTasks } from '../src/scan/tasks';
import { Tailer, readTailRecords } from '../src/scan/tailer';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  const mark = ok ? 'pass' : 'FAIL';
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) {
    failures += 1;
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/**
 * Content blocks of one transcript record, or an empty array for any shape we
 * don't recognize. `message` is `unknown` and `content` is sometimes a plain
 * string, so every step is guarded.
 */
function contentBlocks(record: TranscriptRecord): Record<string, unknown>[] {
  const message = record.message;
  if (typeof message !== 'object' || message === null) {
    return [];
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(
    (block): block is Record<string, unknown> => typeof block === 'object' && block !== null,
  );
}

interface SpawnScan {
  /** toolUseId → the sessionId or agentId that emitted it. */
  index: Map<string, string>;
  /** toolUseIds that have a recorded tool_result. */
  completed: Set<string>;
}

/**
 * Rebuild the spawn index from real transcript evidence.
 *
 * The edge lives in `message.content[]`, NOT in the top-level `toolUseID` field
 * (which is null on these records). A `tool_use` block means the transcript's
 * owner spawned that id; a `tool_result` block means it finished. Deliberately
 * does not filter on the tool's `name` — it is `Agent` in some versions and
 * `Task` in others, and filtering on it is what hid this bug the first time.
 */
function scanSpawns(cwd: string, sessionId: string): SpawnScan {
  const index = new Map<string, string>();
  const completed = new Set<string>();
  const budget = 4 * 1024 * 1024;

  const absorb = (file: string, owner: string): void => {
    for (const record of readTailRecords(file, budget)) {
      if (record.toolUseID) {
        index.set(record.toolUseID, owner);
      }
      for (const block of contentBlocks(record)) {
        const id = block.id;
        const resultId = block.tool_use_id;
        if (block.type === 'tool_use' && typeof id === 'string') {
          index.set(id, owner);
        } else if (block.type === 'tool_result' && typeof resultId === 'string') {
          completed.add(resultId);
        }
      }
    }
  };

  const sessionTranscript = sessionTranscriptPath(cwd, sessionId);
  if (sessionTranscript && fs.existsSync(sessionTranscript)) {
    absorb(sessionTranscript, sessionId);
  }

  const dir = subagentsDir(cwd, sessionId);
  if (dir && fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) {
        continue;
      }
      const agentId = agentIdFromFilename(name);
      if (agentId) {
        absorb(path.join(dir, name), agentId);
      }
    }
  }

  return { index, completed };
}

function findAgent(roots: readonly AgentNode[], agentId: string): AgentNode | undefined {
  let found: AgentNode | undefined;
  walkAgents(roots, (agent) => {
    if (agent.agentId === agentId) {
      found = agent;
    }
  });
  return found;
}

function parentOf(roots: readonly AgentNode[], agentId: string): AgentNode | undefined {
  let parent: AgentNode | undefined;
  walkAgents(roots, (agent) => {
    if (agent.children.some((child) => child.agentId === agentId)) {
      parent = agent;
    }
  });
  return parent;
}

// ─────────────────────────────────────────────────────────────

section('Session registry');

const records = readSessionRecords();
check('reads session records', records.length > 0, `${records.length} found`);
check(
  'every record has pid, sessionId, cwd',
  records.every((r) => r.pid > 0 && r.sessionId.length > 0 && r.cwd.length > 0),
);

const live = records.filter(isAlive);
check('liveness probe returns a plausible subset', live.length <= records.length,
  `${live.length}/${records.length} alive`);
for (const record of live.slice(0, 6)) {
  console.log(`         ${record.name ?? record.sessionId.slice(0, 8)}  pid=${record.pid}  ${record.cwd}`);
}

check(
  'a dead pid is reported dead',
  !isAlive({ pid: 999999, sessionId: 'x', cwd: '/tmp' }),
);

section('Project directory resolution');

for (const record of records.slice(0, 5)) {
  const dir = resolveProjectDir(record.cwd);
  check(`resolves ${path.basename(record.cwd)}`, dir !== undefined, dir ?? 'not found');
}

section('Agent forest — hand-verified ground truth');

const TRUTH_CWD = '/Users/aliahnaf/Sharebox/sharebox-webadmin/web-automation';
const TRUTH_SESSION = 'c5476e2d-a88c-46a0-b898-0b81d3204bf7';
const TRUTH_CHILD = 'a316978cce571e28e';
const TRUTH_PARENT = 'ac4f0c9f15b73b541';

const metas = readAgentMetas(TRUTH_CWD, TRUTH_SESSION);
check('reads agent metas', metas.size > 0, `${metas.size} agents`);

const depths = [...metas.values()].map((m) => m.spawnDepth);
check('sees a depth-2 agent', depths.includes(2), `depths present: ${[...new Set(depths)].sort().join(', ')}`);

const { index: spawnIndex, completed } = scanSpawns(TRUTH_CWD, TRUTH_SESSION);
check('builds a spawn index from transcripts', spawnIndex.size > 0, `${spawnIndex.size} toolUseIds`);
check(
  'index covers every agent’s spawning toolUseId',
  [...metas.values()].every((m) => spawnIndex.has(m.toolUseId)),
  `${[...metas.values()].filter((m) => spawnIndex.has(m.toolUseId)).length}/${metas.size} covered`,
);
check('records tool_result completions', completed.size > 0, `${completed.size} completed`);

const forest = buildAgentForest(TRUTH_CWD, TRUTH_SESSION, metas, spawnIndex);
check('forest has roots', forest.length > 0, `${forest.length} roots`);

let total = 0;
walkAgents(forest, () => {
  total += 1;
});
check('forest contains every agent exactly once', total === metas.size, `${total} of ${metas.size}`);

const child = findAgent(forest, TRUTH_CHILD);
check('depth-2 agent is present in the forest', child !== undefined);

const realParent = parentOf(forest, TRUTH_CHILD);
check(
  'depth-2 agent nests under the correct parent',
  realParent?.agentId === TRUTH_PARENT,
  realParent ? `parent=${realParent.agentId}` : 'no parent — attached at root',
);

check(
  'no depth-2 agent is left at the root',
  !forest.some((a) => a.spawnDepth > 1),
  `roots: ${forest.map((a) => `${a.agentType}(d${a.spawnDepth})`).join(', ')}`,
);

section('Tasks');

const tasks = readTasks(TRUTH_SESSION);
check('reads tasks for a session that has them', tasks.length > 0, `${tasks.length} tasks`);
check(
  'task ids are namespaced by session',
  tasks.every((t) => t.id.startsWith(`${TRUTH_SESSION}:`)),
);
check(
  'statuses normalize to the closed set',
  tasks.every((t) => ['pending', 'in_progress', 'completed'].includes(t.status)),
  [...new Set(tasks.map((t) => t.status))].join(', '),
);
check('missing task dir yields no tasks', readTasks('no-such-session-id').length === 0);

section('Tailer');

const tailTarget = sessionTranscriptPath(TRUTH_CWD, TRUTH_SESSION);
if (tailTarget && fs.existsSync(tailTarget)) {
  const sizeMb = (fs.statSync(tailTarget).size / 1024 / 1024).toFixed(1);
  const tailer = new Tailer();

  const first = tailer.readDelta(tailTarget);
  check('cold read returns records', first.length > 0, `${first.length} records from ${sizeMb} MB`);

  const second = tailer.readDelta(tailTarget);
  check('second read returns nothing new', second.length === 0, `${second.length} records`);

  tailer.reset(tailTarget);
  const third = tailer.readDelta(tailTarget);
  check('reset replays from the start', third.length === first.length);

  const parsedAll = first.every((r: TranscriptRecord) => typeof r === 'object' && r !== null);
  check('every returned record is an object', parsedAll);

  tailer.dispose();
} else {
  check('transcript exists to tail', false, 'not found');
}

check('tailing a nonexistent file is safe', new Tailer().readDelta('/tmp/session-rail-does-not-exist.jsonl').length === 0);

// ─────────────────────────────────────────────────────────────

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
