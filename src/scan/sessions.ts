/**
 * The session registry: `~/.claude/sessions/<pid>.json`, plus liveness.
 *
 * A file existing says nothing about liveness — every record has to be probed.
 * The dir also holds `<pid>.<hash>.key` files, which are ignored.
 *
 * Drift, observed 2026-08-17 on Claude Code 2.1.x: the registry held 11 records
 * and all 11 pids were live — zero stale files. Records were once seen to
 * outlive their process; now they may not, so `showExited` can legitimately
 * reveal nothing. Consistent with delete-on-exit AND with a cleanup job — the
 * mechanism is unconfirmed, so do not build on either. Past sessions are still
 * on disk as transcripts under `projects/<encoded-cwd>/<session-id>.jsonl`; the
 * registry is not a history.
 *
 * Inferred-behavior risk — the PID-reuse guard. `procStart` is written by Claude
 * Code in UTC ("Mon Aug 17 14:19:54 2026") while `ps -o lstart=` prints local
 * time, so on this machine the same live process reads 6 hours apart. Verified
 * across all six live pids: the hour differs by the tz offset, minutes and
 * seconds match exactly. So the guard compares MINUTE + SECOND only — tz-
 * agnostic, no hardcoded offset, and still ~1/3600 odds of accepting a reused
 * pid. The comparison is also deliberately biased toward "alive": a false
 * "exited" hides a real session (invisible entirely when `showExited` is off),
 * while a false "alive" only leaves a stale row, so we declare dead only when
 * both sides parsed and genuinely disagree.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { SessionRecord } from '../model/types';
import { log } from '../util/log';
import { sessionSocketPath, sessionsDir } from './paths';

/** Only `<pid>.json` is a session record; `.key` files and anything else are not. */
const RECORD_FILENAME = /^\d+\.json$/;

/** One poll cycle must not shell out to `ps` repeatedly for the same pid. */
const LIVENESS_TTL_MS = 2000;

/** `ps` is a child process on the extension host; keep it on a short leash. */
const PS_TIMEOUT_MS = 1500;

interface LivenessEntry {
  alive: boolean;
  checkedAt: number;
}

const livenessCache = new Map<number, LivenessEntry>();

/** Every parseable `<pid>.json` in the registry. Malformed files are logged and skipped. */
export function readSessionRecords(): SessionRecord[] {
  const dir = sessionsDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    log.debug(`sessions: cannot list ${dir}: ${describe(error)}`);
    return [];
  }

  const records: SessionRecord[] = [];
  for (const name of names) {
    if (!RECORD_FILENAME.test(name)) {
      continue;
    }
    const record = readSessionRecord(path.join(dir, name));
    if (record) {
      records.push(record);
    }
  }
  return records;
}

/**
 * Is the process behind this record still running?
 *
 * `process.kill(pid, 0)` first (EPERM counts as alive, ESRCH as dead), then the
 * PID-reuse guard described at the top of this file. Cached for
 * `LIVENESS_TTL_MS` per pid.
 */
export function isAlive(record: SessionRecord): boolean {
  const pid = record.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  const now = Date.now();
  const cached = livenessCache.get(pid);
  if (cached && now - cached.checkedAt < LIVENESS_TTL_MS) {
    return cached.alive;
  }

  const alive = probeLiveness(record);
  livenessCache.set(pid, { alive, checkedAt: now });
  return alive;
}

export function clearLivenessCache(): void {
  livenessCache.clear();
}

function readSessionRecord(file: string): SessionRecord | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    log.debug(`sessions: cannot read ${file}: ${describe(error)}`);
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    log.warn(`sessions: malformed JSON in ${file}: ${describe(error)}`);
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log.warn(`sessions: unexpected shape in ${file}`);
    return undefined;
  }

  const raw = parsed as Record<string, unknown>;
  const pid = raw['pid'];
  const sessionId = raw['sessionId'];
  const cwd = raw['cwd'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    log.warn(`sessions: missing or invalid pid in ${file}`);
    return undefined;
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    log.warn(`sessions: missing sessionId in ${file}`);
    return undefined;
  }
  if (typeof cwd !== 'string' || cwd.length === 0) {
    log.warn(`sessions: missing cwd in ${file}`);
    return undefined;
  }

  return {
    pid,
    sessionId,
    cwd,
    startedAt: numberOrUndefined(raw['startedAt']),
    procStart: stringOrUndefined(raw['procStart']),
    version: stringOrUndefined(raw['version']),
    kind: stringOrUndefined(raw['kind']),
    entrypoint: stringOrUndefined(raw['entrypoint']),
    messagingSocketPath: stringOrUndefined(raw['messagingSocketPath']),
    name: stringOrUndefined(raw['name']),
    nameSource: stringOrUndefined(raw['nameSource']),
    nameSince: numberOrUndefined(raw['nameSince']),
  };
}

function probeLiveness(record: SessionRecord): boolean {
  if (!pidExists(record.pid)) {
    return false;
  }

  if (!record.procStart) {
    return true;
  }

  const actual = processStartLine(record.pid);
  if (!actual) {
    // The probe itself failed (no `ps`, timeout, permissions). Trust the signal.
    log.debug(
      `sessions: start-time probe failed for pid ${record.pid}; trusting kill(0)` +
        `${socketExists(record.pid) ? ' (socket present)' : ''}`,
    );
    return true;
  }

  if (sameProcessStart(record.procStart, actual)) {
    return true;
  }

  // The pid was recycled by an unrelated process. A stale `<pid>.sock` outlives
  // the session, so socket presence deliberately does NOT override this.
  log.debug(
    `sessions: pid ${record.pid} start time mismatch (record "${record.procStart}" vs ps "${actual}"); treating as exited`,
  );
  return false;
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EPERM') {
      return true;
    }
    if (code !== 'ESRCH') {
      log.debug(`sessions: kill(0) on pid ${pid} failed: ${describe(error)}`);
    }
    return false;
  }
}

/** `ps -o lstart= -p <pid>` — empty/undefined when the pid is gone or `ps` is unavailable. */
function processStartLine(pid: number): string | undefined {
  try {
    const output = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: PS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = output.split('\n')[0]?.trim();
    return line && line.length > 0 ? line : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Same process? Compares minute + second, because the record stores UTC and `ps`
 * prints local time (see the file header). Unparseable input means "assume same
 * process" — we never claim dead on a parse failure.
 */
function sameProcessStart(recorded: string, actual: string): boolean {
  if (recorded.trim() === actual.trim()) {
    return true;
  }

  const left = clockParts(recorded);
  const right = clockParts(actual);
  if (!left || !right) {
    return true;
  }
  return left.minute === right.minute && left.second === right.second;
}

function clockParts(value: string): { minute: number; second: number } | undefined {
  const match = /(\d{1,2}):(\d{2}):(\d{2})/.exec(value);
  if (!match) {
    return undefined;
  }
  const minute = Number(match[2]);
  const second = Number(match[3]);
  if (!Number.isInteger(minute) || !Number.isInteger(second)) {
    return undefined;
  }
  return { minute, second };
}

/** Corroborating evidence only — logged, never decisive, because sockets go stale. */
function socketExists(pid: number): boolean {
  try {
    return fs.existsSync(sessionSocketPath(pid));
  } catch {
    return false;
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
