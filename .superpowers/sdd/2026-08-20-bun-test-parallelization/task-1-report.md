

## Reviewer fix round 1

Status remains: DONE_WITH_CONCERNS.

Removed tracked root symlink trees. Runner now creates disposable per-run staging roots under the OS temp directory, stages only manifest files plus `server` and `test/support`, uses POSIX symlinks or Windows directory junctions, and removes staging after child exit. Reclassified `test/lap-analysis/lap-detector-ac.test.ts` and `test/lap-analysis/lap-export-zip.test.ts` from unit to integration.

Focused reruns:

- `BUN_TEST_WORKERS=2 bun scripts/test/run-suite.ts unit` with temporary one-entry manifest (`test/client/parse-lap-time.test.ts`) — PASS, 5 pass, 0 fail.
- `bun scripts/test/run-suite.ts integration` with temporary one-entry manifest (`test/db/database-path.test.ts`) — PASS, 4 pass, 0 fail; migration/database path setup exercised.

Temporary manifests restored. Full suites, formatters, linters, and project-wide checks not run.
