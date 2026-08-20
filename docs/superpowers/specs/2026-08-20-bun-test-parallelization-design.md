# Bun Test Parallelization Design

## Problem

The repository runs 2,932 Bun tests across 251 files in roughly 13 minutes. `bunfig.toml` globally preloads `test/support/setup-data-dir.ts`, which deletes and migrates one shared `.data-test/test.db`, opens shared libSQL/Drizzle clients, and installs global teardown. The same config caps `maxConcurrency` at 2.

The cap protects shared-state integration tests and was introduced for memory/reliability. It also constrains tests that should be pure and parallel-safe. Bun's `--parallel` worker mode cannot be enabled for the complete suite: worker processes do not safely share the current preload/database lifecycle, and a smoke run produced the repository's DB safety error when `DATA_DIR` was absent.

The suite must separate deterministic unit tests from resource-owning integration tests, then parallelize only the safe boundary.

## Goals

- Provide fast local unit-test feedback using Bun worker processes.
- Preserve current shared-database safety for integration tests.
- Run unit and integration suites independently in CI.
- Make DB coupling explicit and prevent accidental preload reintroduction.
- Establish repeatable timing and pass/fail measurements.

## Non-goals

- No production database behavior changes.
- No immediate conversion of every DB test to per-test databases.
- No unrestricted integration concurrency.
- No telemetry algorithm or fixture optimization in this change.

## Chosen approach

Use separate Bun configs and commands.

### Unit runner

Add `bunfig.unit.toml` with the test root and unit-safe settings, but no DB preload. Add a `test:unit` script that invokes Bun with worker parallelism. Worker count is configurable through `BUN_TEST_WORKERS`, with a conservative default suitable for local and CI memory limits.

The unit command must select an explicit DB-free manifest or path set. A dynamic import scan is not acceptable as the runtime safety mechanism because indirect imports are difficult to classify reliably and failures would be late. The initial manifest should contain deterministic parser, model, scorer, utility, and isolated file/fixture tests confirmed during implementation.

Unit tests MUST NOT:

- Import `server/db` directly or indirectly.
- Require `test/support/setup-data-dir.ts` side effects.
- Mutate `.data-test` or production-like data directories.
- Depend on process-global server, pipeline, or DB singletons.
- Access network or live-game resources.

### Integration runner

Add `bunfig.integration.toml` retaining the existing preload, timeout, root, and `maxConcurrency = 2` behavior. Add a `test:integration` script that sets `DATA_DIR` to the repository `.data-test` directory and selects the integration manifest.

Integration coverage includes DB migrations/seeds, routes backed by persistence, experiments, driver profiles, race-result persistence, discovered entities, telemetry persistence/replay, and any test with direct or indirect shared DB state. These tests continue to run against the existing single shared DB until a later isolation project is approved.

### Combined command

Keep `bun run test` as the required full-suite command, implemented as unit followed by integration. This preserves one-command verification while ensuring unit workers finish before shared DB setup starts. The command must propagate the first failing exit status and must not hide which suite failed.

## Test classification

Classification is explicit and reviewable:

1. Start with tests already proven to have no DB or global runtime dependency.
2. Add files to the unit manifest only after running them with no preload.
3. Treat any DB import, server singleton, pipeline maintenance task, persistent settings access, or shared output directory as integration.
4. Keep uncertain files in integration until their dependency boundary is refactored.
5. Document the boundary and manifest maintenance rules in `test/README.md`.

The implementation should prefer a small number of stable path groups over a large generated list. If a directory contains mixed boundaries, use explicit file paths or split the directory only where a real ownership seam exists.

## CI rollout

Split the existing test job into two steps or jobs:

- Unit job: run `bun run test:unit` with configured worker count.
- Integration job: run `bun run test:integration` with existing DB-safe concurrency.

Expose both results through the existing required test check. Keep install/build setup shared where CI supports it, but do not share `.data-test` between concurrent jobs. If jobs run on separate machines, each gets its own workspace; otherwise assign unique `DATA_DIR` values.

## Verification

Before changing commands, generate the client i18n artifacts required by the current repository workflow and run the current full suite as a baseline. Record wall time, pass/fail/skip counts, and known environmental failures.

Acceptance checks:

1. `bun run test:unit` succeeds with no migration output and no DB preload execution.
2. `bun run test:unit` succeeds repeatedly with randomized test order.
3. `bun run test:unit` uses multiple Bun workers and is materially faster than sequential execution.
4. `bun run test:integration` preserves the current DB setup and passes with `maxConcurrency = 2`.
5. Integration order randomization does not introduce new failures beyond characterized existing issues.
6. `bun run test` runs both suites and propagates failures.
7. CI reports unit and integration results independently.
8. Combined pass/fail counts match the clean baseline, excluding explicitly fixed or newly characterized failures.
9. Peak memory remains within the existing CI runner budget.

Measure unit, integration, and combined wall time separately. Do not claim a speedup from a run that has unrelated missing generated artifacts or other known setup failures.

## Failure handling

- If a unit test imports DB indirectly, move it to integration or introduce a narrow dependency injection seam; do not weaken DB safety checks.
- If integration tests fail only under order randomization, classify the shared-state assumption and either add cleanup or keep the affected file in a serialized group.
- If Bun worker processes do not honor the selected config consistently, stop and report the runtime limitation rather than enabling unsafe global parallelism.
- If integration runtime remains dominant after the split, design a separate per-worker DB isolation project; do not raise the shared DB concurrency cap opportunistically.

## Future optimization

After this design is implemented and measured, consider per-worker temporary DB directories for integration workers. That is a separate change because it affects migrations, module-level DB singleton lifecycle, test cleanup, and fixture assumptions.
