/**
 * Shared model for Session Rail.
 *
 * FROZEN CONTRACT — every other module builds against these shapes.
 * Do not edit without updating all consumers (scan/, tree/, status/, transcript/).
 *
 * Two families live here:
 *  - `*Record` / `*Meta` types mirror the raw JSON Claude Code writes to disk.
 *    Every field is optional unless it is present in every observed version,
 *    because ~/.claude is private, unversioned state that drifts between
 *    releases (2.1.216 subagent records carry `slug`; 2.1.233 session records
 *    carry `name`/`nameSource`/`nameSince`).
 *  - `*Node` types are the normalized tree the UI renders.
 */

// ─────────────────────────────────────────────────────────────
// Raw on-disk shapes
// ─────────────────────────────────────────────────────────────

/** `~/.claude/sessions/<pid>.json` — the live session registry. */
export interface SessionRecord {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt?: number;
  /** Human-readable process start, e.g. "Mon Aug 17 14:19:54 2026". Guards PID reuse. */
  procStart?: string;
  version?: string;
  /** "interactive" | others. */
  kind?: string;
  /** "claude-vscode" | "cli" | others. */
  entrypoint?: string;
  messagingSocketPath?: string;
  /** Derived label such as "goshift-d3". Preferred over a truncated UUID. */
  name?: string;
  nameSource?: string;
  nameSince?: number;
}

/**
 * `projects/<enc-cwd>/<sessionId>/subagents/agent-<id>.meta.json`
 *
 * NOTE: the `subagents/` directory is FLAT — every agent of a session lives in
 * it regardless of depth. Parent links come from `toolUseId`, never from
 * directory position. See `spawnDepth` for the reported nesting level.
 */
export interface AgentMeta {
  agentType: string;
  description?: string;
  /** The tool_use id that spawned this agent. The parent-resolution key. */
  toolUseId: string;
  /** 1 = spawned by the session; 2 = spawned by another agent; etc. */
  spawnDepth: number;
}

/** `~/.claude/tasks/<sessionId>/<n>.json` */
export interface TaskRecord {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  /** "pending" | "in_progress" | "completed" — treated as open on unknown values. */
  status?: string;
  /** JSON-encoded array of task ids, e.g. "[]". Yes, a string. */
  blocks?: string;
  blockedBy?: string;
}

/**
 * One parsed line of a `.jsonl` transcript. Only the fields the rail needs are
 * declared; transcripts carry many more.
 */
export interface TranscriptRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  agentId?: string;
  isSidechain?: boolean;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  effort?: string;
  /** Present on tool-use / tool-result records. The agent linkage key. */
  toolUseID?: string;
  /**
   * Present only on `type: "ai-title"` records: Claude Code's own summarized
   * title for the session, the label its VS Code extension shows. Rewritten as
   * the conversation moves on and carries no `timestamp`, so file order is the
   * only ordering — last one in the file wins.
   */
  aiTitle?: string;
  message?: unknown;
}

// ─────────────────────────────────────────────────────────────
// Normalized tree nodes
// ─────────────────────────────────────────────────────────────

export type SessionState = 'generating' | 'idle' | 'waiting' | 'exited';
export type AgentState = 'running' | 'done';
export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface ProjectNode {
  kind: 'project';
  /** Stable id — the absolute project directory. */
  id: string;
  /** Display name — basename of the directory. */
  name: string;
  dir: string;
  sessions: SessionNode[];
  /** Count of sessions whose state is not 'exited'. */
  liveCount: number;
}

export interface SessionNode {
  kind: 'session';
  /** Stable id — the sessionId UUID. */
  id: string;
  sessionId: string;
  pid: number;
  /** Claude Code's own derived name, or a shortened sessionId as fallback. */
  name: string;
  /**
   * Claude Code's summarized title for the conversation ("Deploy API to VPS"),
   * read from the newest `ai-title` record in the transcript. Absent on short
   * sessions that never earned one — the row falls back to `name`. Display
   * only: `name` stays the identity, because it is what the terminal and the
   * row ordering are keyed to and a title is rewritten mid-session.
   */
  title?: string;
  cwd: string;
  state: SessionState;
  alive: boolean;
  /**
   * Where the row came from. `registry` — a `sessions/<pid>.json` record, with a
   * real pid and tailed transcript. `transcript` — recovered from a `.jsonl`
   * alone by `scan/history.ts`: always exited, `pid` 0, no agents or tasks, and
   * no branch/model/effort, because nothing tailed it.
   */
  source: 'registry' | 'transcript';
  branch?: string;
  model?: string;
  effort?: string;
  entrypoint?: string;
  version?: string;
  startedAt?: number;
  /** Timestamp of the newest transcript record seen, ms since epoch. */
  lastActivityAt?: number;
  /** Absolute path to `<sessionId>.jsonl`, when it exists. */
  transcriptPath?: string;
  /** Depth-1 agents only; deeper agents hang off `AgentNode.children`. */
  agents: AgentNode[];
  tasks: TaskNode[];
}

export interface AgentNode {
  kind: 'agent';
  /** Stable id — the agentId from the filename. */
  id: string;
  agentId: string;
  sessionId: string;
  agentType: string;
  description?: string;
  spawnDepth: number;
  toolUseId: string;
  state: AgentState;
  startedAt?: number;
  endedAt?: number;
  transcriptPath: string;
  children: AgentNode[];
}

export interface TaskNode {
  kind: 'task';
  /** Stable id — `${sessionId}:${taskId}`. */
  id: string;
  sessionId: string;
  taskId: string;
  subject: string;
  status: TaskStatus;
  blockedBy: string[];
}

/**
 * The search row: a pseudo-node with no on-disk counterpart, rendered as the
 * first child of the root so it sits directly under the view header. A TreeView
 * has no inline text-input widget, so this row plus an input box is the closest
 * thing to a search field the API allows.
 *
 * Presentation state only — it is built by the tree provider from its own
 * filter, never by the scan layer, and never appears in a `Snapshot`.
 */
export interface FilterNode {
  kind: 'filter';
  /** Stable id — there is only ever one search row. */
  id: 'search';
  /** Active query, trimmed. Empty when nothing is being filtered. */
  query: string;
  /** Sessions the query kept. Meaningless while `query` is empty. */
  matches: number;
}

export type RailNode = ProjectNode | SessionNode | AgentNode | TaskNode | FilterNode;

/** Immutable view of the whole tree at one instant. */
export interface Snapshot {
  projects: ProjectNode[];
  generatedAt: number;
  /** Populated when scanning failed; the UI shows a degraded flat list. */
  warnings: string[];
}

export const EMPTY_SNAPSHOT: Snapshot = Object.freeze({
  projects: [],
  generatedAt: 0,
  warnings: [],
});

// ─────────────────────────────────────────────────────────────
// Helpers shared across modules
// ─────────────────────────────────────────────────────────────

export function normalizeTaskStatus(raw: string | undefined): TaskStatus {
  switch (raw) {
    case 'completed':
      return 'completed';
    case 'in_progress':
      return 'in_progress';
    default:
      return 'pending';
  }
}

/** Task `blocks` / `blockedBy` arrive as JSON-encoded strings. Never throws. */
export function parseIdList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Walk an agent forest depth-first, parents before children. */
export function walkAgents(
  agents: readonly AgentNode[],
  visit: (agent: AgentNode) => void,
): void {
  for (const agent of agents) {
    visit(agent);
    walkAgents(agent.children, visit);
  }
}
