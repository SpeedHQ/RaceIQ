---
name: commit
description: Commit all current repository changes with the exact one-line message supplied by the user, resolving commit and pre-commit hook failures. Use only when explicitly invoked with /commit.
argument-hint: <commit message>
disable-model-invocation: true
---

# Commit changes

Commit message: `$ARGUMENTS`

1. Require a non-empty, single-line commit message. Use it exactly; do not rewrite it.
2. Run `git status --short` and inspect current staged and unstaged changes. If no changes exist, report that and stop; do not create an empty commit.
3. Stage all current changes with `git add -A`.
4. Run `git commit -m "$ARGUMENTS"`.
5. If commit fails, diagnose exact failure and resolve only commit blocker. For pre-commit hook failures, fix reported formatting, lint, type, build, or test errors at source. If hook reformats files, keep those changes. Restage with `git add -A` and retry same commit message. Repeat until commit succeeds or blocker requires unavailable credentials, user intent, or destructive action.
6. After success, run `git status --short` and report commit hash, exact subject, and any remaining changes.

## Boundaries

- Commit only. Do not push, pull, fetch, merge, rebase, amend, reset, revert, stash, or create/switch branches.
- Never bypass hooks with `--no-verify`, change Git or hook configuration, delete lock files blindly, or weaken checks.
- Never discard user changes. Preserve unrelated work and hook-generated fixes.
- Do not expand scope beyond errors that block this commit.
- Do not change commit message between retries.
