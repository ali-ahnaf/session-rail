# CLAUDE.md — Session Rail

Guidance for agentic coding agents working in this repository.

## What this is

A VS Code extension (`sessionRail`) that shows every Claude Code session running
on the machine as a nested sidebar tree:

```
project (grouped cwd)
  └── session (a running `claude` process)
        ├── subagent (arbitrarily nested)
        └── task (the session's todo list)
```

**It is a reader.** Every fact it displays is scraped from state Claude Code
writes under `~/.claude`. It owns no data of its own and writes nothing back.

Stack: TypeScript (ES2022, CommonJS, strict), esbuild bundle → `dist/extension.js`,
**zero runtime dependencies** — Node stdlib and the `vscode` API only. Do not add a
runtime dep without a strong reason; the whole extension is 36 KB bundled.

## Where the detail lives

| Task | Read first |
| --- | --- |
| Any change at all | The three frozen contracts, below |
| Data shapes | `src/model/types.ts` |
| Anything touching `~/.claude` paths | `src/scan/paths.ts` |
| The tree levels and visual grammar | `docs/design.html` (open in a browser) |
| Settings, commands, colors | `contributes` in `package.json` |

## Frozen contracts — read before editing, change deliberately

These three files are depended on by everything else. Changing a shape here means
updating every consumer in the same commit.

- **`src/model/types.ts`** — two families. `*Record`/`*Meta` mirror raw on-disk
  JSON; `*Node` are the normalized tree. Raw fields are optional unless observed
  in every version, because `~/.claude` drifts (see Drift below). `FilterNode` is
  the one exception to "nodes mirror disk": a presentation-only pseudo-node the
  tree provider builds for the search row. It never appears in a `Snapshot`.
- **`src/scan/paths.ts`** — every `~/.claude` location. **Never join a
  `~/.claude` path by hand anywhere else.** `resolveProjectDir()` tries the
  `/`→`-` encoding, then falls back to scanning `projects/` and reading each
  candidate's real `cwd`, so unusual path characters can't silently break the tree.
- **`src/util/log.ts`** — `import { log, safely, safelyAsync }`. Nothing in this
  extension writes to `console`.

## Layer map

```
scan/          reads disk, owns all inference        (no VS Code UI concepts)
  paths        locations + cwd encoding
  sessions     session registry + liveness probing
  history      past sessions recovered from transcripts (the registry is not a history)
  agents       subagent metas + parent resolution + forest building
  tasks        per-session todo lists
  titles       `ai-title` records → the row label, live fold + bounded tail read
  tailer       byte-offset NDJSON reader
  registry     orchestrator: poll loop → Snapshot → onDidChange
tree/          Snapshot → TreeItems                  (no filesystem access)
  provider     TreeDataProvider, parent map for reveal(), the session filter
  items        row construction, the visual grammar
  search       the input box that drives the filter (no field widget exists)
terminal/
  link         session pid → vscode.Terminal via ps ancestry
  resume       open-or-resume: focus the host terminal, else `claude --resume`
status/        one status-bar item
transcript/    read-only webview transcript reader
workspace/
  explorer     show a directory in the Explorer (add root / reveal)
extension.ts   activation + command wiring only — a switchboard, no logic
```

Direction of dependency is one-way: `extension → {tree, status, transcript, terminal, workspace} → scan → model`.
Nothing in `scan/` may import from `tree/`. Only `scan/registry.ts` in that layer
imports `vscode` (for `EventEmitter` and config); keep it that way so the rest
stays runnable outside the extension host.

## Hard invariants

- **Read-only.** Never write, move, or delete anything under `~/.claude`. Three
  actions affect processes rather than files: `sessionRail.stopSession` sends
  SIGTERM behind a modal confirm, `sessionRail.focusTerminal` may start a
  `claude --resume` in a new terminal, and `sessionRail.newSession` starts a
  plain `claude` in a project directory. The extension still writes nothing
  itself — but those processes do, so never point one at a transcript another
  live process owns (see the fork rule below).
- **`showInExplorer` is the one write outside `~/.claude`.** Adding a workspace
  root always lands on disk somewhere: with a saved `.code-workspace`,
  `updateWorkspaceFolders` writes the new folder into that file — an edit to the
  user's own repo config; without one, VS Code mints an untitled workspace under
  user data and `migrateWorkspaceSettings` copies folder-scoped settings into it.
  Hence **add-only, never toggle** — a stray click must not remove a root the
  user arranged by hand, so a directory already reachable from a root is only
  revealed. Two clicks are gated behind a modal confirm because they are
  expensive rather than wrong: `os.homedir()` (an ordinary row to click —
  `newSessionHome` still falls back to it when no folder is open — and one that
  puts a recursive watcher over the whole home dir) and the filesystem root. See
  `src/workspace/explorer.ts` for the branch behavior the VS Code source actually
  has — worth reading before touching it, because three of its four cases are
  counter-intuitive.
- **One process per transcript, always.** A live session with no terminal in
  this window is running somewhere we can't see, and two processes on one
  transcript corrupt it. `terminal/resume.ts` therefore never sends a plain
  `--resume` for a live session until it has *proof* the old process is gone:
  either the user adopts it (SIGTERM, then poll `process.kill(pid, 0)` until
  ESRCH, bounded at 5s) or it forks with `--fork-session`. An adopt whose kill
  is refused, errors, or times out falls back to a fork — the rule holds by
  construction, never by timing. `sessionRail.openLiveSession` picks the
  default (`ask` | `adopt` | `fork`); an exited session always gets a plain
  `--resume` with no prompt.
  Adopt exists because a fork mints a NEW session id (`claude --help`:
  "--fork-session … create a new session ID instead of reusing the original"),
  which shows up as a second row for one conversation. A plain resume keeps the
  id, so `registry.ts` `dedupeRecords` collapses the dead `<oldpid>.json` and
  the new live record onto the same row.
- **Never interpolate disk state into a shell command unquoted.** The session id
  is matched against `SAFE_SESSION_ID` and the open is refused outright if it
  doesn't fit; `~/.claude` is unversioned, so the shape is not guaranteed.
- **Parent linkage comes from content blocks, not the top-level `toolUseID`.**
  A subagent's parent is found by matching its `meta.toolUseId` against
  `message.content[]` blocks:
  - `{type:"tool_use", id:"toolu_…"}` — the transcript's owner spawned that id
  - `{type:"tool_result", tool_use_id:"toolu_…"}` — that id completed

  The top-level `toolUseID` field is `null` on these records and belongs to
  something else; it is kept only as a weak gap-filler that never overwrites a
  content-block edge. **This was a real bug** — see History.
- **Never filter on the spawning tool's `name`.** It is `Agent` in some versions
  and `Task` in others. Index every `tool_use` block id regardless of name.
- **The `subagents/` directory is flat.** All agents of a session live in it at
  every depth. Depth comes from `spawnDepth` and structure comes from
  `toolUseId` matching — never from directory position.
- **Tail, never re-parse.** Transcripts are append-only and reach many megabytes.
  Use `Tailer` (per-file byte offsets, 4 MB delta cap, 512 KB cold-start seed).
  A `**/*.jsonl` watcher that re-reads on change will stall the extension host.
- **Session liveness needs two signals.** `sessions/*.json` outlives the process,
  so `process.kill(pid, 0)` alone is not enough — `procStart` is compared against
  `ps -o lstart=` to guard PID reuse. Results cache for ~2s so a poll cycle
  doesn't shell out repeatedly.
- **The session registry is not a history; transcripts are.** `sessions/<pid>.json`
  tracks processes, and on this machine holds nothing else (see Drift), so
  `showExited` alone can show an empty list. `scan/history.ts` recovers past
  sessions from `projects/<enc-cwd>/<sessionId>.jsonl` inside `historyDays`.
  Those rows are `source: 'transcript'` and deliberately shallow: **never
  tailed**, so `agents: []` and `tasks: []` and no branch/model/effort, and
  their files never enter `trackedFiles`. The one thing they do read cold is
  the newest `ai-title` (`scan/titles.ts`, last 64 KB, cached on mtime+size, so
  a frozen transcript is read exactly once) — a single string, no `ingest`, no
  `spawnIndex`, so the rule below still holds. A live row folds its title out of
  the tail deltas instead; its cold read is a seed-window fallback that
  `registry.coldTitles` runs at most once per session, because a growing file
  misses the mtime cache every tick.
  Cold-reading an old transcript would
  rebuild an agent forest with no `spawnIndex` and strand depth-2 agents at the
  root — the shape `scripts/smoke.ts` forbids. Empty beats half a forest.
- **`pid: 0` is the history sentinel — refuse it, never signal it.**
  `process.kill(0, …)` signals the whole process group, so every consumer that
  signals or walks a pid checks `pid > 0` first (`stopSession`, `openSession`,
  `pidRunning`). `SessionNode.source` is the honest discriminator; the pid is
  only a placeholder for a process that no longer exists.
- **Subagents have no pid and no socket.** They are in-process. A subagent is done
  only when a `tool_result` for its `toolUseId` appears. Without that signal it
  would show busy forever.
- **`SessionState.waiting` is never emitted.** It is not derivable from disk. The
  type exists for a future hook-based signal; don't fake it.
- **Every filesystem read is defensive.** A missing dir, a permission error, or a
  half-written final JSON line must degrade gracefully. Collect problems into
  `Snapshot.warnings`; never throw out of a refresh or out of
  `getChildren`/`getTreeItem`.
- **Escape everything in the webview.** Transcripts contain arbitrary model and
  tool output. `transcript/panel.ts` routes every interpolated value through one
  `escapeHtml` helper, under a strict CSP with a per-render nonce. No exceptions.

## Drift — this reads private, unversioned state

Everything under `~/.claude` is Claude Code internals with no compatibility
guarantee. Observed drift already: `2.1.216` subagent records carry `slug`;
`2.1.233` session records carry `name`/`nameSource`/`nameSince`; and on
2026-08-17 `sessions/` held **zero** stale records (11 files, 11 live pids),
where records were previously seen to outlive their process. So `showExited`
can be wired correctly and still reveal nothing — an empty exited list is not
evidence the toggle is broken. Mechanism unconfirmed (delete-on-exit vs. a
cleanup job); don't build on either. Transcripts at `2.1.233` also carry
`{"type":"ai-title","aiTitle":…}` and `{"type":"last-prompt",…}` records —
neither has a `timestamp`, both are rewritten repeatedly, so file order is the
only ordering and the last one wins. `ai-title` is the session title Claude
Code's own VS Code extension shows, and `scan/titles.ts` is the only thing that
reads it. `last-prompt` is deliberately unused: a title is a summary, a prompt
is a 200-char paste, and synthesizing one from the other is the same mistake as
faking `SessionState.waiting`.

Consequences for any change here:

- Treat every raw field as possibly absent. Narrow `unknown` explicitly.
- Prefer structural matching over exact field names where both are available.
- When a shape is unrecognized, degrade to a flatter view and add a warning —
  never crash the tree.
- Re-run `npm run verify` after a Claude Code upgrade. It is the canary.

## Commands

```bash
npm install
npm run watch            # esbuild watch; then press F5 for the Extension Host
npm run build            # production bundle → dist/extension.js
npm run typecheck        # tsc --noEmit
npm run lint             # eslint src
npm run smoke            # scan layer vs. real ~/.claude, known historical sessions
npm run check:registry   # registry end-to-end, prints the tree as the sidebar renders it
npm run verify           # all of the above + build. Run this before declaring done.
```

## Verification approach

**There are no fixtures, and that is deliberate.** The extension's entire job is
reading state another program writes, so fixtures would only prove that the code
agrees with assumptions that were already wrong once.

- `scripts/smoke.ts` — the scan layer against known historical sessions, including
  a hand-verified ground truth: in session `c5476e2d-…` agent `a316978cce571e28e`
  (spawnDepth 2) must nest under `ac4f0c9f15b73b541`, and no agent with
  spawnDepth > 1 may remain at the root.
- `scripts/registry-check.ts` — the registry executed for real against whatever
  sessions are live now, with `vscode` aliased to `scripts/vscode-stub.js`. Prints
  the rendered tree; fastest way to compare output against reality.

Both are machine-dependent by design. A machine whose live sessions never spawned
a nested agent reports that as a **coverage gap** rather than passing vacuously —
if you add checks, preserve that property. Do not convert a machine-dependent
check into a passing no-op.

`scripts/` and `docs/` are excluded from the packaged extension via `.vscodeignore`.

## Contribution surface (keep code and package.json in sync)

- View container `sessionRail`, view `sessionRail.tree`.
- Commands: `sessionRail.` + `refresh`, `focusTerminal`, `newSession`,
  `newSessionHome`, `openTranscript`, `showInExplorer`, `revealFolder`,
  `copySessionId`, `stopSession`, `toggleTasks`, `showExited`, `hideExited`,
  `searchSessions`, `clearSearch`, `showLog`.
- `showInExplorer` is the `$(folder-opened)` inline icon at the right end of
  every project and session row (`inline@3`, after `newSession`/`focusTerminal`
  at `@1` and `openTranscript` at `@2`). It is **not** `revealFolder`, which is
  `revealFileInOS` — Finder, a different action, and still menu-only with no
  icon. The Explorer can only render workspace roots and their contents, so
  showing an arbitrary directory means appending a root; `vscode.openFolder` is
  the wrong call because it replaces the window's contents. Append at the END,
  because adding/removing/changing folder 0 restarts every extension by
  contract. Node resolution and the `when` clause mirror `revealFolder`
  (`asProject(node)?.dir ?? asSession(node)?.cwd`), so it works on both readings
  of "the session's folder".
- `showExited`/`hideExited` are one view-title toggle for the `showExited`
  setting, split into two commands so the icon can show state — exactly one is
  visible, gated on the `sessionRail.exitedVisible` context key. Both write the
  setting; the config listener flips the key, so the icon stays right when the
  setting is changed from the Settings UI instead.
- `contextValue` strings the menus key off — only these are ever set:
  `project`, `session.live`, `session.exited`, `agent`, `task`. State beyond
  live/exited affects icon color only, never `contextValue`. The search row sets
  **none** — it owns no menu, and every contributed menu is `viewItem ==`-gated.
- **Search is provider state, not a setting.** A query is transient, so
  `RailTreeProvider.filter` holds it and it dies with the window; `setFilter`
  fires the tree change and never touches the registry, because the filter is
  re-applied to whatever snapshot the next poll produces. Do not mirror the
  `showExited` shape here — round-tripping a query through disk polling and
  persisting it across restarts are both wrong for a search.
  A TreeView cannot host a text input, so the "field" is two pieces: the
  `filter` pseudo-node rendered as the first root child (directly under the view
  header), and a live `InputBox` in `tree/search.ts` wired to `onDidChangeValue`.
  Escape restores the query the box opened with; accepting an empty box clears.
  Two rules the row exists to protect: it is returned **even at zero matches**
  (an empty root hands the view to `viewsWelcome`, which would claim the machine
  has no sessions), and while a filter is active project rows render `Expanded`
  regardless of `liveCount` (a collapsed match is an invisible match). Matching
  is a trimmed, case-insensitive substring of the label — `title ?? name`, so a
  live session with no `ai-title` yet is still findable.
  **The search covers only what the tree is showing.** `registry.ts` drops exited
  and history rows when `showExited` is off, so with stock settings a search
  reaches live sessions only. That is why a zero-match row reads
  `no matches · exited hidden` — a miss must not imply the session never
  existed. Widening it means changing what the registry collects, not the filter.
  `clearSearch` is the view-title `✕`, visible on the `sessionRail.searchActive`
  context key, which `setFilter` maintains.
  Known limit: because `TreeItem.id` is stable by design, a project the user
  collapsed by hand stays collapsed under a search.
- Config: `sessionRail.` + `refreshInterval` (2000, clamped 500–30000),
  `showTasks` (true), `showExited` (false), `historyDays` (7, clamped 0–90),
  `groupBy` (`cwd`|`gitRoot`), `terminalLocation` (`editor`|`panel`),
  `openLiveSession` (`ask`|`adopt`|`fork`), `claudeHome` (`""`, testing override).
- `newSession` is the inline `+` on every project row: it opens a shell terminal
  rooted at the project's `dir` and sends `claude`. The new session appears in
  the tree on a later poll, once it registers itself under `~/.claude`. It must
  stay a shell terminal plus `sendText` — `shellPath: 'claude'` is the tempting
  shape and the wrong one, because the extension host's PATH is not the login
  shell's (a version-manager `claude` is invisible to it) and running it as a
  shell command keeps `claude` a child of the shell, which is what
  `findTerminalForPid` walks. A missing directory is refused, not silently
  swapped for the window default.
- `newSessionHome` is the same `+` in the view title bar, for a session that
  belongs to no project row yet. It shares `startSession` and differs only in
  how the directory is chosen — the window's own folder, because that is what
  the header `+` means in practice: no `workspaceFolders` → `os.homedir()`; one
  folder → its `uri.fsPath`, no prompt; two or more →
  `window.showWorkspaceFolderPick`, and Escape starts nothing. The one-folder
  case is branched explicitly so that an unambiguous window can never prompt,
  whatever the pick does internally. It takes no node, so unlike the other
  node-driven commands it stays visible in the command palette (the title is
  "New Session in Workspace Folder"; the id keeps the `Home` spelling so existing
  keybindings survive).
- `focusTerminal` is the click action on every session row, live or exited, and
  never dead-ends: it focuses the hosting terminal if this window has one, else
  reuses the terminal it opened earlier for that session, else opens a new one
  that resumes the session — adopting or forking it first if it is live
  elsewhere (see the one-process-per-transcript invariant). User-visible
  failures: a refused session id, and an adopt that fell back to a fork.
- Colors: `sessionRail.` + `live`, `working`, `exited`, `waiting`. Semantic only —
  they are not a brand accent.
- `TreeItem.id` is `${kind}:${id}` so expansion state survives refreshes. The
  trade-off is that a manually collapsed row stays collapsed even when fresh data
  computes `Expanded`. Intended, not a bug.

## History — bugs worth not repeating

1. **Spawn edges were read from the wrong field.** The original spec claimed a
   top-level `toolUseID`. Evidence was a substring `grep` that confirmed the id
   was *in the file* while proving nothing about which field held it. Result: the
   spawn index had 5 entries instead of 278 and all 7 agents sat at the root.
   Lesson: a substring match is not field evidence — parse the JSON and print the
   key.
2. **`getParent` keyed by object identity** broke `reveal()`, because
   `registry.findSession()` can hand back a node from a different snapshot
   instant than the one the parent map was built from. Now keyed by
   `${kind}:${id}`.
3. **Strict `style-src 'nonce-…'` blocked VS Code's own injected stylesheet**,
   which is what defines the `--vscode-*` variables the webview depends on.
   `webview.cspSource` must be in `style-src` alongside the nonce.
4. **A test asserted historical properties against the live set** (depth-2
   nesting, task lists) and failed on a healthy machine. Those checks now report
   coverage instead of failing.

## Not implemented, deliberately

- **Writing into a session** via `messagingSocketPath`. Undocumented IPC
  (`peerProtocol: 1`); a good way to disrupt a live run. Read-only for now.
- **Hook-driven events.** The intended second half: `SessionStart`,
  `SubagentStop`, and `Stop` hooks POSTing to a localhost server would replace
  polling for liveness and give a real `waiting` signal. Hooks are a documented,
  stable surface — prefer them over more filesystem inference when adding
  event-driven behavior.
- **Windows terminal focus.** The `ps` ancestry walk is POSIX-only and degrades to
  a "started elsewhere" notice. Everything else is cross-platform.

## Open question

`~/.claude/tasks/` has held no entries for any live session in practice. If that
stays true, the task level may belong in the transcript view rather than the tree.
Don't build further on the task level without checking whether it earns its place.
