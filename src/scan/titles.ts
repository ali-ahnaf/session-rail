/**
 * Claude Code's own summarized session title.
 *
 * Transcripts carry `{"type":"ai-title","aiTitle":"Deploy API to VPS",…}`
 * records — the label the Claude Code VS Code extension shows in its session
 * list. They are appended repeatedly as the conversation moves on, carry no
 * `timestamp`, and are the only human-meaningful name on disk: the session
 * registry's `name` is derived (`claude-hybrid-56`) and a history row has
 * nothing but a truncated UUID.
 *
 * Two ways in, one shape out:
 *
 *  - Live rows fold titles out of the tail deltas in `registry.ts` — free, the
 *    bytes are already being read.
 *  - History rows have no tailer, so `readAiTitle` cold-reads the **tail** of
 *    the file. This is not the cold read the never-tail invariant forbids: that
 *    rule exists because rebuilding an agent forest without a live `spawnIndex`
 *    strands depth-2 agents at the root. Nothing here touches `spawnIndex`,
 *    `ingest`, or `trackedFiles` — it reads one string and stops.
 *
 * Both paths go through `sanitizeTitle`, because `aiTitle` is model-generated
 * text landing in a tree label.
 */

import * as fs from 'fs';

import { log, safely } from '../util/log';

/** Enough tail to hold the newest `ai-title` with room to spare. */
const TAIL_BYTES = 64 * 1024;

/** A tree row is not the place for an essay. */
const MAX_TITLE_LENGTH = 60;

interface TitleCacheEntry {
  mtimeMs: number;
  size: number;
  title: string | undefined;
}

/** Keyed by transcript path. Exited transcripts never move, so this is a hit. */
const cache = new Map<string, TitleCacheEntry>();

/**
 * Newest `ai-title` in a transcript, or `undefined` when it has none.
 *
 * Cached against (mtime, size): a history transcript is frozen, so the file is
 * read once no matter how often the poll loop asks.
 */
export function readAiTitle(transcriptPath: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    // Rotated or removed since the directory walk. Not worth a warning.
    return undefined;
  }

  const cached = cache.get(transcriptPath);
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.title;
  }

  const title = safely<string | undefined>(
    `titles: read ${transcriptPath}`,
    () => scanTail(transcriptPath, stat.size),
    undefined,
  );
  cache.set(transcriptPath, { mtimeMs: stat.mtimeMs, size: stat.size, title });
  return title;
}

/** Drop remembered titles for files no longer of interest. */
export function forgetTitles(keep: ReadonlySet<string>): void {
  for (const file of cache.keys()) {
    if (!keep.has(file)) {
      cache.delete(file);
    }
  }
}

/**
 * Collapse a model-written title into one short line, or `undefined` if there
 * is nothing left worth showing.
 */
export function sanitizeTitle(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  // Control characters included: a newline in a TreeItem label truncates the
  // row at the break with no indication anything was cut.
  const flat = raw
    // eslint-disable-next-line no-control-regex -- stripping them is the point.
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length === 0) {
    return undefined;
  }
  return flat.length > MAX_TITLE_LENGTH ? `${flat.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : flat;
}

/**
 * Read the last `TAIL_BYTES` of the file and return the last `ai-title` in it.
 *
 * The first line of the window is usually cut mid-record; `JSON.parse` rejects
 * it and the loop moves on. A substring pre-filter keeps the parse off the
 * thousands of lines that are not titles.
 */
function scanTail(transcriptPath: string, size: number): string | undefined {
  const start = Math.max(0, size - TAIL_BYTES);
  const length = size - start;
  if (length <= 0) {
    return undefined;
  }

  const buffer = Buffer.allocUnsafe(length);
  const fd = fs.openSync(transcriptPath, 'r');
  let read: number;
  try {
    read = fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }

  const lines = buffer.subarray(0, read).toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.includes('"ai-title"')) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A half-written final line, or the truncated first one.
      continue;
    }
    if (!isRecord(parsed) || parsed['type'] !== 'ai-title') {
      continue;
    }
    const title = sanitizeTitle(parsed['aiTitle']);
    if (title !== undefined) {
      return title;
    }
  }

  log.debug(`titles: no ai-title in the last ${length}B of ${transcriptPath}`);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
