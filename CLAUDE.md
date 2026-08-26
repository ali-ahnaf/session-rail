# CLAUDE.md — Session Rail

Guidance for agentic coding agents working in this repository.

## What this is

A VS Code extension (`sessionRail`) that shows every Claude Code session running
on the machine as a nested sidebar tree:

```
Pinned (accordion, only when something is pinned)
  └── project (a pinned folder, in pin order)
project (grouped cwd)
  └── session (a running `claude` process)
        ├── subagent (arbitrarily nested)
        └── task (the session's todo list)
```

**It is a reader.** Every fact it displays is scraped from state Claude Code
writes under `~/.claude`, and it writes nothing back. The only thing it owns is
which folders the user pinned — see the pins invariant.

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
  in every version, because `~/.claude` drifts (see Drift below). `FilterNode`
  and `SectionNode` are the exceptions to "nodes mirror disk": presentation-only
  pseudo-nodes the tree provider builds for the search row and the `Pinned`
  accordion. Neither ever appears in a `Snapshot`.
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
  provider     TreeDataProvider, parent map for reveal(), the session filter,
               the pinned/unpinned root split
  items        row construction, the visual grammar
  search       the input box that drives the filter (no field widget exists)
  pins         pinned folders, persisted in globalState (the only state we keep)
  progress     holds the view header's progress bar while anything is generating
  motion       the single read of `workbench.reduceMotion`, shared by both
terminal/
  link         session pid → vscode.Terminal via ps ancestry
  resume       open-or-resume: focus the host terminal, else `claude --resume`
status/        one status-bar item
transcript/    read-only webview transcript reader
workspace/
  explorer     show a directory in the Explorer (add root / reveal)
  scratchpad   create a throwaway .md next to the work and open it
  worktree     git worktree create/remove — the one module that shells out to git
extension.ts   activation + command wiring only — a switchboard, no logic
```

Direction of dependency is one-way: `extension → {tree, status, transcript, terminal, workspace} → scan → model`.
Nothing in `scan/` may import from `tree/`. Only `scan/registry.ts` in that layer
imports `vscode` (for `EventEmitter` and config); keep it that way so the rest
stays runnable outside the extension host.

## Hard invariants

- **Read-only.** Never write, move, or delete anything under `~/.claude`. Four
  actions affect processes rather than files: `sessionRail.stopSession` sends
  SIGTERM behind a modal confirm, `sessionRail.focusTerminal` may start a
  `claude --resume` in a new terminal, `sessionRail.newSession` starts a plain
  `claude` in a project directory, and `sessionRail.newSessionHome` starts either
  of those or a bare shell. The extension still writes nothing into `~/.claude`
  itself — but those processes do, so never point one at a transcript another
  live process owns (see the fork rule below).
- **A few commands write outside `~/.claude`; nothing writes inside it.** The
  Scratchpad branch of `newSessionHome` creates a new `scratchpad-<timestamp>.md`
  in the chosen folder (`src/workspace/scratchpad.ts`) — always opened `wx`, so
  an existing file makes it move to the next `-2` suffix instead of truncating
  something the user cares about, and nothing is ever deleted.
  `showInExplorer` writes indirectly: adding a workspace
  root always lands on disk somewhere — with a saved `.code-workspace`,
  `updateWorkspaceFolders` writes the new folder into that file — an edit to the
  user's own repo config; without one, VS Code mints an untitled workspace under
  user data and `migrateWorkspaceSettings` copies folder-scoped settings into it.
  Hence **add-only, never toggle** — a stray click must not remove a root the
  user arranged by hand, so a directory already reachable from a root is only
  revealed. The worktree pair (`newWorktreeSession`/`removeWorktree`,
  `src/workspace/worktree.ts`) writes into the user's own filesystem via `git`:
  create adds `<globalStorage>/worktrees/<repo>/<branch>` — outside
  every repo, so not even an ignored directory appears in the user's checkout,
  and under a `<repo>` level because the base is shared machine-wide and two
  repos with a `main` branch would otherwise collide on one path. The base is
  `context.globalStorageUri.fsPath`, passed down from `extension.ts` as an
  argument so `workspace/worktree.ts` never imports `vscode`; the
  obvious-looking `~/.vscode/extensions/session-rail/` is deliberately **not**
  used, because that is VS Code's own install directory and it prunes there,
  whereas globalStorage survives extension updates and is pruned by nothing.
  The branch
  keeps its slashes and the folder does not (`worktreeFolderName` flattens
  `/`→`-`, or `feat/auth` would mint an intermediate `feat` directory and label
  the row `auth`); every worktree path goes through it and no git branch
  argument does (name validated by
  `validateWorktreeName` before it becomes a path and a branch; always
  `execFile` with an args array, never a shell string), and remove — the one
  action that deletes a directory — sits behind a modal confirm, refuses while
  any session in it is live, and needs a second explicit confirm before
  `--force` on a dirty tree; the branch is never deleted. Two clicks are gated
  behind a modal confirm because they are
  expensive rather than wrong: `os.homedir()` (an ordinary row to click —
  `newSessionHome` still falls back to it when no folder is open — and one that
  puts a recursive watcher over the whole home dir) and the filesystem root. See
  `src/workspace/explorer.ts` for the branch behavior the VS Code source actually
  has — worth reading before touching it, because three of its four cases are
  counter-intuitive.
- **Pins are the only state this extension owns.** `src/tree/pins.ts` keeps them
  in `context.globalState` — not a setting, because the values are absolute
  machine paths managed entirely by clicking, and Settings Sync would carry them
  to machines where they mean nothing (`setKeysForSync` is deliberately never
  called). Two consequences worth keeping: a stored value from an older version
  is narrowed like any `~/.claude` record (a non-array degrades to no pins rather
  than throwing during activation), and the store updates memory and fires its
  event *before* awaiting the write, because a failed `globalState` update costs
  a pin at the next window whereas a tree that ignored the click looks broken
  now. Pin order is display order — a list the user arranged must not reshuffle
  itself when a session starts, which is why the section ignores the snapshot's
  activity ordering.
- **A pinned folder outlives its sessions.** `splitRoots()` synthesizes a
  `ProjectNode` from the path when the snapshot has no project for a pinned dir
  (nothing live, exited rows hidden, or the folder deleted), because a pin that
  vanishes the moment the work stops is not a pin. It is built from the string
  alone — the tree layer does no filesystem access, so a deleted folder is only
  reported when something tries to use it (`newSession` refuses it by name).
  Those placeholders drop out while a search is active: the search is over
  sessions, and a row with none of them cannot match.
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
- **`SessionState` is not a pure function of the current tick.** `generating`
  carries a sticky hold: `deriveSessionState` records the tick whenever the
  10 s activity window (or a running subagent) fires, and keeps returning
  `generating` for `SESSION_STICKY_MS` (20 s) after that. A long tool call
  writes nothing to the transcript, so without the hold the spinner blinks off
  mid-turn and reads as a bug. Two rules the implementation depends on: the
  anchor is the last tick the **window** fired, never the last tick the function
  returned `generating` — re-anchoring on its own output holds the state open
  forever, one poll at a time — and `alive === false` short-circuits before the
  hold is consulted, so an exited session never spins. The hold lives on
  `SessionScan.lastGeneratingTick` in `scan/registry.ts`, which is the single
  source of truth the tree, the status bar, and `signatureOf` all read; it is
  pinned by `scripts/sticky-check.ts` with an injected clock. Subagents are
  deliberately **not** held — `AGENT_ACTIVE_WINDOW_MS` and a `tool_result`
  still decide them.
  The cost is accepted, and it is **the two spans added, not the hold alone**:
  the hold is armed on the tick the window fires, which is itself up to
  `SESSION_ACTIVE_WINDOW_MS` after the real last activity, so `generating` ends
  at roughly `lastActivityAt + 30 s`, not `+ 20 s`. `sticky-check.ts` is the
  authority on the number — it asserts `generating` at t+15 s and `idle` at
  t+31 s. Retuning the overstay means changing `SESSION_STICKY_MS`, and reading
  the total as 30 s while you do it.
  One consequence of anchoring on a tick rather than on `lastActivityAt`: the
  hold assumes polls are frequent relative to itself. At the top of
  `refreshInterval`'s allowed range (30 s) two consecutive polls can be further
  apart than `SESSION_STICKY_MS`, and the hold stops contributing anything.
  That is also the constraint that fixes `IDLE_INTERVAL_MS` at 15 s rather than
  something larger — see the poll-cadence invariant below.
- **Poll cadence tracks window focus, and nothing else does.** Every VS Code
  window runs its own registry over the same machine-wide `~/.claude`, so N
  windows do N times the identical scanning — the only cost here that grows with
  how the user arranges their editor rather than with how much Claude Code is
  running. An unfocused window therefore polls at a floor of
  `IDLE_INTERVAL_MS` (15 s) instead of `refreshInterval`; a configured interval
  already longer than that still wins, which is why it is a floor and not a
  fixed value. Two things keep this from being observable. Regaining focus calls
  `tick()` immediately rather than waiting out the pending long timer, so the
  slow cadence only ever applies to a window nobody is reading — the status bar
  included, which is why the gate is focus and **not** `TreeView.visible`: the
  status bar is visible whether or not the rail is, and a focused window with
  the sidebar closed must stay current. And 15 s sits deliberately below
  `SESSION_STICKY_MS` (20 s), because the sticky hold is anchored on a tick —
  an idle cadence at or above the hold would stop it contributing and bring back
  the mid-turn spinner blink. Raising `IDLE_INTERVAL_MS` past 20 s means
  re-reading `deriveSessionState` first. Focus is read once in the registry's
  constructor and kept current by its own `onDidChangeWindowState`
  subscription — it is the poll loop's business, so no caller has to remember to
  wire it.
- **Motion is opt-out, and only motion is.** Every animated icon
  (`loading~spin` on session, subagent, and project rows) plus the view header
  progress bar is suppressed when `workbench.reduceMotion` is `'on'`; `'auto'`
  and `'off'` both animate. It is read inline at render time in `tree/items.ts`
  and `tree/progress.ts` — the same read-on-demand pattern as `showExited()` —
  so there is **no config listener to keep in sync**. What must never move into
  that branch is the non-animated half of the signal: the project row's
  `N working` segment and the `Activity: working` tooltip line are text, and a
  user who turned motion off still needs them.
- **The header bar and the rows can disagree under a search, by design.** A
  project row's spinner and its `N working` count are computed from
  `node.sessions`, which is the *filtered* list while a search is active, whereas
  `tree/progress.ts` reads the unfiltered `snapshot.projects` — the header bar
  answers "is anything working on this machine", which a search should not
  change. So a search that hides the only working session leaves the bar
  spinning over a tree with no spinner in it. Correct, and surprising enough to
  be worth reading twice before "fixing" either side.
- **A project row's icon does not always encode pin state.** One slot, three
  claims on it, in order: `loading~spin` while any child session is generating
  (and motion is allowed), then `$(git-branch)` on a worktree, then
  `$(pinned)`, then `$(folder)`. A worktree outranks a pin because a worktree
  row nested under an ordinary-looking repo row has nowhere else to say what it
  is but its description text, whereas pin state has three other homes: the
  `Pinned` section the row sits under, the Pin/Unpin context menu, and
  `contextValue` — which is untouched, so every menu `when` clause keeps working.
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
  A trap worth knowing before editing that file: the whole page is one
  TypeScript template literal, so a stray backtick anywhere inside it — a
  Markdown-style quote in a comment in the inlined `<script>`, say — terminates
  the string and breaks the build in a place the error does not point at.
- **The transcript panel is not retained while hidden.**
  `retainContextWhenHidden` keeps a webview's entire DOM alive for the life of
  the tab, and this one holds up to `MAX_TAIL_BYTES` (512 KB) of rendered
  transcript per open panel per window — the largest retained allocation the
  extension is capable of. It is deliberately left off: VS Code re-applies
  `webview.html` when the tab is revealed, so the content returns by itself, and
  the only DOM state worth carrying across a hide is the scroll offset, which
  the page checkpoints through `setState`/`getState`. The consequence to keep in
  mind is that the inlined script re-runs on every reveal, so anything it should
  remember has to live in webview state rather than in a variable.

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
npm run check:pins       # pinned-folders view logic (deterministic, no disk)
npm run check:sticky     # sticky generating hold + icon mapping (deterministic, injected clock)
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
- `scripts/pins-check.ts` — deterministic, and one of the two places a stand-in
  snapshot is allowed: pins are the extension's **own** state, so there is no
  on-disk shape to drift and nothing machine-dependent to observe. It runs the
  real `RailTreeProvider` and `PinStore` over a fake registry and an in-memory
  `Memento`. Do not extend it to cover anything read from `~/.claude`; that is
  what the two machine-dependent checks are for.
- `scripts/sticky-check.ts` — deterministic for the same reason: it calls the
  exported `deriveSessionState` with an injected clock, renders hand-built nodes
  through the real `toTreeItem`, and drives a real `RailProgress` off a stubbed
  `window.withProgress`, flipping `workbench.reduceMotion` on the stub in
  between. It is the only check that reaches the motion-suppressed branch or the
  progress bar's raise/off-delay/dispose sequence at all, since neither is
  something a check can arrange on a live machine.

**`scripts/` is typechecked, and it has to be.** esbuild bundles the checks by
stripping types without checking them, so a check can build a node with a
required field missing and still print a row of passes — which happened once
already. `npm run typecheck` therefore runs twice: the root `tsconfig.json` for
the bundle, then `tsconfig.scripts.json` over `src` **and** `scripts`. A check
that constructs a `~/.claude`-shaped node or a registry-private type should
annotate it, so the next field added to that type breaks the build instead of
being quietly ignored.

`smoke.ts` and `registry-check.ts` are machine-dependent by design. A machine whose live sessions never spawned
a nested agent reports that as a **coverage gap** rather than passing vacuously —
if you add checks, preserve that property. Do not convert a machine-dependent
check into a passing no-op.

`scripts/` and `docs/` are excluded from the packaged extension via `.vscodeignore`.

## Contribution surface (keep code and package.json in sync)

- View container `sessionRail`, view `sessionRail.tree`.
- Commands: `sessionRail.` + `refresh`, `focusTerminal`, `newSession`,
  `newSessionHome`, `newWorktreeSession`, `removeWorktree`, `openTranscript`,
  `showInExplorer`, `revealFolder`, `copySessionId`, `stopSession`,
  `toggleTasks`, `showExited`, `hideExited`, `pinProject`, `unpinProject`,
  `searchSessions`, `clearSearch`, `showLog`.
- `showInExplorer` is the `$(folder-opened)` inline icon at the right end of
  every project and session row (`inline@4`, after `newSession`/`focusTerminal`
  at `@1`, `newWorktreeSession`/`openTranscript` at `@2`, and `pinProject` at
  `@3`). It is **not** `revealFolder`, which is
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
  `project`, `project.pinned`, `project.worktree`, `project.worktree.pinned`,
  `session.live`, `session.exited`, `agent`, `task`.
  Session state beyond live/exited affects icon color only, never
  `contextValue`; the project values carry two flags beyond the node kind, in a
  fixed order `project[.worktree][.pinned]` — a row must offer Pin or Unpin and
  never both, and Remove Worktree only where git can remove one. Every
  project-row menu is therefore gated on `viewItem =~ /^project/` rather than
  `viewItem == project` — add a menu for projects and it needs the regex, or it
  silently disappears the moment the folder is pinned or is a worktree. The
  pin pair is the exception (exact-match lists, one per flag combination), and
  `newWorktreeSession` deliberately excludes worktree rows
  (`/^project(\.pinned)?$/`) — a worktree of a worktree resolves its `<repo>`
  level from the worktree's own basename, scattering branches of one repo under
  two different folders. The search row and the
  `Pinned` section row set **none** — they own no menus.
- **Pinning is `globalState`, not a setting and not a snapshot field.**
  `pinProject`/`unpinProject` are the `$(pin)`/`$(pinned)` inline icon at
  `inline@3` on every project row plus a `navigation@5` context-menu entry;
  exactly one of the pair is ever visible, gated on `viewItem == project` vs. `viewItem == project.pinned` —
  the same show-the-state split as `showExited`/`hideExited`, but keyed on the
  row rather than a context key. Both are node-driven, so both are hidden from
  the command palette. Neither refreshes the registry: `PinStore` fires its own
  change event, the provider re-renders the snapshot it already holds. The
  `Pinned` section is a `SectionNode` built in `provider.recompute()`, which is
  the single place root rows and the parent map are computed — they must stay in
  lock-step, because the section object a pinned project's `getParent()` returns
  has to be the very object `getChildren(undefined)` handed the view, or
  `reveal()` breaks the way it did in History #2. Root order is fixed: search
  row, `Pinned`, then everything unpinned. A pinned dir is matched against
  `project.dir` through `normalizeDir` (trailing separators dropped), so
  switching `groupBy` between `cwd` and `gitRoot` can leave a pin pointing at a
  directory no project row uses any more; it renders as a placeholder rather
  than disappearing.
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
  is a trimmed, case-insensitive substring of the label — `sessionLabel` in
  `model/types.ts`, the one fold items.ts also renders: title, then the git
  branch while the name is only the sessionId fallback (a fresh worktree
  session reads `fix-auth`, not an 8-char hash), then name. A live session
  with no `ai-title` yet is still findable, and the search always matches
  exactly what the row shows.
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
- `newSessionHome` is the same `+` in the view title bar, for work that belongs
  to no project row yet. Taking no node, it asks the two questions the row `+`
  already knows: **what** and **where**.
  What is a three-way `showQuickPick` — Claude Session (`startSession`, exactly
  what the button always did), Scratchpad (`createScratchpad`), Terminal
  (`startTerminal`, a plain shell with nothing sent). Session stays first so the
  original behavior is still the default landing item. Worktrees are
  deliberately **not** an option here: a worktree is always *of* a repo, and the
  header `+` acts on the window's folder, which need not be one — it belongs on
  the project row, where the row **is** the repo. The item type is
  `QuickPickItem & { action }` — **never `kind`**, which is VS Code's own
  separator enum and intersects to `never`.
  Where is `resolveHeaderTarget`, shared by all three branches so a scratchpad
  and a session can never disagree about the folder: the window's own folder,
  because that is what the header `+` means in practice — no `workspaceFolders`
  → `os.homedir()`; one folder → its `uri.fsPath`, no prompt; two or more →
  `window.showWorkspaceFolderPick`, and Escape starts nothing. The one-folder
  case is branched explicitly so that an unambiguous window can never prompt,
  whatever the pick does internally. All three refuse a missing directory rather
  than falling back to the window default — the directory *is* the request, so a
  fallback starts a session, or writes a file, in the wrong repo.
  It takes no node, so unlike the other node-driven commands it stays visible in
  the command palette (the title is "New Session, Scratchpad, or Terminal"; the
  id keeps the `Home` spelling so existing keybindings survive).
- `newWorktreeSession` is the `$(git-branch)` inline icon at `inline@2` on
  every non-worktree project row, plus the same row's context menu at
  `navigation@2`. It is **not** in the header pick. It
  prompts for a branch name (`validateWorktreeName`, live "already exists"
  check against `join(parent, worktreeFolderName(name))` — the path that will
  actually be created, not the branch),
  runs `git worktree add <target> -b <name>` from the containing repo root —
  falling back to a plain checkout when the branch already exists — then
  `startSession` in the new directory. The row appears on a later poll like any
  new session; `ProjectNode.worktree` (set by the registry, the layer allowed
  to stat) marks it with a `worktree` description segment, the `$(git-branch)`
  icon, and the `project.worktree*` contextValues. git creates the leading
  directories, so the shared base and the `<repo>` level appear on first use
  with no mkdir of our own. `removeWorktree` is context-menu only, in
  `9_danger` on `/^project\.worktree/` rows.
- **Worktree rows nest under the project they were created from — but only in
  the view.** `ProjectNode.parentDir` is the main repo, parsed by the registry
  from the worktree's `.git` file (`scan/worktree.ts`, the read side; the
  git-running write side is `workspace/worktree.ts`, which re-exports it —
  split that way because `scan/` may not import from `workspace/`). The
  nesting itself is provider presentation state (`nestWorktrees` in
  `tree/provider.ts`), NOT a snapshot shape: `Snapshot.projects` stays flat, so
  the status bar and the header progress never walk a hierarchy. Rules the
  checks pin: a row renders exactly once (a pinned worktree stays in the
  accordion and is not repeated under its origin; a worktree whose origin row
  is absent stays at the root rather than vanishing); a pinned origin — even a
  placeholder with no sessions — carries its worktrees; and an active search
  renders flat, because the search is over sessions and a parent kept alive
  only to carry a matching child would itself read as a match. The origin row
  gets `N worktrees` in its description and counts nested live sessions toward
  its expansion (`nestedWorktrees`/`nestedLive` in `RenderOptions`) — its own
  spinner and `N working` stay own-sessions-only, the header bar covers the
  rest.
- **A worktree row outlives its sessions.** Sessions are the only thing that
  mints a `ProjectNode`, so the last session in a worktree exiting used to take
  the row — and with it the origin's whole worktree section — away, which reads
  as the worktree having been removed. `registry.addIdleWorktrees` therefore
  lists every worktree of each visible repo from git's own registry
  (`worktreesOf` in `scan/worktree.ts`: `<repo>/.git/worktrees/<name>/gitdir`,
  whose dirname is the worktree directory) and synthesizes an empty row —
  `sessions: []`, `liveCount: 0`, same `worktree`/`parentDir` marking — for any
  it has no project for. Three properties to keep: it is read **fresh every
  poll**, not memoized like `gitRoots`/`worktreeMeta`, because a removed
  worktree has to stop being offered; a worktree whose directory is gone but
  unpruned is skipped, so no row points at a path that cannot be opened; and
  worktree rows are only enumerated for non-worktree parents, so a worktree of
  a worktree cannot recurse. The description reads `no sessions · worktree` —
  the `no sessions` branch in `items.ts` is no longer pinned-only. Under a
  search these rows drop out like a pinned placeholder does: a row with no
  sessions cannot match. Only repos with a session of their own are scanned —
  the registry does not know about pins — so a pinned repo placeholder with an
  idle worktree still shows neither.
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
