/**
 * Minimal `vscode` module stand-in, so the scan layer can be exercised outside
 * the extension host. Only the members registry.ts actually touches are
 * implemented: EventEmitter, Disposable, and workspace.getConfiguration
 * (vscode.Event is type-only, so it needs no runtime value).
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

module.exports = {
  Disposable,
  EventEmitter,
  workspace,
  /** Test hook — not part of the real vscode API. */
  __setConfig(key, value) {
    overrides[key] = value;
  },
};
