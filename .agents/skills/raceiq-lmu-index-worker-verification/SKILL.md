---
name: raceiq-lmu-index-worker-verification
description: "Diagnose RaceIQ LMU opponent indexing that works from source but fails in compiled builds, or integration tests hanging on maintenance scheduler fibers."
---

# RaceIQ LMU opponent-index verification

Use for source-versus-compiled LMU opponent-index failures and maintenance test hangs.

## Compiled indexing

- `server/session-capture/lmu-opponent-index-runtime.ts` launches a named embedded worker in compiled mode: `./server/session-capture/lmu-opponent-index-worker.ts`.
- `packages/tooling-build/src/build/build.ts` must include that worker in the `bun build --compile` entrypoints. A successful build without this entrypoint can still produce an application whose opponent catalog transitions from queued to failed.
- Rebuild using `bun run build:browser` when client sources changed. For build-only investigation, the build script can reuse an unchanged client build. Do not rebuild while a browser harness is starting or using the executable; replacement can cause `posix_spawn ENOENT`.
- Existing diagnostic logging can be enabled with `RACEIQ_LMU_OPPONENT_INDEX_TEST_METRICS_FILE=/tmp/<unique-name>.json`. Avoid setting `RACEIQ_TEST_MODE=1` on the normal seeded browser harness: it changes database initialization and can break seeding.

## Maintenance test completion

`getRecordingMaintenanceController().fibers` includes permanent scheduler fibers. Never await the entire set to wait for one removal operation. Reuse the existing job-only pattern:

1. Snapshot the fiber set before `startSessionOpponentRemoval`.
2. Start removal.
3. Observe only fibers added by that operation.
4. Await their completion, then assert removal status, retained player data, and cleanup/recovery behavior.

Relevant examples: `packages/game-lmu/test/e2e/backend/integration/opponent-routes.test.ts`, `session-capture/direct-capture-repair.test.ts`, and `session-capture/opponent-removal.test.ts` beneath the same backend test root.

## Test budgets and isolation

- Supported suite: `bun run --cwd packages/game-lmu/test test:integration`.
- `scripts/test/run-suite.ts` supplies isolated data directories, application preloads, sequential integration execution, and a global 20-second CLI timeout. Native multi-import/reconciliation cases may need explicit per-test limits.
- Measure before increasing limits. Bun JUnit output (`--reporter=junit --reporter-outfile=/tmp/<unique-name>.xml`) exposes case durations. Previous measurements found legitimate native cases taking 24–35 seconds and a five-scenario identity case taking about 75 seconds; these are environment-dependent observations, not required thresholds.
- Timeouts do not necessarily stop underlying asynchronous work. A first timeout can cascade into `MOVE_ACTIVE`, `IMPORT_ACTIVE`, missing indexes, and cross-test instrumentation failures. Diagnose the earliest failure; do not suppress downstream errors or weaken assertions.
- Bun tests take a numeric timeout or `{ timeout: milliseconds }` as their third argument. Playwright's `test.setTimeout()` is not the Bun API.

## Actual compiled integration

Run after builds finish:

```sh
env E2E_SERVER_MODE=compiled PW_SERVER_SET=seeded \
  RACEIQ_FEATURE_F1_EXPERIMENTS=true RACEIQ_FEATURE_IRACING_ADAPTER=true \
  bunx playwright test --config=playwright/playwright.config.ts \
  --project=seeded-imports --workers=1 --retries=0 \
  --grep 'imports retained history|supports touch-sized viewport'
```

These scenarios exercise real indexing, separate Driver/Lap controls, preview/cancel, exact URL references, reload hydration, playback, export/import, opponent removal, and mobile German UI. Keep assertions aligned with current control ownership; driver names belong to Driver, not the lap label. Preserve behavioral checks when deleting obsolete wording assertions.

A passing source suite does not prove the packaged worker works. Completion requires the compiled browser scenarios plus relevant typecheck, lint, and build gates.
