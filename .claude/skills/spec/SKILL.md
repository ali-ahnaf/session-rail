---
name: spec
description: Interview the user into a self-contained SPEC.md before any code is written.
argument-hint: "One line: the feature or change the client asked for"
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, AskUserQuestion, Skill, Agent, Write(SPEC.md), Bash(git log:*), Bash(git diff:*), Bash(git status:*), Bash(rg:*), Bash(ls:*), Bash(cat:*), Bash(sed -n:*)
---

Turn a vague client request into a spec that a fresh agent could implement without asking a single question.

Run this in the main thread. A subagent cannot interview the user — do not delegate the interview.

## The Iron Law

**No code, no file edits, no branch until SPEC.md exists and the user has approved it.**

`allowed-tools` enforces this: read, search, ask. The only writable path is `SPEC.md`. Nothing here can edit source, so a rationalization that gets past you still can't touch the repo.

The whole point is that ambiguity surfaces now, while going back to the client is cheap. Once 400 lines exist it is not cheap.

| Excuse | Reality |
|---|---|
| "Requirement is clear enough" | Then the interview takes two rounds. Run it. |
| "I'll spec it as I build" | Spec-as-you-build means the client's ambiguity is now in the code. |
| "Small change, skip the spec" | Small changes don't get `/spec` typed at them. The user already judged the size. |
| "I'll write the spec after, from the diff" | That's a changelog, not a spec. It can't be sent to the client. |
| "I'll ask the questions while editing files" | Interview first, edits after. No overlap. |

## Step 1 — Orient (shallow, on purpose)

Read only far enough to ask good questions. Three things:

- Does this already exist, in whole or in part?
- Which repos are in play?
- Which documented flow does it touch — invoke `tome-of-knowledge` if any.

**Stop there.** No line numbers, no caller graphs, no exhaustive file list. That mapping is the `researcher` agent's job in Step 3, and doing it now costs you twice: the context fills with file dumps before the interview starts, and you map a design the user has not agreed to yet.

Facts are still your job, never the user's — never ask the user something the filesystem can answer. Delegate any wide read to a read-only agent (`Explore`, `cavecrew-investigator`) so the dumps stay out of the interview.

If you catch yourself reading a fourth file to answer a question the user has not been asked yet, you are in Step 3 early. Go interview.

## Step 2 — Interview

**REQUIRED SUB-SKILL:** take the interview structure from `grilling` — the design tree, rounds, and frontier. Ignore its `❓ Q<n>` text format; the questions go through the tool below instead.

**Every question goes through the `AskUserQuestion` tool.** Never ask in prose — the user answers by selecting.

- Your recommended answer is the **first option**, labelled `(Recommended)`. The `description` on each option carries the tradeoff — what it costs, what it forfeits.
- Options must be real, mutually exclusive answers to a decision the user actually owns. Never `Yes` / `No` / `Not sure`. Never an option you would refuse to build.
- Four questions per call, max. A frontier wider than four means back-to-back calls in the same round — not a narrowed frontier.
- `multiSelect: true` when the answers stack (which states to handle, which roles get access).
- Use `preview` when the decision is a shape the user should see: a request/response body, a table DDL, a screen layout, two competing signatures.
- The tool always offers "Other". A free-text answer is a new fact — recompute the tree before the next round.

Cover every axis that applies, and say explicitly which axes you judged not to apply:

- **Technical implementation** — layer by layer. Which table, which repository method, which route, which contract with the caller. Migration and backfill. Config and secrets.
- **UI/UX** — the actual screens and states: empty, loading, partial, error, permission-denied. Copy and translation keys. Who can see it (role, `customer_id` scope, api-key scope).
- **Edge cases** — concurrency, retries, duplicates, partial failure mid-flow, offline, timeout, deleted or renamed parent rows, existing rows that predate the change.
- **Concerns** — what breaks in production, blast radius on existing callers, data you cannot un-write, GDPR, rate limits, cost.
- **Tradeoffs** — put the two or three real options side by side with what each costs, and recommend one.

Dig into the parts the user has *not* thought about. A round that only confirms what they already told you was a wasted round. When an answer implies a decision they did not make, surface it as a question, not an assumption.

Keep going until a round produces no new decisions. Then say so and move on.

## Step 3 — Map the change

Decisions are settled; now find out where the code changes. Spawn the `researcher` agent once, with the settled decisions and contract as its brief — not the client's original request.

You do not do this mapping yourself. `researcher` runs read-only across every affected repo and returns an ordered `file:line` change plan, the callers it checked, the repos it verified clean, and the build order. Its report becomes section 5 of the spec verbatim, and its build order feeds section 8.

If it comes back naming an unsettled decision, that is a question you missed. Ask it with `AskUserQuestion`, then re-spawn with the answer. Do not paper over it.

## Step 4 — Write SPEC.md

Write `SPEC.md` at repo root. It must be readable standalone — assume the implementer has this conversation nowhere in context. Sections, in this order:

1. **Goal — the end result** — what the user sees once this is built, written as if it already works. Concrete and observable, not intent: the screen they land on and what's on it, the request they send and the response they get back, the report row that now appears, the SMS whose wording changed. Name the actor (support admin, company user, api-key integration, customer on a weblink) and walk their path start to finish. Include what they see when it goes wrong, if the interview settled that.

   Write it so the user can read this one section and say "no, that's not what I asked for" — that check is the point. No implementation nouns here: no table names, no route paths, no repository methods. Those belong in sections 4 and 5.

   Then one line: why the client wants it.
2. **Decisions** — every question from the interview with its settled answer, one line each. This is the record you send back to the client.
3. **Open questions for the client** — anything the user could not settle. Empty is fine; a fake answer is not.
4. **Contract** — the interfaces a caller or the client can react to, written out literally: route path and method, request and response shape, table column and type, env key, translation key, changed function signature. These are decisions, not search results — each one traces to an answer in section 2. Not the file list.
5. **Change plan** — `researcher`'s report from Step 3, pasted: the ordered `file:line` plan, callers and blast radius, repos checked and clean, and what it rejected as too much. Do not summarise it; the implementer needs the paths. If Step 3 has not run, this section is not writable yet.
6. **Out of scope** — what this explicitly does *not* do. Name the tempting adjacent things by name so nobody quietly builds them.
7. **Risks** — what can break, and the mitigation for each.
8. **Verification** — end to end, runnable. The exact commands in `researcher`'s build order, the request that exercises the flow, and the observable result that proves it works: a status code, a row, a rendered state. It must prove section 1's end result, not merely that the code compiles. A test file name alone is not verification.

## Step 5 — Hand back

Show the user the Goal — the end result — first, then Decisions and Open questions, and stop. Goal leads: if the end result is wrong, nothing below it matters. They approve, amend, or take the open questions to the client. Implementation is a separate turn.

## Red flags — stop and restart the interview

- You are about to open an editor and SPEC.md does not exist.
- You typed a question in prose instead of calling `AskUserQuestion`.
- A spec section says "TBD", "as appropriate", "handle errors gracefully", or "existing pattern".
- Out of scope is empty.
- Verification cannot be run by someone who was not in this conversation.
- You answered a question yourself that only the client can answer.
- The Goal describes work to be done ("add an endpoint that…") instead of the end result an actor sees.
- You are grepping for callers or line numbers before the interview is done — that is Step 3 work leaking into Step 1.
- You wrote the change plan yourself instead of spawning `researcher`, or summarised its report instead of pasting it.
