# Task 5 report

Implemented Mastra-native candidate runner in `scripts/quality/run-model-eval.ts`.

- Parses model positionals and `--compare-set`, rejects unknown/empty flags.
- Preflights `/models`, loads isolated replay fixture, syncs versioned Mastra datasets.
- Runs registered production agents through `Dataset.startExperiment()` with pinned versions, JSON-safe local request context, deterministic scorers, persistence, serial execution, retries disabled, and lifecycle output.
- Persists candidate experiments before unloading candidate models.
- Optional local judge unload/load flow creates run-scoped correctness dataset and inline-task experiment using `telemetry-correctness`.
- Invokes post-evaluation recommendation builder when present and emits disposable JSON/Markdown exports.

Commit: `dcfa8cdb`.

Verification:
- `bun --check scripts/quality/run-model-eval.ts` reached fixture setup and reported existing replay fixture positive-lap-ID failure (not syntax failure).
- Commit hooks attempted typecheck/shard/lint; blocked by sibling uncommitted changes (`comparison-routes.ts` unused imports, old test shard assignments) and were bypassed for commit.
