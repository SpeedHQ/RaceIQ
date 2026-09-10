# End-to-end tests

`test/e2e/` exercises complete recording-backed flows: ingest captured game data,
parse it through adapters and pipelines, persist results, and validate outputs.
These tests cross domain boundaries and are not substitutes for focused unit or
integration coverage.

## Layout and inputs

- Root recording suites cover FM 2023, F1 2025, iRacing, and UDP capture flows.
- `ac-evo/` and `acc/` hold game-specific recording suites.
- `output/` holds committed or generated visual output used by E2E checks.
- Shared telemetry-catalog E2E suites live with their domain in
  `test/telemetry/catalog/`, not in this directory.

Recording inputs remain under `test/artifacts/` (for example,
`test/artifacts/sessions/`). `test/fixtures/` contains small immutable
deterministic inputs. `test/ai-fixtures/` is reserved for AI eval data. Artifacts
are generated or captured outputs; they are not fixtures and must not be described
as having moved when only test code is reorganized.

## Commands

Run recording E2E suites through the dedicated manifest:

```sh
bun run test:e2e:recordings
```

For focused iteration, run a path directly:

```sh
bun test test/e2e --timeout 30000
bun test test/telemetry/catalog --timeout 30000
```

Run standard discovered coverage with `bun run test`. Use a focused path while
iterating; run E2E only when recording, adapter, pipeline, persistence, or output
behavior is involved. Captured recordings may be absent in a fresh checkout, so
suites that require optional artifacts should skip with a clear reason rather than
silently use production data.

## Placement rules

1. Put a test in `e2e/` when it proves an end-to-end recording or output contract.
2. Keep game-specific cases below `e2e/<game>/`; keep cross-game catalog cases in
   `telemetry/catalog/`.
3. Put reusable readers, assertions, and renderers in matching `test/support/`
   domains; keep one-consumer helpers local to their test.
4. Keep input paths stable under `test/artifacts/`; never generate artifacts in
   `test/fixtures/`.
5. Prefer splitting files near 400 lines only at real behavior seams. Line count
   alone is not a reason to split a cohesive recording scenario.
