/**
 * The one read of `workbench.reduceMotion`.
 *
 * Two places need it — the row icons in `items.ts` and the view header bar in
 * `progress.ts` — and they must never disagree, so the predicate lives here
 * rather than being spelled out twice in the same layer.
 */

import * as vscode from 'vscode';

/**
 * Whether an animated icon is allowed.
 *
 * Read on demand rather than through a config listener, the same way
 * `showExited()` is read in provider.ts — VS Code caches configuration
 * in-process and the tree is tens of rows. The cost of that choice: a row or the
 * header bar only picks up a change to the setting on the next tree render or
 * snapshot change, not the instant the setting is saved.
 *
 * `'auto'` (the default) and `'off'` both animate; only an explicit `'on'`
 * suppresses it, in which case every row keeps the static dot it had before the
 * spinner existed.
 */
export function motionAllowed(): boolean {
  return (
    vscode.workspace.getConfiguration('workbench').get<string>('reduceMotion', 'auto') !== 'on'
  );
}
