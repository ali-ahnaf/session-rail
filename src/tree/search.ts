/**
 * The session search input.
 *
 * A TreeView cannot host a text field, so the field is an `InputBox` wired to
 * `onDidChangeValue` — the tree re-filters on every keystroke, which is what
 * makes it read as a search box rather than a prompt. Accepting keeps the query;
 * dismissing (Escape) restores whatever was active before the box opened, so a
 * cancelled search leaves no trace. Emptying the box and accepting clears the
 * filter.
 */

import * as vscode from 'vscode';

import type { RailTreeProvider } from './provider';

/**
 * At most one box at a time. Without this, clicking the search row while the box
 * is already open would create a second box whose "restore on cancel" value is
 * the live query, while the first box hides un-accepted and reverts the filter
 * out from under it.
 */
let active: vscode.InputBox | undefined;

export function promptSearch(provider: RailTreeProvider): void {
  if (active !== undefined) {
    active.show();
    return;
  }

  const previous = provider.filterQuery;
  const input = vscode.window.createInputBox();
  active = input;
  input.title = 'Search sessions';
  input.placeholder = 'Filter sessions by title…';
  input.prompt = 'Matches the session title, or its name when it has no title yet.';
  input.value = previous;

  let accepted = false;

  input.onDidChangeValue((value) => provider.setFilter(value));
  input.onDidAccept(() => {
    accepted = true;
    input.hide();
  });
  input.onDidHide(() => {
    if (!accepted) {
      provider.setFilter(previous);
    }
    active = undefined;
    input.dispose();
  });

  input.show();
}

/** Close any open box without applying its pending value. Used on deactivate. */
export function disposeSearch(): void {
  active?.hide();
  active = undefined;
}
