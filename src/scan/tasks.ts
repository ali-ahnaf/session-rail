/**
 * Task list for a session: `~/.claude/tasks/<sessionId>/<n>.json`.
 *
 * The directory also holds `.lock` and `.highwatermark`; only `*.json` is read.
 * Most sessions have no task directory at all, so a missing dir is normal and
 * produces no warning.
 *
 * Inferred-behavior risk: `blocks` / `blockedBy` are typed as JSON-encoded
 * STRINGS in the frozen model ("[]"), but observed files on this machine store
 * real JSON arrays ([]). Both shapes are accepted (see `toIdList`) — passing an
 * array through `parseIdList` alone silently yields an empty list.
 */

import * as fs from 'fs';
import * as path from 'path';

import { TaskNode, normalizeTaskStatus, parseIdList } from '../model/types';
import { log } from '../util/log';
import { sessionTasksDir } from './paths';

/** Tasks for `sessionId`, ordered by numeric id ascending. Missing dir → `[]`. */
export function readTasks(sessionId: string): TaskNode[] {
  const dir = sessionTasksDir(sessionId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // No task directory is the common case; not worth a warning.
    return [];
  }

  const tasks: TaskNode[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) {
      continue;
    }
    const task = readTask(path.join(dir, name), sessionId, path.basename(name, '.json'));
    if (task) {
      tasks.push(task);
    }
  }

  tasks.sort(compareTasks);
  return tasks;
}

function readTask(file: string, sessionId: string, stem: string): TaskNode | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    log.debug(`tasks: skipping ${file}: ${describe(error)}`);
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log.debug(`tasks: unexpected shape in ${file}`);
    return undefined;
  }

  const raw = parsed as Record<string, unknown>;
  const rawId = raw['id'];
  const taskId = typeof rawId === 'string' && rawId.length > 0 ? rawId : stem;
  const rawSubject = raw['subject'];
  const rawStatus = raw['status'];

  return {
    kind: 'task',
    id: `${sessionId}:${taskId}`,
    sessionId,
    taskId,
    subject:
      typeof rawSubject === 'string' && rawSubject.length > 0 ? rawSubject : `Task ${taskId}`,
    status: normalizeTaskStatus(typeof rawStatus === 'string' ? rawStatus : undefined),
    blockedBy: toIdList(raw['blockedBy']),
  };
}

/** Accepts a real array (observed) or a JSON-encoded string (documented). */
function toIdList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return (raw as readonly unknown[])
      .filter((entry): entry is string | number => typeof entry === 'string' || typeof entry === 'number')
      .map(String);
  }
  if (typeof raw === 'string') {
    return parseIdList(raw);
  }
  return [];
}

function compareTasks(left: TaskNode, right: TaskNode): number {
  const leftNumber = Number(left.taskId);
  const rightNumber = Number(right.taskId);
  const leftNumeric = Number.isFinite(leftNumber);
  const rightNumeric = Number.isFinite(rightNumber);

  if (leftNumeric && rightNumeric && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  if (leftNumeric !== rightNumeric) {
    // Numeric ids first, so `1.json` never sorts after an oddly named file.
    return leftNumeric ? -1 : 1;
  }
  return left.taskId.localeCompare(right.taskId);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
