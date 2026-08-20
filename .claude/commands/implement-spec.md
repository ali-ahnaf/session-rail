---
description: Implement an approved SPEC.md test-first — reuses the spec's change plan instead of re-searching, then reviews and produces evidence. Leaves changes uncommitted.
argument-hint: "<path to SPEC.md>"
model: sonnet
effort: high
---

# Implement spec

Spec file: `$1`

The spec is the contract. It was interviewed out of the client and approved. You implement it — you do not redesign it, re-analyse it, or improve on it.

## 1. Read the spec before anything else

Read `$1` in full. Then check two gates before you touch a file:

- **Open questions for the client** — if that section is non-empty, stop. Report which questions are open and that implementation is blocked on them. An unanswered client question is not yours to answer.
- **Change plan** — if that section is empty or missing, stop and say the spec is not ready; it needs the `researcher` pass from `/spec` Step 3.

Section 1 (the end result) is what you are building. Re-read it before you declare done — it, not the tests, is what the client will check.

## 2. Do not re-do the research

The change plan already holds the `file:line` list, the callers checked, the repos verified clean, and the build order. It came from a read-only sweep across every affected repo. Work from it.

Grep only to confirm a specific line before you edit it, or when the plan turns out to be wrong. If the plan *is* wrong — a path moved, a caller was missed — say so explicitly in your final report. Do not silently substitute your own plan; a wrong spec is a finding the user needs.

## 3. Branch

Branch before the first edit. `feature/DEV-XXXX` if the spec names a ticket, otherwise a descriptive `feature/` name. Never implement on `develop`.

## 4. Implement test-first

**REQUIRED SKILL:** `tdd` for every code cycle. Do not restate or reinvent its rules — follow them.

Slice order comes from the change plan's order, which is already dependency-correct: schema before the code that reads it, a shared package before its consumers, backend before the front-end that renders it. One slice = one RED-GREEN cycle.

The spec's Contract section is the assertion target: the literal route path, request and response shape, column, and status codes written there are what the tests assert against. A test that passes while contradicting the Contract is a failing test.

Anything in **Out of scope** stays unbuilt, however tempting it looks once you are in the file.

## 5. Verify

Run the spec's Verification section exactly as written, in the change plan's build order. Cross-repo rebuilds are easy to skip and produce confusing failures — the TS workspace compiled before the root app runs or tests, the weblink `shared/` rebuilt before client or server see new types.

Verification must demonstrate section 1's end result — the observable thing an actor sees. A green test suite is necessary and not sufficient. Paste real output; never assert a pass you did not watch.

## 6. Adversarial review — mandatory, not optional

Spawn the `code-reviewer` agent. It is read-only, adversarial, and runs in fresh context — that is the point. You just spent the whole session convincing yourself the code is right; you are the worst available reviewer of it. Never self-review, never skip this because the tests are green, never skip it because the change is small.

Give it every input it asks for, or it reviews blind:

- **Base ref** — `develop` unless the spec says otherwise.
- **Branch name** — the branch you created in step 3.
- **Where the change lives** — state plainly that **nothing is committed**. Its usual `git diff <base>...HEAD` will come back empty. Tell it to use `git diff <base>` for modified tracked files, plus `git status --porcelain` to find new untracked files and read those in full. An untracked new file is invisible to every diff command — a reviewer that misses it reviews half the change.
- **Spec path** — `$1`.
- **Requirement source** — say explicitly that there is no requirement-matrix file in this flow: the spec's **Contract** section is the interface contract and its **Verification** section is the acceptance list. Point it at those so it does not report a missing matrix as a gap.
- **Ticket key** — if the spec names one.

Tell it what changed and where, but **do not tell it why you think each choice was correct.** Justifications in the brief are how you talk a reviewer out of a finding.

It does not run `npm test` — that is yours. Run the suite yourself and hand it the output.

### Handling findings

Every finding gets one of three outcomes, stated explicitly:

- **Fixed** — then re-run verification from step 5 in full. A fix invalidates the previous run.
- **Disagreed** — goes to the user with your reasoning. Never resolve a disagreement by yourself; "the reviewer misunderstood" is exactly what a wrong implementer also says.
- **Out of scope** — only if the spec's Out of scope section already covers it. Quote the line.

If findings required non-trivial fixes, re-spawn `code-reviewer` on the updated diff. Fixes introduce bugs at roughly the rate the original code did.

## 7. Evidence

Spawn `qa-evidence` with the spec's Verification section and the branch. Every PASS must carry real pasted output — HTTP response, DB row, test output, screenshot. A PASS with no output attached is not a PASS.

## 8. Stop

**Do not commit, do not stage, do not push, do not open a PR.** Leave the changes in the working tree for the user to inspect.

Final report: what was built, verification output, review findings and their resolution, and — separately — anywhere the spec was wrong, incomplete, or contradicted the code. That last part is what improves the next spec.

Never edit `$1`. If the spec needs to change, that is a `/spec` turn with the user.
