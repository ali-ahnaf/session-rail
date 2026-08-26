/**
 * Minimal `vscode` module stand-in, so the scan layer and the tree provider can
 * be exercised outside the extension host. Only the members those modules
 * actually touch are implemented: EventEmitter, Disposable,
 * workspace.getConfiguration (vscode.Event is type-only, so it needs no runtime
 * value), plus the handful of TreeItem/theming values items.ts constructs.
 *
 * Aliased in via esbuild's --alias:vscode flag. Test-only; never bundled into
 * dist/extension.js.
 */

class Disposable {
  constructor(callOnDispose) {
    this._callOnDispose = callOnDispose;
  }
  dispose() {
    if (typeof this._callOnDispose === 'function') {
      this._callOnDispose();
    }
  }
}
Disposable.from = (...items) =>
  new Disposable(() => items.forEach((item) => item && item.dispose && item.dispose()));

class EventEmitter {
  constructor() {
    this._listeners = new Set();
    this.event = (listener) => {
      this._listeners.add(listener);
      return new Disposable(() => this._listeners.delete(listener));
    };
  }
  fire(value) {
    for (const listener of [...this._listeners]) {
      listener(value);
    }
  }
  dispose() {
    this._listeners.clear();
  }
}

/** Config values the harness overrides, keyed `section.key`. */
const overrides = Object.create(null);

const workspace = {
  getConfiguration(section) {
    return {
      get(key, fallback) {
        const full = section ? `${section}.${key}` : key;
        return full in overrides ? overrides[full] : fallback;
      },
    };
  },
  onDidChangeConfiguration() {
    return new Disposable(() => {});
  },
};

const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class MarkdownString {
  constructor(value) {
    this.value = value;
  }
}

/**
 * `window.withProgress` calls, so a check can see the view header bar being
 * raised and settled. The real API resolves the bar when the promise the task
 * returns settles, which is exactly what RailProgress relies on — so record the
 * promise and whether it has settled, and nothing else.
 */
const progressCalls = [];

const window = {
  /**
   * The registry reads focus to pick its poll cadence and subscribes for
   * changes. A check runs headless, so the window is always focused (the fast
   * cadence — the one worth exercising) and the event never fires.
   */
  state: { focused: true },
  onDidChangeWindowState() {
    return { dispose() {} };
  },

  withProgress(options, task) {
    const call = { viewId: options && options.location && options.location.viewId, settled: false };
    progressCalls.push(call);
    const result = task({ report() {} }, { isCancellationRequested: false });
    return Promise.resolve(result).then(
      () => {
        call.settled = true;
      },
      () => {
        call.settled = true;
      },
    );
  },
};

/** Context keys the provider sets, so a check can assert on them. */
const contextKeys = Object.create(null);

const commands = {
  executeCommand(command, key, value) {
    if (command === 'setContext') {
      contextKeys[key] = value;
    }
    return Promise.resolve(undefined);
  },
};

module.exports = {
  Disposable,
  EventEmitter,
  workspace,
  window,
  progressCalls,
  commands,
  contextKeys,
  TreeItem,
  TreeItemCollapsibleState,
  ThemeIcon,
  ThemeColor,
  MarkdownString,
  /** Test hook — not part of the real vscode API. */
  __setConfig(key, value) {
    overrides[key] = value;
  },
};
