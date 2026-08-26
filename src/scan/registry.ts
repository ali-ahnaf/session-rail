/**
 * The scan orchestrator: polls ~/.claude, builds the project → session → agent →
 * task tree, and fires `onDidChange` only when the tree materially changed.
 *
 * Per-session scan state (spawn index, completed tool_use ids, sticky branch /
 * effort / version / model, per-file last-activity) PERSISTS across ticks. That is
 * essential, not an optimization: a tool_use record is seen exactly once, in the
 * delta of the tick during which it was appended, and never again.
 *
 * Inferred-behavior risks, all measured on real transcripts:
 *  - Spawn ids live in `message.content[].id` of `tool_use` blocks, not in the
 *    top-level `toolUseID` field (which observed data uses for hook attachments).
 *    Completions live in `message.content[].tool_use_id` of `tool_result` blocks.
 *    Substring matching would be wrong: `queue-operation` records in the main
 *    transcript quote a depth-2 tool id and would misattribute it to the session.
 *  - Absence of a completion record is not evidence that an agent is running, so
 *    `running` additionally requires recent transcript activity.
 *  - `waiting` is not detectable from disk in v1 and is never emitted.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  AgentMeta,
  AgentNode,
  EMPTY_SNAPSHOT,
  ProjectNode,
  SessionNode,
  SessionRecord,
  SessionState,
  Snapshot,
  TaskNode,
  TranscriptRecord,
  walkAgents,
} from '../model/types';
import { log, safelyAsync } from '../util/log';
import { agentState, buildAgentForest, readAgentMetaScan } from './agents';
import { readHistorySessions } from './history';
import { agentIdFromFilename, sessionTranscriptPath, sessionsDir, subagentsDir } from './paths';
import { isAlive, readSessionRecords } from './sessions';
import { Tailer } from './tailer';
import { readTasks } from './tasks';
import { forgetTitles, readAiTitle, sanitizeTitle } from './titles';
import { isWorktreeDir, mainRepoFor, worktreesOf } from './worktree';

export interface RailRegistry extends vscode.Disposable {
  readonly onDidChange: vscode.Event<Snapshot>;
  snapshot(): Snapshot;
  start(): void;
  refresh(): Promise<void>;
  findSession(sessionId: string): SessionNode | undefined;
  findAgent(agentId: string): AgentNode | undefined;
}

export function createRegistry(): RailRegistry {
  return new Registry();
}

const DEFAULT_INTERVAL_MS = 2000;
const MIN_INTERVAL_MS = 500;
const MAX_INTERVAL_MS = 30_000;

/**
 * Floor on the poll interval while this window is unfocused.
 *
 * Every VS Code window runs its own registry over the same machine-wide
 * `~/.claude`, so N windows do N times the identical scanning — the one cost in
 * this extension that grows with how the user works rather than with how much
 * Claude Code is running. An unfocused window is one nobody is reading, so it
 * polls at this floor instead (a configured interval already longer than it
 * wins, hence a floor and not a fixed value).
 *
 * Deliberately below `SESSION_STICKY_MS`: the sticky `generating` hold is
 * anchored on a tick, so an idle cadence at or above 20 s would stop the hold
 * contributing anything and reintroduce the mid-turn spinner blink. Raising
 * this past that means re-reading `deriveSessionState`.
 *
 * Nothing is observably stale, because regaining focus refreshes immediately
 * rather than waiting out the pending timer.
 */
const IDLE_INTERVAL_MS = 15_000;

/** Bytes of transcript tail read on a cold start, per file. */
const COLD_START_BYTES = 512 * 1024;

/** A session is "generating" if the transcript moved within this window. */
const SESSION_ACTIVE_WINDOW_MS = 10_000;

/**
 * How long a session keeps reporting `generating` after the activity window
 * last fired. Absorbs the quiet gaps inside a single turn — a long tool call
 * writes nothing to the transcript, and a spinner that blinks off mid-turn
 * reads as a bug. `alive === false` still wins immediately.
 */
const SESSION_STICKY_MS = 20_000;

/** An agent claimed to be running must also have written within this window. */
const AGENT_ACTIVE_WINDOW_MS = 120_000;

/** Bound per-session index growth on pathologically long sessions. */
const MAX_INDEX_ENTRIES = 50_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Upper bound on `historyDays`; past this the sidebar is a filing cabinet. */
const MAX_HISTORY_DAYS = 90;

interface RailConfig {
  refreshInterval: number;
  groupBy: 'cwd' | 'gitRoot';
  showTasks: boolean;
  showExited: boolean;
  /** Days of transcript history to surface alongside exited records; 0 disables. */
  historyDays: number;
}

/**
 * Everything we remember about one session between ticks.
 *
 * Exported only so scripts/sticky-check.ts can annotate the value it hands to
 * `deriveSessionState` — `scripts/` sits outside `tsconfig`'s `include`, so an
 * unannotated literal there would keep compiling after a field was added here.
 * Still registry-private in the sense that matters: it is not in
 * `src/model/types.ts` and nothing in `tree/` or `status/` may read it.
 */
export interface SessionScan {
  /** tool_use id → emitter (this sessionId, or an agentId). */
  spawnIndex: Map<string, string>;
  /** tool_use ids that have a recorded result. */
  completed: Set<string>;
  branch?: string;
  effort?: string;
  version?: string;
  model?: string;
  /** Newest `ai-title` seen in the main transcript. */
  title?: string;
  capped?: boolean;
  /** Last tick at which the activity window fired, for SESSION_STICKY_MS. */
  lastGeneratingTick?: number;
}

class Registry implements RailRegistry {
  private readonly emitter = new vscode.EventEmitter<Snapshot>();
  readonly onDidChange = this.emitter.event;

  private readonly tailer = new Tailer();
  private readonly scans = new Map<string, SessionScan>();
  /** sessionId → the one cold `ai-title` read, `undefined` when it found none. */
  private readonly coldTitles = new Map<string, string | undefined>();
  /** transcript file → newest record timestamp ever seen in it (ms). */
  private readonly activity = new Map<string, number>();
  private readonly gitRoots = new Map<string, string | undefined>();
  /** dir → worktree marker plus the main repo it links to, memoized like gitRoots. */
  private readonly worktreeMeta = new Map<string, { worktree: boolean; parentDir?: string }>();
  private readonly sessionIndex = new Map<string, SessionNode>();
  private readonly agentIndex = new Map<string, AgentNode>();

  private current: Snapshot = EMPTY_SNAPSHOT;
  private signature = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<void> | undefined;
  private started = false;
  private disposed = false;
  /** Whether this window has focus; drives the poll cadence, nothing else. */
  private focused: boolean;
  private readonly focusSub: vscode.Disposable;

  constructor() {
    this.focused = vscode.window.state.focused;
    this.focusSub = vscode.window.onDidChangeWindowState((state) => {
      this.onFocusChange(state.focused);
    });
  }

  snapshot(): Snapshot {
    return this.current;
  }

  start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    void this.refresh();
    this.scheduleNext();
  }

  /** Rescan now. Concurrent callers share the in-flight pass; never throws. */
  async refresh(): Promise<void> {
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = safelyAsync<void>(
      'sessionRail: refresh failed',
      () => this.refreshOnce(),
      undefined,
    );
    try {
      await this.inflight;
    } finally {
      this.inflight = undefined;
    }
  }

  findSession(sessionId: string): SessionNode | undefined {
    return this.sessionIndex.get(sessionId);
  }

  findAgent(agentId: string): AgentNode | undefined {
    return this.agentIndex.get(agentId);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.focusSub.dispose();
    this.tailer.dispose();
    this.scans.clear();
    this.activity.clear();
    this.gitRoots.clear();
    this.worktreeMeta.clear();
    this.emitter.dispose();
  }

  /** Chained timeouts rather than setInterval, so a config change applies live. */
  private scheduleNext(): void {
    if (this.disposed) {
      return;
    }
    const configured = readConfig().refreshInterval;
    const delay = this.focused ? configured : Math.max(configured, IDLE_INTERVAL_MS);
    this.timer = setTimeout(() => {
      void this.tick();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Re-cadence on focus. Gaining focus catches up *now* rather than serving the
   * idle snapshot until the pending long timer fires — so the slower cadence is
   * only ever observable in a window the user is not looking at.
   */
  private onFocusChange(focused: boolean): void {
    if (this.disposed || focused === this.focused) {
      return;
    }
    this.focused = focused;
    if (!this.started) {
      return;
    }
    this.clearTimer();
    if (focused) {
      void this.tick();
    } else {
      this.scheduleNext();
    }
  }

  private async tick(): Promise<void> {
    if (this.disposed) {
      return;
    }
    // Skip the tick entirely when the previous pass is still running.
    if (!this.inflight) {
      await this.refresh();
    }
    this.scheduleNext();
  }

  private async refreshOnce(): Promise<void> {
    const config = readConfig();
    const warnings: string[] = [];
    const now = Date.now();

    if (!isDirectory(sessionsDir())) {
      this.publish({ projects: [], generatedAt: now, warnings: [noRegistryWarning()] });
      return;
    }

    const records = dedupeRecords(readSessionRecords());
    const trackedFiles = new Set<string>();
    const sessions: SessionNode[] = [];

    for (const entry of records) {
      if (!config.showExited && !entry.alive) {
        // Hidden anyway — do not pay for tailing it.
        continue;
      }
      try {
        sessions.push(this.buildSession(entry.record, entry.alive, config, now, trackedFiles));
      } catch (error) {
        const label = entry.record.name ?? entry.record.sessionId;
        warnings.push(`Failed to scan session ${label}: ${describe(error)}`);
        log.error(`sessionRail: scan failed for session ${label}`, error);
      }
    }

    // Past sessions live only as transcripts — the registry is not a history.
    // Excludes every registry id, exited ones included, or a session whose
    // `<pid>.json` did survive would render twice.
    if (config.showExited && config.historyDays > 0) {
      const history = readHistorySessions(
        now,
        config.historyDays * DAY_MS,
        new Set(records.map((entry) => entry.record.sessionId)),
      );
      sessions.push(...history.sessions);
      warnings.push(...history.warnings);
    }

    // Title cache is keyed by transcript, and history transcripts are never
    // tracked files — prune it against what the snapshot actually shows.
    forgetTitles(
      new Set(
        sessions
          .map((session) => session.transcriptPath)
          .filter((file): file is string => file !== undefined),
      ),
    );
    this.pruneState(records, trackedFiles);
    this.publish({
      projects: this.groupProjects(sessions, config),
      generatedAt: now,
      warnings,
    });
  }

  private buildSession(
    record: SessionRecord,
    alive: boolean,
    config: RailConfig,
    now: number,
    trackedFiles: Set<string>,
  ): SessionNode {
    const scan = this.scanFor(record.sessionId);
    const transcriptPath = sessionTranscriptPath(record.cwd, record.sessionId);
    let lastActivityAt: number | undefined;

    if (transcriptPath) {
      trackedFiles.add(transcriptPath);
      const records = this.read(transcriptPath);
      // Only the main transcript sets session-level metadata.
      this.ingest(records, record.sessionId, scan, transcriptPath, true);
      lastActivityAt = this.activity.get(transcriptPath);
    }

    const metaScan = readAgentMetaScan(record.cwd, record.sessionId);
    const agentActivity = this.readAgentTranscripts(record, metaScan.metas, scan, trackedFiles);
    lastActivityAt = maxDefined(lastActivityAt, agentActivity);

    const agents = buildAgentForest(
      record.cwd,
      record.sessionId,
      metaScan.metas,
      scan.spawnIndex,
      metaScan.parents,
    );
    this.applyAgentStates(agents, scan, alive, now);

    const tasks: TaskNode[] = config.showTasks ? readTasks(record.sessionId) : [];

    return {
      kind: 'session',
      id: record.sessionId,
      sessionId: record.sessionId,
      pid: record.pid,
      name: record.name ?? record.sessionId.slice(0, 8),
      // The fold owns this once a title has been seen in a delta; the cold read
      // only covers a session whose newest `ai-title` predates the tailer's
      // 512 KB seed. See `coldTitle` for why it runs at most once.
      title: scan.title ?? this.coldTitle(record.sessionId, transcriptPath),
      cwd: record.cwd,
      state: deriveSessionState(alive, agents, lastActivityAt, now, scan),
      alive,
      source: 'registry',
      branch: scan.branch,
      model: scan.model,
      effort: scan.effort,
      entrypoint: record.entrypoint,
      version: scan.version ?? record.version,
      startedAt: record.startedAt,
      lastActivityAt,
      transcriptPath: transcriptPath && fileExists(transcriptPath) ? transcriptPath : undefined,
      agents,
      tasks,
    };
  }

  /**
   * Tail every `agent-*.jsonl`, because a depth-2 spawn is only ever recorded in
   * its parent AGENT's transcript, never in the session's.
   */
  private readAgentTranscripts(
    record: SessionRecord,
    metas: ReadonlyMap<string, AgentMeta>,
    scan: SessionScan,
    trackedFiles: Set<string>,
  ): number | undefined {
    const dir = subagentsDir(record.cwd, record.sessionId);
    if (!dir || metas.size === 0) {
      return undefined;
    }

    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return undefined;
    }

    let newest: number | undefined;
    for (const name of names) {
      if (!name.endsWith('.jsonl')) {
        continue;
      }
      const agentId = agentIdFromFilename(name);
      if (!agentId) {
        continue;
      }
      const file = path.join(dir, name);
      trackedFiles.add(file);
      const records = this.read(file);
      this.ingest(records, agentId, scan, file, false);
      newest = maxDefined(newest, this.activity.get(file));
    }
    return newest;
  }

  /** Cold start seeds from the tail; afterwards only the appended bytes are read. */
  private read(file: string): TranscriptRecord[] {
    return this.tailer.isTracked(file)
      ? this.tailer.readDelta(file)
      : this.tailer.seed(file, COLD_START_BYTES);
  }

  /**
   * Fold a batch of records into the persistent scan state.
   *
   * `owner` is who emitted these records: the sessionId for the main transcript,
   * an agentId for an agent transcript. Records order is file order, so a plain
   * last-write-wins gives the newest value for branch / effort / version / model.
   */
  private ingest(
    records: readonly TranscriptRecord[],
    owner: string,
    scan: SessionScan,
    file: string,
    isMain: boolean,
  ): void {
    let newest = this.activity.get(file);

    for (const record of records) {
      const at = parseTimestamp(record.timestamp);
      if (at !== undefined && (newest === undefined || at > newest)) {
        newest = at;
      }

      if (isMain) {
        if (typeof record.gitBranch === 'string' && record.gitBranch.length > 0) {
          scan.branch = record.gitBranch;
        }
        if (typeof record.effort === 'string' && record.effort.length > 0) {
          scan.effort = record.effort;
        }
        if (typeof record.version === 'string' && record.version.length > 0) {
          scan.version = record.version;
        }
        const model = messageModel(record.message);
        if (model) {
          scan.model = model;
        }
        // `ai-title` records carry no timestamp, so file order is the ordering:
        // the last one folded is the current title. It is rewritten as the
        // conversation moves on, so a later record legitimately replaces an
        // earlier one.
        if (record.type === 'ai-title') {
          const title = sanitizeTitle(record.aiTitle);
          if (title !== undefined) {
            scan.title = title;
          }
        }
      }

      // `record.agentId` is the authoritative emitter when present (it equals the
      // agent transcript's own id); the file owner covers the main transcript,
      // where the field is absent.
      const emitter = typeof record.agentId === 'string' && record.agentId.length > 0
        ? record.agentId
        : owner;
      this.indexToolUses(record, emitter, scan);
    }

    if (newest !== undefined) {
      this.activity.set(file, newest);
    }
  }

  private indexToolUses(record: TranscriptRecord, emitter: string, scan: SessionScan): void {
    for (const block of messageBlocks(record.message)) {
      const parsed = toolBlock(block);
      if (!parsed) {
        continue;
      }
      if (parsed.kind === 'use') {
        this.addSpawn(scan, parsed.id, emitter, true);
      } else {
        this.addCompleted(scan, parsed.id);
      }
    }

    // Top-level `toolUseID` is a weak signal: observed data attaches it to hook
    // records whose id has nothing to do with an agent spawn, so it only fills a
    // gap and never overwrites a tool_use block.
    if (typeof record.toolUseID === 'string' && record.toolUseID.length > 0) {
      this.addSpawn(scan, record.toolUseID, emitter, false);

      // The spec's documented completion heuristic: a record whose own `type`
      // reads as a result. Kept as a superset — in observed transcripts the
      // record type is `user` and the result lives in a content block, so this
      // branch matches nothing today but costs nothing and covers version drift.
      const type = record.type;
      if (typeof type === 'string' && (type === 'tool_result' || type.includes('result'))) {
        this.addCompleted(scan, record.toolUseID);
      }
    }
  }

  private addSpawn(scan: SessionScan, id: string, emitter: string, strong: boolean): void {
    if (!strong && scan.spawnIndex.has(id)) {
      return;
    }
    if (!scan.spawnIndex.has(id) && this.capped(scan, scan.spawnIndex.size)) {
      return;
    }
    scan.spawnIndex.set(id, emitter);
  }

  private addCompleted(scan: SessionScan, id: string): void {
    if (!scan.completed.has(id) && this.capped(scan, scan.completed.size)) {
      return;
    }
    scan.completed.add(id);
  }

  private capped(scan: SessionScan, size: number): boolean {
    if (size < MAX_INDEX_ENTRIES) {
      return false;
    }
    if (!scan.capped) {
      scan.capped = true;
      log.warn(
        `sessionRail: tool-use index hit ${MAX_INDEX_ENTRIES} entries; new ids are being dropped`,
      );
    }
    return true;
  }

  /**
   * Resolve every agent's state, then downgrade stale `running` claims.
   *
   * `agentState` can only say "no completion seen", which is also what a cold
   * start looks like on a long-running session, so an agent is only believed to
   * be running if its transcript was written recently.
   */
  private applyAgentStates(
    agents: readonly AgentNode[],
    scan: SessionScan,
    alive: boolean,
    now: number,
  ): void {
    walkAgents(agents, (agent) => {
      let state = agentState(agent, scan.completed);
      const recency = this.activity.get(agent.transcriptPath) ?? agent.startedAt;

      if (state === 'running' && !alive) {
        state = 'done';
      }
      if (state === 'running' && (recency === undefined || now - recency > AGENT_ACTIVE_WINDOW_MS)) {
        state = 'done';
      }

      agent.state = state;
      if (state === 'done' && recency !== undefined) {
        agent.endedAt = recency;
      }
    });
  }

  private groupProjects(sessions: readonly SessionNode[], config: RailConfig): ProjectNode[] {
    const byDir = new Map<string, ProjectNode>();

    for (const session of sessions) {
      const dir = this.projectDirFor(session, config);
      let project = byDir.get(dir);
      if (!project) {
        const { worktree, parentDir } = this.worktreeMetaFor(dir);
        project = {
          kind: 'project',
          id: dir,
          name: path.basename(dir) || dir,
          dir,
          sessions: [],
          liveCount: 0,
          worktree,
          parentDir,
        };
        byDir.set(dir, project);
      }
      project.sessions.push(session);
    }

    this.addIdleWorktrees(byDir);

    const projects = [...byDir.values()];
    for (const project of projects) {
      project.sessions.sort(compareSessions);
      project.liveCount = project.sessions.filter((session) => session.state !== 'exited').length;
    }
    projects.sort((left, right) => left.name.localeCompare(right.name) || left.dir.localeCompare(right.dir));
    return projects;
  }

  /**
   * Give every worktree of a visible repo a row, even with nothing running in
   * it. Sessions are the only thing that mints a project row, so without this
   * a worktree's row — and with it the origin repo's whole worktree section —
   * vanishes the moment the last session inside it exits, which reads as the
   * worktree having been removed. The rows are empty (`sessions: []`,
   * `liveCount: 0`) and carry the same `worktree`/`parentDir` marking a
   * session-derived worktree row has, so the provider nests them unchanged.
   *
   * Read fresh every poll rather than memoized: a removed worktree has to stop
   * being offered, and the cost is one readdir plus a stat per worktree of each
   * repo with a session in it.
   */
  private addIdleWorktrees(byDir: Map<string, ProjectNode>): void {
    for (const project of [...byDir.values()]) {
      if (project.worktree === true) {
        continue;
      }
      for (const dir of worktreesOf(project.dir)) {
        if (byDir.has(dir)) {
          continue;
        }
        byDir.set(dir, {
          kind: 'project',
          id: dir,
          name: path.basename(dir) || dir,
          dir,
          sessions: [],
          liveCount: 0,
          worktree: true,
          parentDir: project.dir,
        });
      }
    }
  }

  private projectDirFor(session: SessionNode, config: RailConfig): string {
    if (config.groupBy !== 'gitRoot') {
      return session.cwd;
    }
    return this.gitRootFor(session.cwd) ?? session.cwd;
  }

  private gitRootFor(cwd: string): string | undefined {
    const cached = this.gitRoots.get(cwd);
    if (cached !== undefined || this.gitRoots.has(cwd)) {
      return cached;
    }

    let dir = cwd;
    for (;;) {
      // `.git` is a directory in a normal clone and a file in a worktree.
      if (pathExists(path.join(dir, '.git'))) {
        this.gitRoots.set(cwd, dir);
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    this.gitRoots.set(cwd, undefined);
    return undefined;
  }

  /**
   * Whether the project dir is a linked git worktree, and the main repo it
   * belongs to when it is — that link is what lets the tree provider nest the
   * row under the project it was created from. Memoized like gitRoots; a fs
   * error just means "not a worktree".
   */
  private worktreeMetaFor(dir: string): { worktree: boolean; parentDir?: string } {
    const cached = this.worktreeMeta.get(dir);
    if (cached !== undefined) {
      return cached;
    }
    const worktree = isWorktreeDir(dir);
    const meta = worktree ? { worktree, parentDir: mainRepoFor(dir) } : { worktree };
    this.worktreeMeta.set(dir, meta);
    return meta;
  }

  private scanFor(sessionId: string): SessionScan {
    const existing = this.scans.get(sessionId);
    if (existing) {
      return existing;
    }
    const fresh: SessionScan = { spawnIndex: new Map(), completed: new Set() };
    this.scans.set(sessionId, fresh);
    return fresh;
  }

  /**
   * One cold `ai-title` read per live session, ever.
   *
   * `titles.ts` caches on (mtime, size), which is a guaranteed hit for a frozen
   * history transcript and a guaranteed *miss* for a live one — its file grows
   * on every turn. Re-reading 64 KB per titleless session per tick would be
   * work proportional to the transcript on a 2s loop, so the answer is
   * remembered here instead. Nothing is lost by not retrying: a title that
   * arrives later arrives in a tail delta, and the fold takes precedence.
   */
  private coldTitle(sessionId: string, transcriptPath: string | undefined): string | undefined {
    if (transcriptPath === undefined) {
      return undefined;
    }
    if (this.coldTitles.has(sessionId)) {
      return this.coldTitles.get(sessionId);
    }
    const title = readAiTitle(transcriptPath);
    this.coldTitles.set(sessionId, title);
    return title;
  }

  /** Drop state for sessions and files that left the registry, bounding memory. */
  private pruneState(records: readonly LivenessEntry[], trackedFiles: ReadonlySet<string>): void {
    // Keyed on all records, not just the visible ones, so toggling `showExited`
    // does not throw away a session's spawn index.
    const known = new Set(records.map((entry) => entry.record.sessionId));
    for (const sessionId of [...this.scans.keys()]) {
      if (!known.has(sessionId)) {
        this.scans.delete(sessionId);
      }
    }
    for (const sessionId of [...this.coldTitles.keys()]) {
      if (!known.has(sessionId)) {
        this.coldTitles.delete(sessionId);
      }
    }
    for (const file of [...this.activity.keys()]) {
      if (!trackedFiles.has(file)) {
        this.activity.delete(file);
      }
    }
    this.tailer.retain(trackedFiles);
  }

  private publish(snapshot: Snapshot): void {
    this.current = snapshot;
    this.reindex(snapshot);

    const signature = signatureOf(snapshot);
    if (signature === this.signature) {
      // Structurally identical — stay quiet so the tree does not flicker.
      return;
    }
    this.signature = signature;
    this.emitter.fire(snapshot);
  }

  private reindex(snapshot: Snapshot): void {
    this.sessionIndex.clear();
    this.agentIndex.clear();
    for (const project of snapshot.projects) {
      for (const session of project.sessions) {
        this.sessionIndex.set(session.sessionId, session);
        walkAgents(session.agents, (agent) => {
          this.agentIndex.set(agent.agentId, agent);
        });
      }
    }
  }
}

interface LivenessEntry {
  record: SessionRecord;
  alive: boolean;
}

/**
 * One entry per sessionId. Stale `<pid>.json` files survive their process, so a
 * resumed session can appear twice; prefer the live record, then the newest start.
 */
function dedupeRecords(records: readonly SessionRecord[]): LivenessEntry[] {
  const best = new Map<string, LivenessEntry>();

  for (const record of records) {
    const entry: LivenessEntry = { record, alive: isAlive(record) };
    const existing = best.get(record.sessionId);
    if (!existing || preferEntry(entry, existing)) {
      best.set(record.sessionId, entry);
    }
  }
  return [...best.values()];
}

function preferEntry(candidate: LivenessEntry, incumbent: LivenessEntry): boolean {
  if (candidate.alive !== incumbent.alive) {
    return candidate.alive;
  }
  const candidateStart = candidate.record.startedAt ?? 0;
  const incumbentStart = incumbent.record.startedAt ?? 0;
  if (candidateStart !== incumbentStart) {
    return candidateStart > incumbentStart;
  }
  return candidate.record.pid > incumbent.record.pid;
}

/**
 * The one place session state is decided, so the tree, the status bar and the
 * change fingerprint can never disagree.
 *
 * Not a pure function of the current tick: `scan.lastGeneratingTick` carries the
 * sticky hold across polls. Exported for scripts/sticky-check.ts, which is the
 * only thing outside this module that calls it.
 */
export function deriveSessionState(
  alive: boolean,
  agents: readonly AgentNode[],
  lastActivityAt: number | undefined,
  now: number,
  scan: SessionScan,
): SessionState {
  if (!alive) {
    return 'exited';
  }

  let running = false;
  walkAgents(agents, (agent) => {
    if (agent.state === 'running') {
      running = true;
    }
  });
  const active =
    running ||
    (lastActivityAt !== undefined && now - lastActivityAt <= SESSION_ACTIVE_WINDOW_MS);
  if (active) {
    scan.lastGeneratingTick = now;
    return 'generating';
  }
  // Anchored on the last tick the window fired, never on the last tick this
  // returned `generating` — re-anchoring on its own output would hold the state
  // open forever, one poll interval at a time.
  if (
    scan.lastGeneratingTick !== undefined &&
    now - scan.lastGeneratingTick <= SESSION_STICKY_MS
  ) {
    return 'generating';
  }
  // 'waiting' (blocked on a permission prompt) leaves no trace on disk in v1, so
  // it is never emitted here; an idle-looking session may in fact be waiting.
  return 'idle';
}

function compareSessions(left: SessionNode, right: SessionNode): number {
  const leftRank = left.state === 'exited' ? 1 : 0;
  const rightRank = right.state === 'exited' ? 1 : 0;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  if (leftRank === 1) {
    // Exited rows are mostly transcript history, whose names are truncated
    // UUIDs — alphabetical would be noise. Most recently active first.
    const delta = (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return left.name.localeCompare(right.name) || left.sessionId.localeCompare(right.sessionId);
}

/**
 * Cheap structural fingerprint: ids, states, counts, task statuses. Deliberately
 * excludes timestamps, which move on every tick and would fire an event each time.
 */
function signatureOf(snapshot: Snapshot): string {
  const parts: string[] = [];
  for (const project of snapshot.projects) {
    parts.push(`P|${project.id}|${project.liveCount}|${project.sessions.length}`);
    for (const session of project.sessions) {
      parts.push(
        // The title is in here because it is the row's label and it changes
        // mid-session: leave it out and the new title sits in the snapshot
        // while the tree keeps rendering the old one.
        `S|${session.id}|${session.state}|${session.branch ?? ''}|${session.effort ?? ''}|${
          session.model ?? ''
        }|${session.title ?? ''}|${session.tasks.length}`,
      );
      walkAgents(session.agents, (agent) => {
        parts.push(`A|${agent.id}|${agent.state}|${agent.children.length}`);
      });
      for (const task of session.tasks) {
        parts.push(`T|${task.id}|${task.status}`);
      }
    }
  }
  for (const warning of snapshot.warnings) {
    parts.push(`W|${warning}`);
  }
  return parts.join('\n');
}

function readConfig(): RailConfig {
  const config = vscode.workspace.getConfiguration('sessionRail');
  return {
    refreshInterval: clampInterval(config.get<number>('refreshInterval', DEFAULT_INTERVAL_MS)),
    groupBy: config.get<string>('groupBy', 'cwd') === 'gitRoot' ? 'gitRoot' : 'cwd',
    showTasks: config.get<boolean>('showTasks', true) !== false,
    showExited: config.get<boolean>('showExited', false) === true,
    historyDays: clampDays(config.get<number>('historyDays', 7)),
  };
}

function clampDays(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return 7;
  }
  return Math.min(MAX_HISTORY_DAYS, Math.max(0, Math.round(numeric)));
}

function clampInterval(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(numeric)));
}

interface ToolBlock {
  kind: 'use' | 'result';
  id: string;
}

/**
 * A `tool_use` block carries the spawn id in `id`; the matching `tool_result`
 * block carries it in `tool_use_id`. No filtering on tool name: the spawning tool
 * is called `Agent` in observed data but that name is not part of any contract.
 */
function toolBlock(block: unknown): ToolBlock | undefined {
  if (typeof block !== 'object' || block === null) {
    return undefined;
  }
  const candidate = block as { type?: unknown; id?: unknown; tool_use_id?: unknown };
  if (candidate.type === 'tool_use' && typeof candidate.id === 'string' && candidate.id.length > 0) {
    return { kind: 'use', id: candidate.id };
  }
  if (
    candidate.type === 'tool_result' &&
    typeof candidate.tool_use_id === 'string' &&
    candidate.tool_use_id.length > 0
  ) {
    return { kind: 'result', id: candidate.tool_use_id };
  }
  return undefined;
}

function messageBlocks(message: unknown): readonly unknown[] {
  if (typeof message !== 'object' || message === null) {
    return [];
  }
  const content: unknown = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content as readonly unknown[]) : [];
}

function messageModel(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const model: unknown = (message as { model?: unknown }).model;
  return typeof model === 'string' && model.length > 0 ? model : undefined;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

function maxDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.max(left, right);
}

function noRegistryWarning(): string {
  return `No Claude Code session registry at ${sessionsDir()} — start a Claude Code session, or set sessionRail.claudeHome.`;
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function pathExists(target: string): boolean {
  try {
    fs.statSync(target);
    return true;
  } catch {
    return false;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
