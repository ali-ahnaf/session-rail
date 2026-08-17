/**
 * Byte-offset NDJSON tailer for Claude Code transcripts.
 *
 * Transcripts are append-only and reach hundreds of megabytes, so the rail must
 * never re-read a whole file: every poll reads only the bytes appended since the
 * last read. Per-file state is `{ offset, size, inode, remainder, decoder }`.
 *
 * Inferred-behavior risk: transcripts are private state written by another
 * process. The final line is frequently a partial write, a file may be rotated
 * or rewritten between polls, and a read can land mid-multibyte-character.
 * All three are handled (remainder hold-back, inode/shrink reset, StringDecoder)
 * and every parse failure is skipped silently — a malformed line must never
 * throw, because the whole tree hangs off this loop.
 */

import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';

import { TranscriptRecord } from '../model/types';
import { log } from '../util/log';

/** Cap on a single delta read; a cold start on a huge file must not block a tick. */
const MAX_DELTA_BYTES = 4 * 1024 * 1024;

/** A remainder this large means we are not seeing line breaks; drop it rather than grow forever. */
const MAX_REMAINDER_CHARS = 4 * 1024 * 1024;

interface FileState {
  /** Byte offset consumed so far. */
  offset: number;
  /** File size at the last successful read. */
  size: number;
  /** Inode at the last successful read; 0 on filesystems that do not report one. */
  inode: number;
  /** Trailing partial line (no `\n` yet), prepended to the next delta. */
  remainder: string;
  /** Carries partial multibyte characters across chunk boundaries. */
  decoder: StringDecoder;
}

export class Tailer {
  private readonly states = new Map<string, FileState>();

  /** True once `seed` or `readDelta` has established an offset for `file`. */
  isTracked(file: string): boolean {
    return this.states.has(file);
  }

  /**
   * Cold-start read: return records from the last `maxBytes` of the file AND set
   * the offset to end-of-file, so the following `readDelta` reads only new bytes
   * instead of re-reading from zero.
   */
  seed(file: string, maxBytes: number): TranscriptRecord[] {
    const stat = statFile(file);
    if (!stat) {
      return [];
    }

    const state = freshState(stat.ino);
    state.size = stat.size;
    state.offset = stat.size;
    this.states.set(file, state);

    if (stat.size === 0) {
      return [];
    }

    const start = Math.max(0, stat.size - Math.max(0, maxBytes));
    const chunk = readRange(file, start, stat.size);
    if (!chunk) {
      return [];
    }
    // A short read leaves bytes unconsumed; the next delta picks them up.
    state.offset = Math.min(stat.size, start + chunk.length);
    // The offset moves past the final line even if that line was mid-write. Such a
    // line simply fails to parse now, and its leftover bytes fail to parse next
    // tick — one record lost at cold start, versus re-reading the whole file.
    return recordsFromChunk(chunk.toString('utf8'), start > 0, true);
  }

  /** Records appended since the previous call. Never throws. */
  readDelta(file: string): TranscriptRecord[] {
    const stat = statFile(file);
    if (!stat) {
      // Missing or unreadable right now; keep the offset and retry next tick.
      return [];
    }

    const state = this.stateFor(file, stat);
    if (stat.size <= state.offset) {
      state.size = stat.size;
      return [];
    }

    let start = state.offset;
    let dropLeadingPartial = false;
    const gap = stat.size - start;
    if (gap > MAX_DELTA_BYTES) {
      start = stat.size - MAX_DELTA_BYTES;
      dropLeadingPartial = true;
      state.remainder = '';
      state.decoder = new StringDecoder('utf8');
      log.warn(
        `tailer: ${gap} unread bytes in ${file} exceeds the ${MAX_DELTA_BYTES} byte cap; skipping ahead`,
      );
    }

    const chunk = readRange(file, start, stat.size);
    if (!chunk) {
      return [];
    }

    let text = state.decoder.write(chunk);
    state.offset = start + chunk.length;
    state.size = stat.size;

    if (dropLeadingPartial) {
      const firstBreak = text.indexOf('\n');
      text = firstBreak === -1 ? '' : text.slice(firstBreak + 1);
    } else if (state.remainder.length > 0) {
      text = state.remainder + text;
      state.remainder = '';
    }

    const lastBreak = text.lastIndexOf('\n');
    if (lastBreak === -1) {
      state.remainder = text.length > MAX_REMAINDER_CHARS ? '' : text;
      return [];
    }

    const complete = text.slice(0, lastBreak);
    const trailing = text.slice(lastBreak + 1);
    state.remainder = trailing.length > MAX_REMAINDER_CHARS ? '' : trailing;
    return recordsFromChunk(complete, false, true);
  }

  /** Forget the offset so the next read starts from the beginning of the file. */
  reset(file: string): void {
    this.states.delete(file);
  }

  /** Drop all state for a file that is no longer being watched. */
  forget(file: string): void {
    this.states.delete(file);
  }

  /** Drop state for every tracked file outside `files`, bounding memory growth. */
  retain(files: ReadonlySet<string>): void {
    for (const tracked of [...this.states.keys()]) {
      if (!files.has(tracked)) {
        this.states.delete(tracked);
      }
    }
  }

  dispose(): void {
    this.states.clear();
  }

  private stateFor(file: string, stat: fs.Stats): FileState {
    const existing = this.states.get(file);
    if (!existing) {
      const fresh = freshState(stat.ino);
      this.states.set(file, fresh);
      return fresh;
    }

    const replaced = stat.ino !== 0 && existing.inode !== 0 && stat.ino !== existing.inode;
    const truncated = stat.size < existing.offset;
    if (replaced || truncated) {
      log.debug(
        `tailer: ${file} was ${replaced ? 'replaced' : 'truncated'}; restarting from offset 0`,
      );
      const fresh = freshState(stat.ino);
      this.states.set(file, fresh);
      return fresh;
    }

    return existing;
  }
}

/**
 * Stateless "read the last N bytes" helper, for callers that want a tail without
 * taking ownership of an offset. `Tailer.seed` is preferred inside the poll loop
 * because it also primes the offset.
 */
export function readTailRecords(file: string, maxBytes: number): TranscriptRecord[] {
  const stat = statFile(file);
  if (!stat || stat.size === 0) {
    return [];
  }

  const start = Math.max(0, stat.size - Math.max(0, maxBytes));
  const chunk = readRange(file, start, stat.size);
  if (!chunk) {
    return [];
  }
  return recordsFromChunk(chunk.toString('utf8'), start > 0, true);
}

function freshState(inode: number): FileState {
  return {
    offset: 0,
    size: 0,
    inode,
    remainder: '',
    decoder: new StringDecoder('utf8'),
  };
}

function statFile(file: string): fs.Stats | undefined {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat : undefined;
  } catch {
    return undefined;
  }
}

/** Read `[start, end)` with a file descriptor. Returns only the bytes actually read. */
function readRange(file: string, start: number, end: number): Buffer | undefined {
  const length = end - start;
  if (length <= 0) {
    return Buffer.alloc(0);
  }

  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buffer, 0, length, start);
      return buffer.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    log.debug(`tailer: read failed for ${file}: ${describe(error)}`);
    return undefined;
  }
}

/**
 * Split a decoded chunk into records.
 *
 * `dropFirst` discards a leading partial line (the chunk started mid-file).
 * `keepUnterminated` parses a final line that has no `\n`: in a tail read that
 * line is usually a complete newest record worth having, and a genuine partial
 * write simply fails to parse and is skipped.
 */
function recordsFromChunk(
  text: string,
  dropFirst: boolean,
  keepUnterminated: boolean,
): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  const lines = text.split('\n');
  const startIndex = dropFirst ? 1 : 0;
  const endIndex = keepUnterminated ? lines.length : lines.length - 1;

  for (let index = startIndex; index < endIndex; index += 1) {
    const record = parseRecord(lines[index]);
    if (record) {
      records.push(record);
    }
  }
  return records;
}

/** Parse one NDJSON line. Half-written lines and non-object lines yield undefined. */
function parseRecord(line: string | undefined): TranscriptRecord | undefined {
  if (line === undefined) {
    return undefined;
  }
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith('{')) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    // Every field of TranscriptRecord is optional, so this narrowing is safe:
    // consumers must still check each field before use.
    return parsed as TranscriptRecord;
  } catch {
    return undefined;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
