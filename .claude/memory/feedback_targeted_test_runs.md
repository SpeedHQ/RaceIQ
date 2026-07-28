---
name: Run targeted tests, not the whole suite
description: When iterating on a specific test file, run just that file rather than the full suite
type: feedback
---
When validating a test you're actively writing or changing, run only that file:
`bun test test/foo.test.ts` (or several paths), not `bun run test`.

**Why:** The full suite is ~2200 tests across 110+ files. Running it to check
one file you just edited is slow and buries the signal you're looking for.

**How to apply:** Run `bun test <path>` for the files you touched. Do NOT run the
full `bun run test` — not while iterating, and not as a pre-commit gate either.
The user has stopped it being run twice. CI runs the full suite; that is where
cross-file regressions get caught.

Related: [[feedback_bunx_over_npx]]
