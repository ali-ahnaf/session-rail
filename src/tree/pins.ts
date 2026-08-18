/**
 * The pin store: which project folders the user parked at the top of the tree.
 *
 * Pins are UI state, not session state — nothing about them is readable from
 * `~/.claude`, so this is the one thing in the tree layer that persists
 * anything. It lives in `globalState` rather than in a setting because the
 * values are absolute machine paths managed entirely by clicking: a settings
 * entry invites hand-editing and Settings Sync would carry paths to machines
 * where they mean nothing. `setKeysForSync` is deliberately never called.
 *
 * Contrast with the search filter, which is transient provider state and
 * persists nowhere.
 */

import * as vscode from 'vscode';

import { log, safelyAsync } from '../util/log';

const STORAGE_KEY = 'sessionRail.pinnedProjects';

export class PinStore implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires after a pin is added or removed, so the tree can re-render. */
  readonly onDidChange: vscode.Event<void> = this.changeEmitter.event;

  /** Pin order, normalized. Insertion order is display order. */
  private dirs: string[];

  constructor(private readonly memento: vscode.Memento) {
    this.dirs = readStored(memento);
  }

  /** Pinned directories, oldest pin first. */
  list(): readonly string[] {
    return this.dirs;
  }

  has(dir: string): boolean {
    return this.dirs.includes(normalizeDir(dir));
  }

  /** Appends to the end of the list, so existing pins keep their positions. */
  async pin(dir: string): Promise<void> {
    const normalized = normalizeDir(dir);
    if (normalized.length === 0 || this.dirs.includes(normalized)) {
      return;
    }
    await this.write([...this.dirs, normalized]);
  }

  async unpin(dir: string): Promise<void> {
    const normalized = normalizeDir(dir);
    if (!this.dirs.includes(normalized)) {
      return;
    }
    await this.write(this.dirs.filter((entry) => entry !== normalized));
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  /**
   * In-memory state is updated first and the event fires regardless of the
   * write: a failed `globalState` update costs the pin at the next window, but
   * a tree that ignored the click would look broken now.
   */
  private async write(next: string[]): Promise<void> {
    this.dirs = next;
    this.changeEmitter.fire();
    await safelyAsync(
      'PinStore.write',
      () => Promise.resolve(this.memento.update(STORAGE_KEY, next)),
      undefined,
    );
  }
}

/** Absolute path with trailing separators dropped, so `/a/b` and `/a/b/` are one pin. */
export function normalizeDir(dir: string): string {
  const trimmed = dir.trim();
  if (trimmed.length <= 1) {
    return trimmed;
  }
  return trimmed.replace(/[\\/]+$/, '');
}

/**
 * `globalState` holds whatever an older version of this extension wrote, so the
 * stored value is narrowed the same way `~/.claude` records are: unknown shapes
 * degrade to no pins rather than throwing during activation.
 */
function readStored(memento: vscode.Memento): string[] {
  const raw: unknown = memento.get(STORAGE_KEY);
  if (!Array.isArray(raw)) {
    if (raw !== undefined) {
      log.warn(`Ignoring ${STORAGE_KEY}: expected an array of paths`);
    }
    return [];
  }

  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      continue;
    }
    const normalized = normalizeDir(entry);
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    dirs.push(normalized);
  }
  return dirs;
}
