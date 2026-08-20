---
name: tdd
description: Drives test-first development — plan, write ONE failing test, implement until it passes, repeat, then verify. Enforces that tests are never edited to make them pass and that no test is vacuously green. Use ONLY when the user explicitly asks for TDD, test-first, red/green, or "write failing tests first" (or invokes /tdd). Do NOT use for a plain spec/ticket/feature/bug request that does not name a test-first approach — implement those normally. Delegates test writing to write-test and implementation to backend-engineer.
disable-model-invocation: true
---

# TDD

One rule above all others: **the test is the specification. Implementation changes to satisfy
the test — never the reverse.** If a test looks wrong, stop and raise it with the user as a
spec question. Editing a test to make it pass destroys the only evidence the code works.

This skill orchestrates two existing skills — do not re-derive what they cover:

- **`write-test`** — how to write tests here: `require('../hooks')`, supertest, fixture ids,
  emulator/webhook patterns, mocks, prerequisites. Load it before writing any test.
- **`backend-engineer`** — how to implement here: layering, repository pattern, conventions.
  Load it before writing implementation. Its "do NOT run tests" rule does **not** apply
  inside this skill; running tests is the whole point.

## Vertical slicing — the loop

Do **not** write all the tests, then all the code. Bulk-written tests describe *imagined*
behaviour and, when context gets tight, invite rewriting tests instead of code.

One `it` per cycle, each cycle closed before the next opens:

```
cycle 1:  write test 1  →  run (RED)  →  implement  →  run (GREEN)  →  refactor
cycle 2:  write test 2  →  run (RED)  →  implement  →  run (GREEN)  →  refactor
cycle 3:  write test 3  →  run (RED)  →  implement  →  run (GREEN)  →  refactor
...
```

Rules of the loop:

- **One `it` at a time.** Never add the next test while the current one is red.
- **Run just that test** with mocha's `-g`, so the red/green signal is unambiguous:
  ```bash
  npm run test:one -- test/v2/v2_test_<endpoint>.js -g "<exact it title>"
  ```
- **Run the whole file at the end of each cycle** once more than one test exists — a new
  implementation must not break an earlier green.
- **Implement only what the current test demands.** Not the next test's rule, not a field
  the spec mentions but nothing asserts yet. Anticipated code is untested code.
- **Commit-sized slices.** Each cycle leaves the file green; that is a safe stopping point.

### Slice order

Order the cycles so each one adds a thin layer of behaviour on the last:

1. **Happy path** — the endpoint exists, accepts a valid body, returns the success shape.
   Forces the route, repository method, wiring and response handler into existence.
2. **Persistence** — the row is really written / re-read from the DB, not echoed.
3. **Authorization** — who may call it, then who may not.
4. **Domain errors** — each `result_code` in turn, one cycle each.
5. **Check order** — where the order of the gates is observable.
6. **Validation and boundaries** — missing, empty, wrong type, min, max, max+1. These are
   usually one cycle for the whole Joi schema, since one schema change turns them all green;
   write them as separate `it`s regardless.

### If the user hands over a whole test file

Sometimes the user supplies (or explicitly asks for) the complete test file up front. That is
a specification, not a licence to implement horizontally: get the file fully red, then work
it **one `it` at a time with `-g`**, leaving the remaining tests red until their cycle comes.
Run the whole file only to confirm the count going down and, at the end, all green.

## 1. Plan before any code

Answer these in a short message to the user (or in a scratch `.md` for anything spanning 3+ files):

1. **What interface changes are needed?** Which route/service/repository methods appear or change.
2. **Which behaviours matter most?** You cannot test everything. Rank: contract of the
   public interface, authorization, ordering of checks, boundaries. Skip trivia.
3. **What is observable?** A test may only assert what a caller can see — HTTP status,
   `result_code`, `error_message`, response body, and durable state (a row that exists).
   Not: which helper ran, how many queries, internal call order.
4. **What is the termination condition?** "Done" is a named set of tests passing, nothing more.

If the source is a Jira ticket or a spec file, restate it as numbered, verifiable rules
first: field rules with exact limits, every `result_code` with its exact `error_message`,
and the *order* checks run in when that order is observable.

## 2. RED — write ONE test, watch it fail for the right reason

Follow `write-test` for form. Write a single `it`, then:

- **Run it.** A test you have not seen fail is not a test.
- **Read the failure.** It must fail because the behaviour is missing — not on a typo, a bad
  fixture id, or a missing build. `404 cannot POST /v2/...` is a good red. A `TypeError` in
  the test body is not.
- **Refuse vacuous greens.** Any test that passes before the feature exists proves nothing.
  Known traps in this repo:
  - `it('file start', done => done())` marker blocks — omit them from TDD files.
  - **Bare HTTP 401 assertions.** Authenticated routes mount after `passport.initialize()`,
    so an anonymous request is rejected before routing — an unmounted route 401s identically.
    Assert the route exists in the same test (a superadmin call that must return a validation
    `result_code`) before asserting the 401.
  - **Bare "nothing was written" assertions.** Zero rows is also true when the endpoint does
    not exist. Assert the response's `result_code` in the same test.
  - Anything asserting only `status, 200` on a route that returns 200 for every outcome.

The gate: `-g` on the new test reports `0 passing, 1 failing`. For a whole handed-over file,
`0 passing`. Anything green before the code exists is vacuous — tighten it.

## 3. GREEN — implement the current test only, never touch the test

Follow `backend-engineer` for layering and conventions. Build bottom-up and rebuild before
running: mocks and consumers resolve the compiled `dist/` output, so a stale build produces
failures that have nothing to do with your code.

```bash
npm run build
npm run test:one -- test/<path>/<file>.js -g "<exact it title>"   # this cycle's test
npm run test:one -- test/<path>/<file>.js                         # then: earlier tests still green?
```

Stop as soon as this test passes. Do not implement the next test's rule, and do not add
handling for cases nothing asserts yet — write the test for them in their own cycle instead.

If a test cannot pass without changing it, that is a signal, not a chore:

- the spec is ambiguous or wrong → ask the user, quote the failing assertion;
- the test asserts an implementation detail → propose the behavioural assertion instead;
- the assertion depends on the environment (see step 5) → say so, propose the input change,
  and let the user decide.

Never silently relax an assertion.

## 4. REFACTOR — then start the next cycle

Only with the test green. Improve names, extract helpers, remove duplication — then re-run
the whole file. No behaviour change, so every test must stay green without edits.

Then go back to step 2 with the next `it`. Repeat until the plan's rules are all covered;
only then move to step 5.

## 5. VERIFY before declaring done

```bash
npm run build
npm run test:one -- test/<path>/<file>.js         # the target file
npm run test:one -- test/<path>/<neighbour>.js    # nearest existing suite, for regressions
npx eslint <new files only>                       # never --fix an existing modified file
```

Then check for residue: anything the tests inserted must be gone (`after` hooks), and the
run must have actually executed — see below.

Report faithfully: what passed, with which command, what you skipped, what you could not run.

### The environment lies in two specific ways

- **`hooks.js` before-all times out.** It registers an emulated cabinet per cabinet over TLS;
  with no cabinet-server running the whole run dies as `0 passing, 1 failing` with
  `Error: Timeout of 10000ms exceeded`. This is not your change — it happens at red too.
  Re-run until the hook succeeds, and say which runs actually executed.
- **Local DB config differs from CI.** The Docker DB image forces `character-set-client-handshake = FALSE`
  (utf8mb4), so 4-byte characters round-trip locally and fail in the pipeline with
  `ER_TRUNCATED_WRONG_VALUE_FOR_FIELD`. Any test input whose behaviour depends on server
  configuration — charset, timezone, `sql_mode`, collation — is a portability risk. Prefer
  inputs that hold everywhere, and when you deliberately pick an environment-dependent one,
  name the assumption in the test title.

## Behaviour, not implementation

A test that breaks during a refactor when behaviour did not change is a liability.

- Assert through the public interface — an HTTP call — not by reaching into internals.
- Reading the DB to confirm a durable side effect is fine (that *is* the behaviour). Reading
  it to infer *how* the code got there is not.
- Name tests as specifications: `Should return 100, not 101, when a non-superadmin sends a
  missing cabinet_id` — not `Should call authorize before lookup`.
- Cover both sides of every boundary. `max(64)` means empty, 1, 64, 65.

## Test data hygiene

Track every id the file creates and delete it in `after`. Shared seeded rows are never
deleted. Without this, a second run sees the first run's rows and count assertions
("exactly 2 duplicates") start failing for reasons unrelated to the code.

## Guardrails

- Never edit a test to make it pass. Raise it instead.
- Never write test N+1 while test N is red, and never write several `it`s "to save a round trip".
- Never mark a step done on "it should work now" — quote the actual run output.
- Never retry an identical failed action; state the suspected cause first.
- After 2–3 failed attempts at the same step, stop and ask the user.
- Do not implement beyond the current failing test.

A worked example — spec → 40 red → green, including every trap above — is
`test/README.md` with `test/v2/v2_test_add_cabinet_peripheral.js`.
