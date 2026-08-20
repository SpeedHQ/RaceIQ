# Task 1 Fix Report

Status: DONE_WITH_CONCERNS

## Commits

- `1327f508` — original Task 1 implementation.
- `cacadb33` — Bun discovery boundary fix and focused verification report.

## Fix

Bun 1.3.14 continued discovery from the repository root when explicit manifest files were passed. Added tracked dedicated suite roots (`test-unit-root/`, `test-integration-root/`) with only support symlinks required by tests. Runner now launches Bun from the dedicated root, passes absolute config paths and manifest paths relative to that root, preserving explicit manifests while preventing unrelated test discovery. No production DB/runtime files changed.

## Focused verification

- `cp scripts/test/unit-files.txt /tmp/unit-files.txt.task1 && printf 'test/client/parse-lap-time.test.ts\\n' > scripts/test/unit-files.txt && BUN_TEST_WORKERS=2 bun scripts/test/run-suite.ts unit` — PASS, Bun 1.3.14 launched parallel mode, 1 file, 5 pass, 0 fail; manifest restored.
- `cp scripts/test/integration-files.txt /tmp/integration-files.txt.task1 && printf 'test/db/database-path.test.ts\\n' > scripts/test/integration-files.txt && bun scripts/test/run-suite.ts integration` — PASS, shared integration preload/data-dir path exercised, 1 file, 4 pass, 0 fail; manifest restored.

Full unit/integration suites were not run. No formatter, linter, or project-wide suite run.

## Concerns

- Dedicated roots require support symlinks (`server` and `test/support`) so existing tests that resolve paths from process cwd remain cross-platform. Git tracks these symlinks; Windows checkout behavior should be confirmed in CI.
- Existing full unit manifest still contains DB-coupled files; this fix prevents accidental discovery but does not reclassify prior manifest entries.
