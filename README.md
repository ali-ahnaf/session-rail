# Session Rail

Session Rail shows every running Claude Code session on the machine as a nested sidebar tree in VS Code: project, session, subagent, and task.

## What you see

The tree has four levels:

- **Project** — a working directory (or git root, depending on `sessionRail.groupBy`) that has one or more Claude Code sessions.
- **Session** — a single `claude` process, live or exited. Color reflects state: live/idle, working (generating), waiting on input, or exited.
- **Subagent** — a task-tool invocation spawned by a session, shown nested under the session that spawned it.
- **Task** — an individual to-do item tracked by a session or subagent, shown when `sessionRail.showTasks` is enabled.

## Install / dev

```bash
npm install
npm run watch
```

Then press F5 in VS Code to launch an Extension Development Host with Session Rail loaded.

Other scripts: `npm run build` (production bundle), `npm run typecheck`, `npm run lint`.

If f5 does not work, run: 
```bash
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --extensionDevelopmentPath=/Users/aliahnaf/Projects/claude-hybrid --new-window
```

## Verification

```bash
npm run verify
```

Runs typecheck, lint, both live checks, and a production build.

There are no fixtures. The extension is a reader of state another program writes,
so the checks run against the real `~/.claude` on the current machine:

- `npm run smoke` — the scan layer against known historical sessions, including a
  hand-verified case where agent `a316978cce571e28e` must nest under
  `ac4f0c9f15b73b541`. This caught a real bug: spawn edges live in
  `message.content[]` blocks (`tool_use.id` and `tool_result.tool_use_id`), not in
  the top-level `toolUseID` field.
- `npm run check:registry` — the registry end-to-end against whatever sessions are
  live right now, with `vscode` swapped for `scripts/vscode-stub.js`. It prints the
  tree as the sidebar would render it, which is the fastest way to see whether the
  output matches reality.

Both are machine-dependent by design. A run on a machine whose live sessions never
spawned a nested agent reports that as a coverage gap instead of passing vacuously.

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `sessionRail.refreshInterval` | number | `2000` | How often to poll `~/.claude` for changes, in milliseconds. Lower values cost more CPU. |
| `sessionRail.showTasks` | boolean | `true` | Show task nodes under subagents in the tree. |
| `sessionRail.showExited` | boolean | `false` | Show sessions that have exited. Exited sessions keep their transcript, so they can still be opened for review. |
| `sessionRail.groupBy` | string (`cwd`, `gitRoot`) | `"cwd"` | How to group sessions at the project level of the tree. |
| `sessionRail.claudeHome` | string | `""` | Overrides the location of `~/.claude`. Mainly useful for testing; leave empty to use the default location. |

## How it works

Session Rail reads private, unversioned state under `~/.claude` — the session registry, per-project transcripts, and task files. It is read-only: it never writes to, deletes, or modifies anything under `~/.claude`. Because this state is undocumented and internal to Claude Code, its shape can change between Claude Code releases, and Session Rail may break or show stale data until it is updated to match.
