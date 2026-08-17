/**
 * Locations inside ~/.claude, and the cwd → project-directory encoding.
 *
 * FROZEN CONTRACT — scan/ modules use these instead of joining paths by hand.
 *
 * Everything addressed here is private, unversioned Claude Code state. Each
 * accessor is a pure path computation; nothing asserts the path exists.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Override root, for tests and for the `sessionRail.claudeHome` setting. */
let overrideHome: string | undefined;

export function setClaudeHome(dir: string | undefined): void {
  overrideHome = dir;
  projectDirCache.clear();
}

export function claudeHome(): string {
  return overrideHome ?? path.join(os.homedir(), '.claude');
}

/** `~/.claude/sessions` — one `<pid>.json` per running session. */
export function sessionsDir(): string {
  return path.join(claudeHome(), 'sessions');
}

/** `~/.claude/projects` — one directory per encoded cwd. */
export function projectsDir(): string {
  return path.join(claudeHome(), 'projects');
}

/** `~/.claude/tasks` — one directory per sessionId. */
export function tasksDir(): string {
  return path.join(claudeHome(), 'tasks');
}

/** `~/.claude/tasks/<sessionId>` */
export function sessionTasksDir(sessionId: string): string {
  return path.join(tasksDir(), sessionId);
}

/** `/tmp/cc-socks` — a live `<pid>.sock` is corroborating evidence of liveness. */
export function socketsDir(): string {
  return path.join(os.tmpdir(), 'cc-socks');
}

export function sessionSocketPath(pid: number): string {
  return path.join(socketsDir(), `${pid}.sock`);
}

/**
 * Encode a cwd the way Claude Code names its project directories: every `/`
 * becomes `-`, so `/Users/me/Projects/app` → `-Users-me-Projects-app`.
 *
 * Verified against 40 local project directories with zero mismatches, but this
 * is inferred behavior on private state — prefer `resolveProjectDir`, which
 * falls back to a scan when the encoded guess is absent.
 */
export function encodeCwd(cwd: string): string {
  return cwd.split(path.sep).join('-');
}

const projectDirCache = new Map<string, string | undefined>();

/**
 * Absolute path to the project directory for `cwd`, or undefined if none exists.
 *
 * Tries the encoded name first. On a miss, scans `projects/` and reads the first
 * transcript in each candidate to recover its real `cwd` — so unusual path
 * characters can't silently break the tree. Results are cached per cwd,
 * including misses; call `clearProjectDirCache` when directories may have
 * appeared.
 */
export function resolveProjectDir(cwd: string): string | undefined {
  const cached = projectDirCache.get(cwd);
  if (cached !== undefined || projectDirCache.has(cwd)) {
    return cached;
  }

  const guess = path.join(projectsDir(), encodeCwd(cwd));
  if (isDirectory(guess)) {
    projectDirCache.set(cwd, guess);
    return guess;
  }

  const found = scanForProjectDir(cwd);
  projectDirCache.set(cwd, found);
  return found;
}

export function clearProjectDirCache(): void {
  projectDirCache.clear();
}

function scanForProjectDir(cwd: string): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsDir(), { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(projectsDir(), entry.name);
    if (firstTranscriptCwd(dir) === cwd) {
      return dir;
    }
  }
  return undefined;
}

/**
 * Read the `cwd` field out of the first transcript found in a project dir.
 *
 * One directory holds exactly one cwd — the encoding is a function of it — so
 * this answers "which cwd is this directory?" with a single head read, and
 * `scan/history.ts` uses it to avoid one read per transcript.
 */
export function firstTranscriptCwd(dir: string): string | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }

  for (const name of names) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    const cwd = readCwdField(path.join(dir, name));
    if (cwd) {
      return cwd;
    }
  }
  return undefined;
}

/**
 * Pull the first `cwd` value out of an NDJSON transcript, reading at most 64 KB
 * so this stays cheap on multi-megabyte files.
 */
function readCwdField(file: string): string | undefined {
  let head: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }

  for (const line of head.split('\n')) {
    if (!line.includes('"cwd"')) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { cwd?: unknown };
      if (typeof parsed.cwd === 'string') {
        return parsed.cwd;
      }
    } catch {
      // Truncated final line, or a shape we don't recognize. Keep looking.
    }
  }
  return undefined;
}

/** `projects/<enc-cwd>/<sessionId>.jsonl` — the main session transcript. */
export function sessionTranscriptPath(cwd: string, sessionId: string): string | undefined {
  const dir = resolveProjectDir(cwd);
  return dir ? path.join(dir, `${sessionId}.jsonl`) : undefined;
}

/** `projects/<enc-cwd>/<sessionId>/subagents` — flat, all depths together. */
export function subagentsDir(cwd: string, sessionId: string): string | undefined {
  const dir = resolveProjectDir(cwd);
  return dir ? path.join(dir, sessionId, 'subagents') : undefined;
}

/** Recover the agentId from `agent-<id>.jsonl` or `agent-<id>.meta.json`. */
export function agentIdFromFilename(filename: string): string | undefined {
  const match = /^agent-([^.]+)\.(?:jsonl|meta\.json)$/.exec(path.basename(filename));
  return match?.[1];
}

export function agentMetaPath(subagents: string, agentId: string): string {
  return path.join(subagents, `agent-${agentId}.meta.json`);
}

export function agentTranscriptPath(subagents: string, agentId: string): string {
  return path.join(subagents, `agent-${agentId}.jsonl`);
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
