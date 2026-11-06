---
name: raceiq-explicit-lefthook-skip
description: Commit RaceIQ changes with Lefthook disabled only when user explicitly requests hook bypass.
---

# RaceIQ commit with Lefthook skipped

Use only when user explicitly authorizes both committing and skipping Lefthook.

1. Inspect worktree status, diffs, branch, and upstream. Stage only intended files.
2. Commit with `LEFTHOOK=0 git commit -m "<focused message>"`.
3. Push to the verified upstream.
4. Report commit hash, destination, and checks run or skipped.

Never bypass hooks without explicit user authorization.
