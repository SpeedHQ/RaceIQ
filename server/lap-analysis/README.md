# Lap analysis

## Purpose

Transforms completed-lap telemetry into deterministic comparison traces, corner and sector summaries, recording-quality decisions, recap statistics, persisted driver metrics, consistency traces, and text reports. Public entry points remain the named modules in this directory; there is no aggregate barrel.

## Structure

- `comparison.ts`, `corners.ts`, and `sectors.ts` align laps and derive distance-based structure.
- `insights.ts` owns the static-analysis version and track-aware detector entry point; `metrics.ts` and `stats.ts` own pure packet metrics and shared numerical primitives; `metrics-store.ts` owns persisted caches, stale backfill, and forced reruns.
- `quality.ts` applies recording-validity checks.
- `recap.ts` builds session recap data.
- `consistency.ts` measures racing-line and input repeatability.
- `report.ts` renders the stable text export used by analysis prompts and lap downloads.

## Boundaries and invariants

Telemetry units, game steering conventions, native sector layouts, and curated track geometry enter from existing shared/game and track APIs. Persistence remains isolated in `metrics-store.ts`; other modules are deterministic apart from persisted timestamps. Preserve threshold strictness, lap and corner ordering, sector authority and fallback precedence, interpolation rules, rounding precision, and report text exactly when changing calculations. Bump `LAP_METRICS_ALGO_VERSION` for segment-stat changes and `STATIC_LAP_ANALYSIS_VERSION` for detector-output changes.

## Testing

Use focused lap-analysis tests for comparison, consistency, corner detection, native and fallback sectors, quality, recap, metrics, and report rendering. Exercise malformed or incomplete telemetry alongside nominal laps, and assert exact ordering, thresholds, rounding, and rendered text where those are contracts.
