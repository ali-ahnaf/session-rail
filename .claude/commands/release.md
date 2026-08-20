---
description: Bump the version, verify, and package a .vsix for the Marketplace
argument-hint: "[patch|minor|major|<x.y.z>] [--skip-verify]"
allowed-tools: Bash(npm run:*), Bash(npm version:*), Bash(npx --yes @vscode/vsce:*), Bash(git status:*), Bash(git log:*), Bash(git diff:*), Bash(ls:*), Bash(du:*), Bash(unzip -l:*), Bash(node:*), Read, Edit
---

Build a publishable `.vsix` for this extension. Arguments: `$ARGUMENTS`
(first word = bump level, default `patch`; `--skip-verify` skips the verify gate).

Do these steps in order and stop at the first hard failure.

## 1. Report the starting state

```bash
git status --short
node -p "require('./package.json').version"
```

Print the current version and the dirty files. Do **not** commit, tag, stash, or
push anything — packaging works from the working tree, and releasing is the
user's call.

## 2. Verify (unless `--skip-verify`)

```bash
npm run verify
```

This is `typecheck → lint → smoke → check:pins → check:registry → build`.

`smoke` and `check:registry` read the real `~/.claude` and are
**machine-dependent by design** (see CLAUDE.md → Verification approach). If one
of them reports a *coverage gap* — no live session on this machine happened to
exercise a path — that is a pass, not a failure: say so and continue. A real
assertion failure, a typecheck error, or a lint error stops the release; report
the output verbatim and do not bump or package.

## 3. Bump the version

```bash
npm version <level> --no-git-tag-version
```

`--no-git-tag-version` is required: no commit, no tag. `<level>` is the first
argument (`patch` | `minor` | `major`) or an explicit `x.y.z` if the user gave
one. Print old → new.

Marketplace rejects a re-upload of an existing version, so the bump is not
optional — never package without it.

## 4. Package

```bash
npm run package
```

That runs `npx --yes @vscode/vsce package`, which fires `vscode:prepublish`
(`npm run build`) itself, so the bundle in the `.vsix` always matches the source
just verified. Output lands at `./session-rail-<new-version>.vsix` (git-ignored).

If `vsce` complains about a missing `LICENSE`, `repository`, or the activation
bundle size, fix the cause — do not pass `--allow-*` flags to silence it.

## 5. Hand it over

```bash
ls -lh session-rail-*.vsix
unzip -l session-rail-<new-version>.vsix | tail -5
```

Then report, in a few lines:

- the **absolute path** to the `.vsix` and its size
- old → new version
- whether verify ran or was skipped
- upload target: <https://marketplace.visualstudio.com/manage/publishers/AliAhnaf>
- the reminder that `package.json` now has an uncommitted version bump

Also mention the CLI alternative for uploading, without running it (it needs a
PAT and is an outward-facing publish — the user's decision, not yours):

```
npx --yes @vscode/vsce publish --packagePath session-rail-<new-version>.vsix
```

Delete any older `session-rail-*.vsix` in the repo root only if the user asks.
