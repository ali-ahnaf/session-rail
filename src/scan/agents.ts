/**
 * Subagent metadata and the agent forest for one session.
 *
 * `projects/<enc-cwd>/<sessionId>/subagents/` is FLAT: every agent of the session
 * lives there whatever its depth, so nesting cannot be read off the directory.
 * Parent links come from `meta.toolUseId` resolved through a spawn index that
 * says which transcript emitted that tool_use id — the session's own transcript
 * (depth 1) or another agent's transcript (depth 2+). Verified against a real
 * depth-2 agent.
 *
 * Inferred-behavior risk:
 *  - The spawning tool is named `Agent` in observed data (not `Task`), so nothing
 *    here filters on a tool name; the registry indexes every tool_use id.
 *  - Newer metas carry an undocumented `parentAgentId` (present on all 4 observed
 *    depth-2 metas, absent on all 90 depth-1 metas). It is read as a FALLBACK
 *    only, for when the spawn index misses the id — e.g. after a cold start that
 *    seeded just the tail of a long transcript.
 *  - `spawnDepth` is reported by Claude Code and is preserved verbatim; it can
 *    disagree with the computed position when a parent cannot be resolved.
 */

import * as fs from 'fs';

import { AgentMeta, AgentNode, AgentState } from '../model/types';
import { log } from '../util/log';
import { agentIdFromFilename, agentMetaPath, agentTranscriptPath, subagentsDir } from './paths';

/** Metas plus the undocumented `parentAgentId` hints, read in a single pass. */
export interface AgentMetaScan {
  metas: Map<string, AgentMeta>;
  /** agentId → parentAgentId, only for metas that declare one. */
  parents: Map<string, string>;
}

/** agentId → meta for every readable `agent-<id>.meta.json` of a session. */
export function readAgentMetas(cwd: string, sessionId: string): Map<string, AgentMeta> {
  return readAgentMetaScan(cwd, sessionId).metas;
}

/** As `readAgentMetas`, but also returns the `parentAgentId` fallback hints. */
export function readAgentMetaScan(cwd: string, sessionId: string): AgentMetaScan {
  const scan: AgentMetaScan = { metas: new Map(), parents: new Map() };
  const dir = subagentsDir(cwd, sessionId);
  if (!dir) {
    return scan;
  }

  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // No subagents directory: the session simply never spawned one.
    return scan;
  }

  for (const name of names) {
    if (!name.endsWith('.meta.json')) {
      continue;
    }
    const agentId = agentIdFromFilename(name);
    if (!agentId) {
      continue;
    }
    const parsed = readMetaFile(agentMetaPath(dir, agentId));
    if (!parsed) {
      continue;
    }
    scan.metas.set(agentId, parsed.meta);
    if (parsed.parentAgentId) {
      scan.parents.set(agentId, parsed.parentAgentId);
    }
  }
  return scan;
}

/**
 * Depth-1 roots with `children` filled in recursively.
 *
 * `spawnIndex` maps a tool_use id to the id of whoever emitted it: the sessionId
 * for the session's own transcript, an agentId for an agent transcript.
 *
 * Three edge cases are handled explicitly, all by rooting the agent so it stays
 * visible: (a) the toolUseId is absent from the index, (b) the parent chain forms
 * a cycle, (c) the resolved parent is not among `metas`.
 */
export function buildAgentForest(
  cwd: string,
  sessionId: string,
  metas: ReadonlyMap<string, AgentMeta>,
  spawnIndex: ReadonlyMap<string, string>,
  parentHints?: ReadonlyMap<string, string>,
): AgentNode[] {
  const dir = subagentsDir(cwd, sessionId);
  if (!dir || metas.size === 0) {
    return [];
  }

  const nodes = new Map<string, AgentNode>();
  for (const [agentId, meta] of metas) {
    const transcriptPath = agentTranscriptPath(dir, agentId);
    nodes.set(agentId, {
      kind: 'agent',
      id: agentId,
      agentId,
      sessionId,
      agentType: meta.agentType,
      description: meta.description,
      spawnDepth: meta.spawnDepth,
      toolUseId: meta.toolUseId,
      state: 'running',
      startedAt: transcriptStartedAt(transcriptPath),
      transcriptPath,
      children: [],
    });
  }

  const parentOf = new Map<string, string | undefined>();
  for (const [agentId, meta] of metas) {
    parentOf.set(agentId, resolveParent(agentId, meta, sessionId, nodes, spawnIndex, parentHints));
  }
  breakCycles(parentOf);

  const roots: AgentNode[] = [];
  for (const [agentId, node] of nodes) {
    const parentId = parentOf.get(agentId);
    const parent = parentId === undefined ? undefined : nodes.get(parentId);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  sortForest(roots);
  return roots;
}

/**
 * `done` once the agent's own spawning tool_use id has a recorded result.
 *
 * Pure by design: it cannot tell "never completed" from "completion scrolled out
 * of the seeded window", so the registry additionally requires recent transcript
 * activity before it trusts a `running` verdict.
 */
export function agentState(
  agent: AgentNode,
  completedToolUseIds: ReadonlySet<string>,
): AgentState {
  if (agent.toolUseId.length > 0 && completedToolUseIds.has(agent.toolUseId)) {
    return 'done';
  }
  return 'running';
}

interface ParsedMeta {
  meta: AgentMeta;
  parentAgentId?: string;
}

function readMetaFile(file: string): ParsedMeta | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    log.debug(`agents: skipping ${file}: ${describe(error)}`);
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log.debug(`agents: unexpected shape in ${file}`);
    return undefined;
  }

  const raw = parsed as Record<string, unknown>;
  const agentType = raw['agentType'];
  if (typeof agentType !== 'string' || agentType.length === 0) {
    log.debug(`agents: missing agentType in ${file}`);
    return undefined;
  }

  const toolUseId = raw['toolUseId'];
  const description = raw['description'];
  const spawnDepth = raw['spawnDepth'];
  const parentAgentId = raw['parentAgentId'];

  return {
    meta: {
      agentType,
      description: typeof description === 'string' ? description : undefined,
      // An agent without a toolUseId cannot be linked; it is kept and rooted
      // rather than dropped, because hiding a real agent is worse.
      toolUseId: typeof toolUseId === 'string' ? toolUseId : '',
      spawnDepth:
        typeof spawnDepth === 'number' && Number.isFinite(spawnDepth) ? spawnDepth : 1,
    },
    parentAgentId:
      typeof parentAgentId === 'string' && parentAgentId.length > 0 ? parentAgentId : undefined,
  };
}

/** Returns the parent agentId, or undefined to mean "hang off the session". */
function resolveParent(
  agentId: string,
  meta: AgentMeta,
  sessionId: string,
  nodes: ReadonlyMap<string, AgentNode>,
  spawnIndex: ReadonlyMap<string, string>,
  parentHints?: ReadonlyMap<string, string>,
): string | undefined {
  const owner = meta.toolUseId.length > 0 ? spawnIndex.get(meta.toolUseId) : undefined;

  if (owner === undefined) {
    // (a) Not in the index — the spawning record predates our read window.
    const hint = parentHints?.get(agentId);
    if (hint && hint !== agentId && nodes.has(hint)) {
      log.debug(`agents: ${agentId} not in spawn index; using parentAgentId hint ${hint}`);
      return hint;
    }
    log.debug(
      `agents: no spawn index entry for ${agentId} (toolUseId "${meta.toolUseId}"); attaching at session root`,
    );
    return undefined;
  }

  if (owner === sessionId || owner === agentId) {
    return undefined;
  }

  if (!nodes.has(owner)) {
    // (c) The emitter is not an agent of this session (or its meta is missing).
    log.debug(`agents: parent ${owner} of ${agentId} has no meta; attaching at session root`);
    return undefined;
  }
  return owner;
}

/** (b) Root the first agent found on a cycle so the forest can be built at all. */
function breakCycles(parentOf: Map<string, string | undefined>): void {
  for (const agentId of parentOf.keys()) {
    const seen = new Set<string>([agentId]);
    let current = parentOf.get(agentId);
    while (current !== undefined) {
      if (seen.has(current)) {
        log.warn(
          `agents: parent cycle involving ${agentId} -> ${current}; attaching ${agentId} at session root`,
        );
        parentOf.set(agentId, undefined);
        break;
      }
      seen.add(current);
      current = parentOf.get(current);
    }
  }
}

function sortForest(agents: AgentNode[]): void {
  agents.sort(compareAgents);
  for (const agent of agents) {
    sortForest(agent.children);
  }
}

function compareAgents(left: AgentNode, right: AgentNode): number {
  const leftStart = left.startedAt ?? Number.MAX_SAFE_INTEGER;
  const rightStart = right.startedAt ?? Number.MAX_SAFE_INTEGER;
  if (leftStart !== rightStart) {
    return leftStart - rightStart;
  }
  return left.agentId.localeCompare(right.agentId);
}

/** Creation time of the agent transcript — the closest thing to a spawn time on disk. */
function transcriptStartedAt(file: string): number | undefined {
  try {
    const stat = fs.statSync(file);
    const birth = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
    return Number.isFinite(birth) ? Math.round(birth) : undefined;
  } catch {
    return undefined;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
