/**
 * The view header's indeterminate progress bar.
 *
 * VS Code renders one under a view's title whenever a `withProgress` call is
 * open on that viewId, and it settles when the promise handed to `withProgress`
 * settles — so "hold the bar" means "keep an unresolved promise around". That
 * promise is the only state here, and `dispose()` must settle it or the bar
 * outlives the extension.
 *
 * Lives outside the provider on purpose: the provider answers `getChildren`,
 * and a token held across ticks is lifecycle, not rendering.
 */

import * as vscode from 'vscode';

import type { Snapshot } from '../model/types';
import type { RailRegistry } from '../scan/registry';
import { motionAllowed } from './motion';

/** The view the bar hangs under; must match `contributes.views` in package.json. */
const VIEW_ID = 'sessionRail.tree';

/**
 * Off-delay only. Sessions cross the generating boundary a tick apart, and a bar
 * that closed on the first quiet tick would strobe; there is no matching on-delay
 * because the whole point is that it appears the instant work starts.
 */
const OFF_DELAY_MS = 1000;

export class RailProgress implements vscode.Disposable {
  private readonly subscription: vscode.Disposable;
  /** Settles the promise `withProgress` is waiting on; set iff the bar is up. */
  private release: (() => void) | undefined;
  private offTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(registry: RailRegistry) {
    this.subscription = registry.onDidChange((snapshot) => this.apply(snapshot));
    this.apply(registry.snapshot());
  }

  dispose(): void {
    this.subscription.dispose();
    this.clearTimer();
    this.lower();
  }

  private apply(snapshot: Snapshot): void {
    // `reduceMotion` is read here, not cached, for the same reason items.ts reads
    // it per row: no listener to keep in sync, and a stale answer would animate
    // for a user who asked it not to.
    if (anyGenerating(snapshot) && motionAllowed()) {
      this.clearTimer();
      this.raise();
      return;
    }
    if (this.release === undefined || this.offTimer !== undefined) {
      return;
    }
    this.offTimer = setTimeout(() => {
      this.offTimer = undefined;
      this.lower();
    }, OFF_DELAY_MS);
  }

  private raise(): void {
    if (this.release !== undefined) {
      return;
    }
    let settle: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      settle = resolve;
    });
    // The executor above ran synchronously, so `settle` is assigned by now.
    this.release = settle;
    void vscode.window.withProgress({ location: { viewId: VIEW_ID } }, () => held);
  }

  private lower(): void {
    this.release?.();
    this.release = undefined;
  }

  private clearTimer(): void {
    if (this.offTimer !== undefined) {
      clearTimeout(this.offTimer);
      this.offTimer = undefined;
    }
  }
}

/**
 * Over the whole snapshot, not the tree's filtered view: the header bar answers
 * "is anything working on this machine", and a search is a question about rows.
 */
function anyGenerating(snapshot: Snapshot): boolean {
  return snapshot.projects.some((project) =>
    project.sessions.some((session) => session.state === 'generating'),
  );
}

