# Task 4 report — Measure, randomize, and verify runtime

## Status

**PARTIAL / BLOCKED BY ENVIRONMENT FIXTURES.** Unit suite is clean after four concrete DB-coupled tests were reclassified to integration. Integration starts and exercises 2,628 tests, but fails on missing generated/source artifacts and subprocess path assumptions. Full `bun run test` was not run because integration was not clean enough to establish safe full-suite evidence.

## Prerequisite

- i18n generated-artifact prerequisite: **not run**. Unit startup reached tests and did not report missing Paraglide/i18n artifacts.

## Runtime evidence

Commands run from repository root; timings are `/usr/bin/time -p` wall-clock `real` values.

1. `bun run test:unit` (before classification fix)
   - `real 0.85s`.
   - `282 pass, 2 skip, 4 fail, 4 errors`; 288 tests / 31 files; 54,650 expect calls.
   - All four failures were DB safety errors: `resolveDataDir(): refusing to return the real user data dir under test. DATA_DIR is unset` from `corner-resolution`, `clean-lap-aggregate`, `games/shared/parser`, and `laps/archive-detection`.
   - This is the expected concrete classification defect: unit runner intentionally has no DB preload.

2. `bun run test:unit` (after moving four files to integration)
   - `real 0.56s`.
   - `282 pass, 2 skip, 0 fail`; 284 tests / 27 files; 54,650 expect calls.
   - No migration/preload output. No DB safety errors.

3. `BUN_TEST_WORKERS=1 bun run test:unit`
   - `real 0.69s`.
   - `282 pass, 2 skip, 0 fail`; 284 tests / 27 files; 54,650 expect calls.
   - Runner output still identifies Bun as `10x PARALLEL`; command-level worker comparison is nevertheless recorded as requested. Parallel-vs-sequential wall-time delta: 0.13s (sequential slower in this small suite).

4. `bun run test:integration`
   - Timeout allowance: 1,800s; completed in `real 31.16s`.
   - `2549 pass, 2 skip, 77 fail, 2 errors`; 2,628 tests / 224 files; 49,569 expect calls.
   - DB setup ran: isolated `.data-test`, 47 migrations, versions v1 and v13–v58 logged; no DB safety refusal.
   - Failures are environmental/generated-artifact issues, not evidence of parallel DB corruption: missing test recording fixtures under `test/artifacts/sessions`, missing `data/diagnostics/.../racinginsights-v1-6d9873a-paths.json`, missing `test/artifacts/carsetup/Default-12312.carsetup`, missing generated/runtime subprocess modules when integration runs from its temporary cwd (`server/db/index.ts`, `test/support/db/migrations.ts`, `scripts/data/seed-db.ts`, `scripts/ui/collect-screenshot-diffs.ts`), and one catalog typecheck failure. Settings tests also logged fallback warnings for invalid `.data-test/settings.json` (`driverProfileMaxOutputTokens` below 512).

5. `bun run test`
   - **Not run.** Integration was not clean enough; running combined suite would be redundant and would not provide trustworthy speedup evidence.

## Manifest validation

Focused manifest check (one-off Bun script) reported:

```json
{"unit":27,"integration":224,"total":251,"duplicates":[],"missing":[]}
```

All 251 ordinary test files are present exactly once across manifests. No randomization was performed; existing runner does not expose a supported randomization option without expanding scope.

## Classification fix

Moved these files from `scripts/test/unit-files.txt` to `scripts/test/integration-files.txt`:

- `test/games/shared/parser.test.ts`
- `test/lap-analysis/clean-lap-aggregate.test.ts`
- `test/lap-analysis/corner-resolution.test.ts`
- `test/laps/archive-detection.test.ts`

Reason: each imports/initializes the server DB path indirectly and requires integration preload / `DATA_DIR` isolation.

## Recommendation

Keep four files in integration. Fix temporary-cwd subprocess path resolution and restore required generated/fixture artifacts in a separate task before using integration or combined-suite timings as a performance baseline. Do not claim a speedup from this run; only unit parallel-vs-single-worker timings are clean, and the observed 0.56s vs 0.69s difference is a small-suite measurement rather than a broad benchmark.
