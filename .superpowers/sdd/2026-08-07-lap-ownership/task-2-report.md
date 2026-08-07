
## ZIP follow-up

Updated `/api/laps/import-zip` to require exact ownership, and threaded ownership through `importLapsZip` into every binary member import. Client payload callers intentionally unchanged for Task 5.

Verification: affected archive/transfer route TypeScript diagnostics clear; `git diff --check` passed. Focused route/archive regression tests remain a concern.
