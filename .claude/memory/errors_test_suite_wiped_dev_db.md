---
name: errors-test-suite-wiped-dev-db
description: bun run test had no DATA_DIR isolation and wiped real community_tunes/settings.json — fixed 2026-07-12
metadata:
  type: project
---

`bun run test` used to run against the real dev `data/` directory (no
`DATA_DIR` override in the `test` script), and `test/community-tunes-sync.test.ts`
unconditionally ran `db.delete(communityTunes)` in `beforeEach` against
whatever DB that resolved to. Running the suite locally silently wiped the
real synced community tunes down to a single test fixture row
(`community-existing`). `test/settings.test.ts` had the same class of bug
against `settings.json`.

Fixed 2026-07-12: `package.json`'s `test` script now sets
`DATA_DIR="$PWD/.data-test"` (gitignored), and both test files read
`process.env.DATA_DIR` instead of hardcoding `./data`.

**Why:** discovered when running `bun run test` mid-session deleted 110 of
111 synced FM community tunes from the live dev DB; recovered via
`POST /api/tunes/community/refresh` (CDN itself was untouched).

**How to apply:** if community tunes (or anything in `data/`) look wiped
after running tests, it's almost certainly this class of bug reappearing —
check for new test files that touch `server/db/index` or `data/settings.json`
without going through `DATA_DIR`/`resolveDataDir()`. Never assume a test that
mutates shared state is hermetic just because it has `beforeEach`/`afterEach`
cleanup — the cleanup can itself run against the wrong DB.
