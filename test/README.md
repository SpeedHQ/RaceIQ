# Test layout

`test/` is executable coverage plus test-only support and data. Keep each test in
owning domain directory; keep reusable code under `test/support/<domain>/`.

## Discovery and commands

`bunfig.toml` sets `test.root = "./test"`, so Bun recursively discovers files
ending in `*.test.ts` and `*.test.tsx` below `test/`. Files ending in
`*.ai-eval.ts` are not part of normal discovery. AI evaluation is an explicit
entry point:

```sh
bun run test
bun test test/games/shared/parser.test.ts --timeout 30000
bun run test:ai
bun run bench
```

`bun run test` is standard suite. Focused command runs one final-path file;
Bun preload still isolates `DATA_DIR` in `.data-test`. `bun run test:ai` runs
`test/ai/evals/ai-quality.ai-eval.ts` with its longer timeout. `bun run bench`
runs `test/benchmarks/pipeline.bench.ts`; benchmarks are explicit scripts, not
ordinary tests.

## Top-level map

| Path               | Boundary and purpose                                                |
| ------------------ | ------------------------------------------------------------------- |
| `ai/`              | AI unit and prompt/provider tests; explicit evals under `ai/evals/` |
| `client/`          | Client-side logic and component contract tests                      |
| `db/`              | Database migrations, seeds, and persistence integration             |
| `driver-profile/`  | Driver-profile domain tests                                         |
| `e2e/`             | Recording-backed end-to-end checks and rendered outputs             |
| `experiments/`     | Experiment and drill behavior                                       |
| `games/`           | Per-game parsers, recorders, SDKs, and shared game contracts        |
| `lap-analysis/`    | Lap quality, detection, recap, segments, and stint analysis         |
| `live-strategy/`   | Live sector and pit strategy behavior                               |
| `motec/`           | MoTeC import and visualization behavior                             |
| `race-results/`    | Race-result capture, storage, source, and derivation                |
| `routes/`          | Server route contracts and request behavior                         |
| `runtime/`         | Runtime options, settings, updates, and supervision                 |
| `session-capture/` | Session recording, compression, and binary storage                  |
| `setups/`          | Setup formats, tuning, and setup engineering                        |
| `telemetry/`       | Telemetry models, pipelines, resolver, catalog, and catalog E2E     |
| `tooling/`         | Developer tooling and UI-diff contracts                             |
| `tracks/`          | Track models, guides, coverage, and visualization                   |
| `benchmarks/`      | Explicit performance scripts (`*.bench.ts`)                         |
| `support/`         | Shared test-only helpers; no test cases                             |
| `fixtures/`        | Small committed deterministic inputs and golden files               |
| `ai-fixtures/`     | Curated AI-eval inputs, packets, and score baselines                |
| `artifacts/`       | Generated or captured local outputs; not source fixtures            |

## Test boundaries

- **Unit:** deterministic function, parser, model, scorer, or component behavior;
  no network, live game, or uncontrolled filesystem dependency.
- **Integration:** multiple server/domain pieces together, including database,
  adapters, pipelines, routes, and persistence. Use isolated `.data-test` state.
- **E2E:** real recording/artifact input across ingestion, parsing, persistence,
  and output boundaries. Put recording-driven suites in `e2e/`; telemetry catalog
  E2E suites stay in `telemetry/catalog/` with that domain.
- **Benchmark:** performance measurement only. Keep setup and input stable; run
  through `bun run bench`, never as part of standard discovery.
- **AI eval:** model-backed quality checks under `ai/evals/`; use explicit
  `*.ai-eval.ts` entry points and curated `ai-fixtures/` data.

## Support extraction

Extract code to `test/support/<domain>/` when two or more tests share setup,
parsing, assertions, fixture loading, or rendering logic. Keep one-consumer
helpers beside their test. Name support after its domain (`support/laps`,
`support/recordings`, `support/telemetry`, `support/tracks`, `support/motec`),
not a catch-all helper dump. Support must stay test-only and must not
silently change production behavior.

## Fixtures and artifacts

Committed fixtures are immutable inputs or expected outputs used to make a test
deterministic. `test/fixtures/` and `test/ai-fixtures/` hold those inputs;
`test/artifacts/` holds generated reports, visualizations, logs, and captured
recordings. Do not move, rewrite, or describe artifacts as fixtures. Do not
commit a generated artifact when a small deterministic fixture is sufficient.

## Placement checklist

1. Pick owning domain from map; use `*.test.ts` or `*.test.tsx` for discovered tests.
2. Use `*.ai-eval.ts` only for explicit AI eval entry points.
3. Reuse or add domain support under `test/support/`; avoid generic helper dumps.
4. Keep immutable inputs in `fixtures/` or `ai-fixtures/`; keep generated output in
   `artifacts/` or the documented E2E output directory.
5. Run focused command first, then `bun run test`; run AI or benchmark commands
   only when their boundaries are involved.

Prefer splitting files near 400 lines when a real behavior seam exists. This is
maintenance guidance, not a blind line-count rule: cohesive behavior may stay
in one file, while unrelated behavior should split earlier.
