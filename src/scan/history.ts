/**
 * Past sessions, recovered from transcripts on disk.
 *
 * `~/.claude/sessions/<pid>.json` is a registry of *processes*, not a history:
 * on 2026-08-17 it held 11 records for 11 live pids and nothing else, so
 * `showExited` had nothing to reveal (see `sessions.ts`). What does survive is
 * the transcript — `projects/<enc-cwd>/<sessionId>.jsonl` — one file per session
 * ever run, kept long after the process is gone.
 *
 * This module turns those files into exited `SessionNode`s, newest first, within
 * a day window. Deliberately shallow:
 *
 *  - **Never tailed.** A history row reports `agents: []` and `tasks: []`, and
 *    its transcript is not added to `trackedFiles`. That is correctness, not
 *    thrift: agent nesting comes from a `spawnIndex` built by reading the
 *    transcript deltas live, and a cold read of an old file would rebuild the
 *    forest without one — hanging depth-2 agents at the root, the exact shape
 *    `scripts/smoke.ts` forbids. Empty is honest; half a forest is not.
 *  - **cwd comes from the directory, not the file.** `projects/<enc-cwd>/` is
 *    one directory per cwd, so the cwd is read once per directory from the head
 *    of its first transcript (`firstTranscriptCwd`) rather than once per file.
 *  - **No pid.** These rows carry `pid: 0`; the process is long gone. Consumers
 *    that signal a pid must refuse a non-positive one — `process.kill(0, ...)`
 *    signals the whole process group.
 *
 * The scan is cached for HISTORY_TTL_MS, because the poll loop runs every couple
 * of seconds and this walks every project directory.
 */

import * as fs from 'fs';
import * as path from 'path';

import { SessionNode } from '../model/types';
import { log } from '../util/log';
import { firstTranscriptCwd, projectsDir } from './paths';
import { readAiTitle } from './titles';

/** A project directory walk is far too expensive to repeat on every poll. */
const HISTORY_TTL_MS = 30_000;

export interface HistoryScan {
  /** Exited sessions, one per transcript in the window. */
  sessions: SessionNode[];
  warnings: string[];
}

/** What the walk found, before live sessions are filtered out of it. */
interface HistoryEntry {
  sessionId: string;
  cwd: string;
  transcriptPath: string;
  lastActivityAt: number;
}

interface HistoryCache {
  windowMs: number;
  scannedAt: number;
  entries: HistoryEntry[];
  warnings: string[];
}

let cache: HistoryCache | undefined;

/** Drop the cached walk. For the refresh command and for tests. */
export function clearHistoryCache(): void {
  cache = undefined;
}

/**
 * Sessions whose transcript was last written within `windowMs`, excluding every
 * id in `exclude` — which must be *all* session-registry ids, live and exited
 * alike, or a session with a surviving `<pid>.json` renders twice.
 */
export function readHistorySessions(
  now: number,
  windowMs: number,
  exclude: ReadonlySet<string>,
): HistoryScan {
  if (windowMs <= 0) {
    return { sessions: [], warnings: [] };
  }

  const scan = cachedScan(now, windowMs);
  const sessions = scan.entries
    .filter((entry) => !exclude.has(entry.sessionId))
    .map(toSessionNode);

  return { sessions, warnings: scan.warnings };
}

function cachedScan(now: number, windowMs: number): HistoryCache {
  if (cache && cache.windowMs === windowMs && now - cache.scannedAt < HISTORY_TTL_MS) {
    return cache;
  }
  cache = scanProjects(now, windowMs);
  return cache;
}

function scanProjects(now: number, windowMs: number): HistoryCache {
  const root = projectsDir();
  const warnings: string[] = [];
  const entries: HistoryEntry[] = [];
  const seen = new Set<string>();

  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    log.debug(`history: cannot list ${root}: ${describe(error)}`);
    return { windowMs, scannedAt: now, entries, warnings };
  }

  for (const dir of dirs) {
    if (!dir.isDirectory()) {
      continue;
    }
    const projectDir = path.join(root, dir.name);
    const recent = recentTranscripts(projectDir, now, windowMs);
    if (recent.length === 0) {
      continue;
    }

    // One head read per directory, not per transcript.
    const cwd = firstTranscriptCwd(projectDir);
    if (cwd === undefined) {
      // No parseable `cwd` anywhere in the directory. Guessing one by decoding
      // the directory name is lossy (a `-` in a real path name is
      // indistinguishable from a separator), and a wrong cwd would file the row
      // under a project that does not exist.
      warnings.push(`Skipped session history in ${dir.name}: no working directory on record.`);
      continue;
    }

    for (const found of recent) {
      if (seen.has(found.sessionId)) {
        continue;
      }
      seen.add(found.sessionId);
      entries.push({ ...found, cwd });
    }
  }

  entries.sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  log.debug(`history: ${entries.length} transcript(s) within ${Math.round(windowMs / 86_400_000)}d`);
  return { windowMs, scannedAt: now, entries, warnings };
}

/**
 * `<sessionId>.jsonl` files in a project directory whose mtime is inside the
 * window. Only the top level is read: subagent transcripts live one level down
 * in `<sessionId>/subagents/` and are not sessions.
 */
function recentTranscripts(
  projectDir: string,
  now: number,
  windowMs: number,
): Omit<HistoryEntry, 'cwd'>[] {
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch (error) {
    log.debug(`history: cannot list ${projectDir}: ${describe(error)}`);
    return [];
  }

  const found: Omit<HistoryEntry, 'cwd'>[] = [];
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.jsonl')) {
      continue;
    }
    const transcriptPath = path.join(projectDir, file.name);
    let mtime: number;
    try {
      mtime = fs.statSync(transcriptPath).mtimeMs;
    } catch {
      // Rotated or removed between the listing and the stat.
      continue;
    }
    if (now - mtime > windowMs) {
      continue;
    }
    found.push({
      sessionId: file.name.slice(0, -'.jsonl'.length),
      transcriptPath,
      lastActivityAt: mtime,
    });
  }
  return found;
}

/**
 * A history row is a session with everything the transcript alone can prove.
 * `branch` / `model` / `effort` are absent by design — they are folded out of
 * transcript deltas as they are appended, and this file was never tailed.
 */
function toSessionNode(entry: HistoryEntry): SessionNode {
  return {
    kind: 'session',
    id: entry.sessionId,
    sessionId: entry.sessionId,
    // No process to point at. Anything that signals a pid must refuse this.
    pid: 0,
    // Claude Code's derived name ("goshift-d3") lives in the session registry,
    // which is exactly what is gone. Transcripts carry no session name.
    name: entry.sessionId.slice(0, 8),
    // They do carry a title, though: `ai-title` records, read from a bounded
    // tail of the file. Not a tail in the `Tailer` sense — no offsets, no
    // ingest, no spawn index — so the never-tail rule above still holds.
    title: readAiTitle(entry.transcriptPath),
    cwd: entry.cwd,
    state: 'exited',
    alive: false,
    source: 'transcript',
    lastActivityAt: entry.lastActivityAt,
    transcriptPath: entry.transcriptPath,
    agents: [],
    tasks: [],
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
