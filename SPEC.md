# Working indicator for active Claude sessions

## 1. Goal — the end result

A developer with the Session Rail sidebar open can tell at a glance which Claude
sessions are working right now, without expanding anything or reading text.

Concretely, once this is built:

- A session Claude is actively generating on shows a **spinning ring**
  (`$(loading~spin)`) in the `sessionRail.working` color where a static amber dot
  used to be. Row label, description (`main · opus`), and click behavior are
  unchanged. The moment the turn finishes, the ring becomes the static green
  `sessionRail.live` dot — and it does not flicker back and forth mid-turn while
  Claude sits in a long tool call.
- A **running subagent** row nested under that session spins the same ring.
  A finished subagent still shows the green `$(pass)` check.
- A **project row** whose sessions include at least one working session spins
  the ring in place of its `$(folder)`/`$(pinned)` glyph, and its description
  reads `2 sessions · 1 working`. So a collapsed project tells you both that
  work is in flight and how much.
- The **view header** shows VS Code's own indeterminate progress bar under
  `SESSION RAIL` while anything anywhere is working. It appears the instant the
  first session starts generating and disappears one second after the last one
  stops.
- Hovering a working session or subagent shows a `working` line in the tooltip,
  so the state is readable as text and not only as motion and color.
- A developer who set `workbench.reduceMotion` to `on` sees none of the
  animation: session, subagent, and project rows keep today's static colored
  dots and the view progress bar never appears. Everything else — the working
  count in the project description, the tooltip line — still works.
- Exited and history rows never spin, never show a progress bar, and are
  unchanged in every respect.

The status bar item (`$(loading~spin) 2 generating`) already exists and is
unchanged.

Why the client wants it: the sidebar currently distinguishes "working" from
"idle" only by the hue of a small dot, which is easy to miss and invisible to
anyone who cannot separate amber from green. Motion is the thing the eye
actually catches when you glance at a sidebar while doing something else.

## 2. Decisions

| Question | Settled answer |
| --- | --- |
| Which rows get the indicator | All four: session rows, running subagent rows, project rows with a working session, and the view header |
| Visual form on session rows | Spinner replaces the dot — `ThemeIcon('loading~spin', ThemeColor('sessionRail.working'))`. Idle/exited keep `circle-filled` |
| Visual form on subagent rows | Same spinner for `state === 'running'`; `done` keeps `$(pass)` in `sessionRail.live` |
| Visual form on project rows | Spinner replaces the `folder`/`pinned` glyph while any child session is generating. Pin state is no longer encoded in the project icon during that time |
| Project row text | Description gains a `N working` segment, e.g. `2 sessions · 1 working` |
| View header mechanism | `window.withProgress({ location: { viewId: 'sessionRail.tree' } })` — VS Code's native view progress bar. Not a badge, not title text, not a fake spinning command icon |
| View progress start/stop | Opens immediately on the first generating session; closes 1s after the last one clears (off-delay only, no on-delay) so a one-tick gap does not strobe the bar |
| What counts as "working" | Unchanged meaning of `SessionState.generating`, plus a sticky hold: `SESSION_ACTIVE_WINDOW_MS` stays `10_000`, and a session that derived `generating` stays `generating` for `SESSION_STICKY_MS = 20_000` after the last time the window fired |
| Where the sticky hold lives | `scan/registry.ts`, session state only — one source of truth shared by the tree, the status bar, and the change fingerprint |
| Subagents and the sticky hold | Not applied. Agent `running` keeps its existing `AGENT_ACTIVE_WINDOW_MS = 120_000` staleness rule; a `tool_result` remains a hard done-signal |
| Exited sessions and the hold | `alive === false` always wins — an exited session never spins, whatever the hold says |
| Elapsed timer on the row | No. Timestamps stay out of the snapshot fingerprint; no per-tick refresh, no restarted spin animation |
| Accessibility text | `working` line added to the session and agent tooltips only. Not added to the row description |
| Motion preference | Honor `workbench.reduceMotion`. `'on'` → static dots and no view progress. `'auto'` (the default) and `'off'` both animate |
| How `reduceMotion` is read | Inline `vscode.workspace.getConfiguration('workbench').get('reduceMotion')` at render time, the same read-on-demand pattern as `showExited()` in `src/tree/provider.ts:350` — no new config listener |
| Tuning values | Module constants in `scan/registry.ts` next to the existing windows. No new `sessionRail.*` setting |
| Progress driver placement | New `src/tree/progress.ts`, a disposable subscribing to `registry.onDidChange`. Not in the provider, not in `status/` |
| Type changes | None to `src/model/types.ts`. `SessionState` already has `generating`; `ProjectNode.sessions` already lets `items.ts` count working children inline |
| Verification | `scripts/registry-check.ts` extended to print each session's state and the icon id the tree would render, plus a new deterministic `scripts/sticky-check.ts` exercising the hold with an injected clock. Both wired into `npm run verify` |
| Documentation | `CLAUDE.md` updated in the same commit: the sticky-hold invariant, the `reduceMotion` dependency, and the fact that a project icon no longer always encodes pin state |
| Axes judged not to apply | No backend, no database, no migration, no API contract, no i18n (the extension ships no translation layer), no permissions or role scoping (single-user local extension), no GDPR or data-retention surface — this change writes nothing anywhere and reads no new files |

## 3. Open questions for the client

None. Every decision above was settled in the interview.

## 4. Contract

Nothing here is a network or storage contract; the observable surface is the
rendered tree, one new module, one new constant, and one new script.

**New constant** — `src/scan/registry.ts`, beside `SESSION_ACTIVE_WINDOW_MS`:

```ts
/**
 * How long a session keeps reporting `generating` after the activity window
 * last fired. Absorbs the quiet gaps inside a single turn — a long tool call
 * writes nothing to the transcript, and a spinner that blinks off mid-turn
 * reads as a bug. `alive === false` still wins immediately.
 */
const SESSION_STICKY_MS = 20_000;
```

**Changed internal signature** — `deriveSessionState` needs the per-session scan
state so it can read and write the hold:

```ts
function deriveSessionState(
  alive: boolean,
  agents: readonly AgentNode[],
  lastActivityAt: number | undefined,
  now: number,
  scan: SessionScan,   // new: carries lastGeneratingTick
): SessionState
```

**New field** on the existing `SessionScan` interface (private to
`src/scan/registry.ts`; not part of `src/model/types.ts`):

```ts
/** Last tick at which this session derived `generating`, for SESSION_STICKY_MS. */
lastGeneratingTick?: number;
```

**New module** — `src/tree/progress.ts`:

```ts
export class RailProgress implements vscode.Disposable {
  constructor(registry: RailRegistry);
  dispose(): void;
}
```

Holds the view progress token while `snapshot.projects` contains any session
with `state === 'generating'`; releases it 1s after the count reaches zero;
never opens it when `workbench.reduceMotion === 'on'`. Uses viewId
`'sessionRail.tree'` (`package.json:64`).

**Icon contract per row state** (the visible result):

| Row | State | Icon | Color |
| --- | --- | --- | --- |
| Session | `generating`, motion allowed | `loading~spin` | `sessionRail.working` |
| Session | `generating`, `reduceMotion: on` | `circle-filled` | `sessionRail.working` |
| Session | `idle` | `circle-filled` | `sessionRail.live` |
| Session | `exited` | `circle-filled` | `sessionRail.exited` |
| Subagent | `running`, motion allowed | `loading~spin` | `sessionRail.working` |
| Subagent | `running`, `reduceMotion: on` | `circle-filled` | `sessionRail.working` |
| Subagent | `done` | `pass` | `sessionRail.live` |
| Project | any child `generating`, motion allowed | `loading~spin` | `sessionRail.working` |
| Project | any child `generating`, `reduceMotion: on` | `folder` / `pinned` | default |
| Project | otherwise | `folder` / `pinned` | default |

**Project description format**: existing segments, plus ` · N working` when
`N > 0`, e.g. `2 sessions · 1 working`.

**Tooltip addition**: session and agent tooltips gain a `working` line while
`generating` / `running`. Existing lines unchanged.

**New npm script**: `check:sticky`, built and run the way `check:pins` is
(`esbuild … --alias:vscode=./scripts/vscode-stub.js`), and appended to `verify`.

No `contributes` additions: the four colors (`sessionRail.live`, `working`,
`exited`, `waiting`) already exist, no new command, no new setting, no new
context key.

## 5. Change plan

Pasted from the read-only mapping pass.

### src/tree/items.ts

Refs:
- items.ts:208–211 — `buildSessionItem` sets `item.iconPath` to `'circle-filled'` + `sessionStateColor()`. Needs conditional: `'generating'` state → `'loading~spin'`, else use the current icon logic.
- items.ts:223–236 — `sessionStateColor()` returns color for state; `'generating'` → `'sessionRail.working'`. Already correct.
- items.ts:238–275 — `sessionDescription()` adds elapsed time for `'generating'` state. Must add "working" tooltip line (design item 7).
- items.ts:277–302 — `sessionTooltip()` at line 296 shows `- **State**: ${node.state}`. Add "working" line when `generating`.
- items.ts:182 — `buildProjectItem` sets icon to `'pinned'` or `'folder'`. Needs conditional: if project has generating child sessions → `'loading~spin'` + `sessionRail.working`.
- items.ts:171–181 — `buildProjectItem` description builder. Must add `"N working"` segment when `node.sessions.some(s => s.state === 'generating')`.
- items.ts:313–316 — `buildAgentItem` sets icon: `'circle-filled'` + `sessionRail.working` if `node.state === 'running'`, else `'pass'`. Needs: `'running'` → `'loading~spin'` + `sessionRail.working`; keep `'done'` as `'pass'`. Add tooltip "working" line (design item 7).
- items.ts:331–341 — `agentTooltip()` shows agent state. Add "working" line when `'running'`.

Defs:
- items.ts:30–49 — `RenderOptions` interface. May need a `generateCount?: number` field if provider can't compute it inline, but design says items.ts can compute from node.sessions.

### src/scan/registry.ts

Defs:
- registry.ts:68 — `SESSION_ACTIVE_WINDOW_MS = 10_000`. Keep unchanged.
- registry.ts:90–103 — `SessionScan` interface. Add field: `lastGeneratingTick?: number` (tracks the last tick when 'generating' was derived, for sticky 20s hold).
- registry.ts:692–717 — `deriveSessionState()` function. Must:
  - Record `now` into `scan.lastGeneratingTick` whenever it returns `'generating'`.
  - Add sticky logic: if `now - (scan.lastGeneratingTick ?? 0) <= SESSION_STICKY_MS` AND alive, return `'generating'` even if no recent activity.
  - Always respect: 'exited' (not alive) wins over the hold.

Call sites:
- registry.ts:301 — `deriveSessionState(alive, agents, lastActivityAt, now)` called in `buildSession()`. Pass `scan` as fourth arg OR capture result and apply sticky hold after.
- registry.ts:740–765 — `signatureOf(snapshot)` builds fingerprint. Must include sticky-held state in signature, or sticky sessions won't fire change events on timeout. Check: does `session.state` appear on line 749? Yes. Signature already includes it; no change needed.

Per-session state pruning:
- registry.ts:608–629 — `pruneState()` removes session state when sessionId leaves registry. Add: also clear `lastGeneratingTick` from the removed session's scan.

Constants to add:
- After line 68: `const SESSION_STICKY_MS = 20_000;`

### src/tree/provider.ts

- provider.ts:256–276 — `visibleProjects()` shallow-copies projects when filtering. Recomputed `liveCount` on line 271 counts non-'exited'. No change needed for count itself, but items.ts needs to check generating children, which it can do inline via `node.sessions.some(s => s.state === 'generating')` — no new field required.
- provider.ts:517–544 — `groupProjects()` sets `project.liveCount` on line 540. No change needed; this counts non-exited, not generating.

ProjectNode already has `sessions: SessionNode[]`, so `items.ts` can walk it to find generating sessions inline. No type change needed.

### src/model/types.ts

- types.ts:105–115 — `ProjectNode` interface. No new field required (items.ts computes generating count inline).
- types.ts:117–156 — `SessionNode` interface. No new field required.
- types.ts:158–173 — `AgentNode` interface. No new field required.

All state derivation happens in registry.ts; no schema changes needed.

### src/extension.ts

Activation wiring (new progress.ts module):
- extension.ts:46–51 — Registry, pins, provider, statusBar are created/wired.
- extension.ts:58–85 — `context.subscriptions.push(...)` block. Must insert new progress module here.

Pattern to follow:
- Line 51: `const statusBar = new RailStatusBar(registry);`
- New line 52: `const progress = new RailProgress(registry);` (once src/tree/progress.ts exists)
- Add to subscriptions after statusBar (line 65): `progress,`

Config listener (`workbench.reduceMotion`):
- extension.ts:68–76 — `onDidChangeConfiguration` listener. No new event needed; reduceMotion is a VS Code built-in setting (not sessionRail.*), and items.ts can read it on every `toTreeItem()` call inline via `vscode.workspace.getConfiguration('workbench').get('reduceMotion')`.

### src/status/statusBar.ts

Existing generating-count loop (can be reused/exported):
- statusBar.ts:42–79 — `render()` method. Lines 47–65 build per-project counts including `generatingSessions`. Already computed here.
- statusBar.ts:87–89 — Status bar text shows `$(loading~spin)` when `generatingSessions > 0`. Pattern already established.

This loop can be reused: no export needed if progress.ts scans snapshot independently.

### package.json

View id registration (withProgress location):
- package.json:64 — `"id": "sessionRail.tree"` in contributes.views.sessionRail.

The viewId string for `vscode.window.withProgress({ location: { viewId: 'sessionRail.tree' } })`.

### scripts/registry-check.ts

Where session rows are printed:
- registry-check.ts:49–79 — `render()` function prints snapshots. Line 52 iterates projects, line 52 shows project name + liveCount, lines 61–72 iterate and print session rows.

  Change required: After line 60 (where session label is set), must also render the icon/state. Add session state and icon id to output.

Wiring verification scripts:
- package.json:40 — `"verify"` script: `npm run typecheck && npm run lint && npm run smoke && npm run check:pins && npm run check:registry && npm run build`

New sticky-check.ts script:
- Location: `scripts/sticky-check.ts` (new file).
- Pattern: like `pins-check.ts` — deterministic check with injected clock (not machine-dependent).
- Structure: exercise `deriveSessionState()` with mock `SessionScan` states, verify 20s hold, verify 'exited' always wins.
- Wire into package.json verify: add `&& npm run check:sticky` after `check:registry`.

### All consumers of session.state / agent.state / iconPath

- src/tree/items.ts:239, 262, 265, 271, 314, 325 — session/agent icon and tooltip builders. Listed above.
- src/tree/provider.ts:271 — liveCount filter (session.state !== 'exited'). Already correct.
- src/status/statusBar.ts:53, 57, 61 — generating-count loop. Confirmed.
- src/scan/registry.ts:540, 704, 720 — state checks in grouping and sorting. Already correct.
- scripts/registry-check.ts:39, 69, 125, 157, 163, 193 — test assertions on state. Update to include new sticky logic.

No consumers in: src/transcript/panel.ts, src/workspace/*.ts, src/terminal/link.ts.

### workbench.reduceMotion

Not currently read anywhere. Read it inline in items.ts on every icon render, choose `'loading~spin'` (animation) vs. static colored dot based on `vscode.workspace.getConfiguration('workbench').get('reduceMotion') !== 'on'`.

Pattern: same as the `showExited` read in provider.ts:350 — inline `getConfiguration()` call, no config listener needed (read-on-demand is acceptable here since it's not hot-path).

### Build order (keeps intermediate states typechecking)

1. `src/scan/registry.ts` — add `SESSION_STICKY_MS`, add `lastGeneratingTick` to `SessionScan`, modify `deriveSessionState` and its call site, extend `pruneState`.
2. `src/tree/items.ts` — session/agent/project icon logic, project description count, tooltip lines, `reduceMotion` read.
3. `src/tree/progress.ts` — new file (withProgress hold + 1s off-delay).
4. `src/extension.ts` — construct and push `RailProgress`.
5. `scripts/sticky-check.ts` — new deterministic script.
6. `package.json` — add `check:sticky` script, append to `verify`.
7. `scripts/registry-check.ts` — print state + icon id per session row.
8. `CLAUDE.md` — invariants and contribution-surface updates.

No changes needed in `src/model/types.ts`, `src/tree/provider.ts`, or
`src/status/statusBar.ts`.

## 6. Out of scope

Named explicitly so nobody quietly builds them:

- **A real `waiting` signal.** `SessionState.waiting` stays never-emitted. A
  session blocked on a permission prompt still looks `idle` (or spins out its
  20s hold and then looks idle). Hook-driven state is a separate piece of work.
- **Hooks.** No `SessionStart`/`Stop`/`SubagentStop` listener, no localhost
  server. Liveness inference stays filesystem polling.
- **Elapsed / duration timers** on any row, in any slot. Explicitly rejected in
  the interview because it forces timestamps into the fingerprint.
- **Progress percentage or step counts.** The view progress is indeterminate;
  nothing derives "how far along" a turn is.
- **Sticky hold for subagents.** Agent `running` keeps `AGENT_ACTIVE_WINDOW_MS`.
- **Widening the activity window** from 10s. The hold does that job; the window
  itself is untouched.
- **A `sessionRail.showSpinner` setting** or any other new config key,
  command, color, or context key.
- **Status bar changes.** It already spins; it is not touched.
- **Task rows.** Task icons (`circle-outline` / `clock` / `check`,
  items.ts:355–361) are unchanged — an in-progress task is not "Claude working".
- **`docs/design.html`.** The visual-grammar page is not updated in this change.
- **Windows behavior differences.** Nothing here touches the `ps` ancestry walk.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| A session sits `generating` for up to 20s after it truly went idle, so the spinner and the view progress overstay by that much | Accepted deliberately in the interview: overstaying reads as "still thinking", while blinking off mid-turn reads as a bug. 20s is a module constant, trivially retuned |
| Project icon no longer encodes pin state while a child is working, so a pinned project temporarily loses its `$(pinned)` glyph | Pin state stays readable from the `Pinned` section the row sits under, from the context menu (Pin/Unpin, gated on `viewItem =~ /^project/`), and `contextValue` is untouched. Documented in `CLAUDE.md` |
| `withProgress` on a viewId leaks a never-resolving token if the promise is not always settled | `RailProgress.dispose()` must resolve any in-flight token, and the off-delay timer must be cleared on dispose. `progress.ts` is the only place holding it — one file to audit |
| Sticky state means `SessionState` is no longer a pure function of the current tick, which contradicts the current mental model in `CLAUDE.md` | `CLAUDE.md` invariant added in the same commit; `scripts/sticky-check.ts` pins the behavior with an injected clock |
| The change event may not fire at the moment the hold expires, leaving a stale spinner | `signatureOf` already includes `session.state` (registry.ts:749) and the poll runs every `refreshInterval` (default 2s), so the tick after expiry changes the fingerprint and fires. No fingerprint change needed — but this is the one assertion `check:registry` output should be eyeballed for |
| `loading~spin` renders as a static glyph if VS Code ever drops the spin modifier in tree items | Degrades to a static ring in the working color — same information as today's dot, no crash |
| Reading `workbench.reduceMotion` on every `getTreeItem` adds a config lookup per row | `getConfiguration` is cached in-process by VS Code and the tree is tens of rows; identical pattern to `showExited()` at provider.ts:350 |
| `pruneState` misses `lastGeneratingTick` and holds memory for dead sessions | The field lives on the pruned `SessionScan` object itself, so existing pruning drops it with the record; the change plan calls out the site to confirm |

## 8. Verification

Runnable by someone who was not in this conversation.

**1. Full gate (must pass):**

```bash
cd /Users/aliahnaf/Projects/claude-hybrid
npm install
npm run verify
```

`verify` is `typecheck && lint && smoke && check:pins && check:registry &&
check:sticky && build` after this change. All must exit 0.

**2. Sticky hold, deterministic (proves the no-flicker rule):**

```bash
npm run check:sticky
```

Must assert, with an injected clock and no filesystem access:
- activity at `t`, evaluated at `t + 5_000` → `generating` (activity window)
- activity at `t`, evaluated at `t + 15_000` → `generating` (hold, window lapsed)
- activity at `t`, evaluated at `t + 31_000` → `idle` (hold expired)
- `alive === false` at `t + 5_000` → `exited` (exit beats the hold)
- a running subagent with no recent activity → `generating` regardless of hold

Exit code 0 and a printed line per case.

**3. Rendered tree vs. reality (proves the icon mapping):**

```bash
npm run check:registry
```

Output now includes each session's state and the icon id the tree would render,
e.g.:

```
claude-hybrid  2 sessions · 1 working   [loading~spin]
  ◌ Deploy API to VPS      generating  [loading~spin sessionRail.working]
  ● Fix auth middleware    idle        [circle-filled sessionRail.live]
```

Proves the mapping in section 4 for whatever is live on the machine. If nothing
is generating right now, the script must say so as a **coverage gap**, not pass
silently — matching the existing machine-dependent-check convention.

**4. End to end in the Extension Host (proves section 1):**

```bash
npm run watch    # then F5 in VS Code
```

In the Extension Host window, with the Session Rail view open:

- Start a Claude session in a project (the `+` on a project row) and send it a
  prompt that takes >30s and spawns a subagent. Observe, while it runs: the
  session row ring spinning, the subagent row ring spinning, the project row
  ring spinning with `· 1 working` in its description, and the indeterminate
  progress bar under the `SESSION RAIL` header. The session ring must not blink
  off during the turn.
- When the turn ends: within ~20–22s the session row shows the static green dot,
  the subagent row shows `$(pass)`, the project row shows `$(folder)`/`$(pinned)`
  again with no `working` segment, and the header progress bar is gone within
  ~1s of the last session clearing.
- Hover the working session and the running subagent mid-turn: each tooltip
  contains a `working` line.
- Set `"workbench.reduceMotion": "on"` in Settings, repeat with a working
  session: every row shows a static colored dot, the header progress bar never
  appears, and the project description still reads `· 1 working`. Set it back to
  `"auto"` and the spinners return.
- Toggle `sessionRail.showExited` on: exited/history rows show the grey static
  dot and never spin.
