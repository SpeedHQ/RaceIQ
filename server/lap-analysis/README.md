# Lap analysis

## Purpose

Transforms completed-lap telemetry into deterministic comparison traces, corner and sector summaries, recording-quality decisions, recap statistics, persisted driver metrics, consistency traces, and text reports. Public entry points remain the named modules in this directory; there is no aggregate barrel.

## Structure

- `comparison.ts`, `corners.ts`, and `sectors.ts` align laps and derive distance-based structure.
- `metrics.ts` and `stats.ts` own pure packet metrics and shared numerical primitives; `metrics-store.ts` owns their database cache.
- `quality-generation.ts` finalizes reproducible source/output identities; `quality-rebuild.ts` chooses eligibility-only rebuild or raw reprocessing.
- `canonical-archive-availability.ts` reports canonical inventory support, which is currently unavailable; `evidence-retention.ts` evaluates whether raw removal would preserve required policy evidence.
- `recap.ts` builds session recap data.
- `consistency.ts` measures racing-line and input repeatability.
- `report.ts` renders the stable text export used by analysis prompts and lap downloads.

## Boundaries and invariants

Telemetry units, game steering conventions, native sector layouts, and curated track geometry enter from existing shared/game and track APIs. `metrics-store.ts` owns metric-cache persistence; quality rebuild, canonical-archive availability, and retention are explicit database/filesystem-backed status modules. Remaining computational modules are deterministic apart from the metrics timestamp. Preserve threshold strictness, lap and corner ordering, sector authority and fallback precedence, interpolation rules, rounding precision, and report text exactly when changing calculations. Cached metric shape changes require an algorithm-version bump.

Packet-derived facts may be recomputed from retained evidence. A stale detector, quality schema, or measurement configuration requires raw reprocessing; only a stale eligibility policy can rebuild decisions from stored quality facts. Persist every result with the applicable version and generation identity so cached analysis remains reproducible.

## Testing

Use focused lap-analysis tests for comparison, consistency, corner detection, native and fallback sectors, quality, recap, metrics, and report rendering. Exercise malformed or incomplete telemetry alongside nominal laps, and assert exact ordering, thresholds, rounding, and rendered text where those are contracts.
