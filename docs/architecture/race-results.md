# Race Results

RaceIQ normalizes race outcomes and pit activity into game-neutral records that can be rebuilt from stored telemetry and consumed consistently across product surfaces.

## Data contract

`session_results` stores at most one normalized result per telemetry session. It records session type, classification, finishing and qualifying positions, podium and fastest-lap flags, pit count, strategy snapshots, derivation status, provenance, and unresolved reasons.

`pit_events` stores an ordered ledger for a result. Events may include lap, elapsed time, duration, service classification, tyre details, and fuel changes. Missing values remain nullable. A pit event does not imply tyres or fuel were changed unless source data supports that conclusion.

## Derivation and provenance

Pure functions under `server/race-results/` normalize adapter-specific source data. Shared rules:

- derive classifications and positions only from explicit evidence;
- distinguish unknown, unsupported, and ambiguous values from zero;
- preserve fuel added separately from fuel level;
- classify pit service only when tyre or fuel evidence exists;
- retain source details and the rule used for derived flags.

Game adapters expose source data without changing the shared result contract.

## Reconciliation

`server/race-results/reconcile.ts` provides the common path for live completion and historical enrichment. It processes sessions in bounded order, decodes available raw telemetry, derives a result, and upserts the result and pit ledger. Stable session and event identities make reconciliation safe to rerun without duplicate rows.

Failures enrich reconciliation status instead of invalidating the underlying session. Results report processed, enriched, unchanged, skipped, ambiguous, and error outcomes with per-session reasons.

## APIs and consumers

Typed routes expose individual results, bounded reconciliation, recent summaries, and aggregates. Aggregate queries scope by game before applying driver, car, or track identity filters. Clients consume shared DTOs rather than reproducing result calculations in page components.

## Primary implementation

- `server/race-results/derive.ts`: normalized derivation
- `server/race-results/source.ts`: adapter source extraction
- `server/race-results/reconcile.ts`: idempotent enrichment
- `server/race-results/aggregates.ts`: game-scoped summaries
- `server/db/schema.ts`: `session_results` and `pit_events`
- `server/db/queries.ts`: result persistence and reads
