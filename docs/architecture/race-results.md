# Race Results

RaceIQ normalizes race outcomes into game-neutral materialized projections that can be rebuilt from the authoritative [race-event timeline](race-event-timeline.md) and explicit classification evidence.

## Data contract

`session_results` stores at most one normalized result per telemetry session. It records session type, classification, finishing and qualifying positions, podium and fastest-lap flags, pit count, strategy snapshots, derivation status, provenance, unresolved reasons, and the canonical event IDs that support event-derived fields.

Pit visits and service observations live in session-owned `race_events`, not under the result. Pit count is projected from unique canonical pit-entry lifecycles. Tire and fuel strategy is projected only from matching service events; entry into pit road alone never proves a service action.

## Derivation and provenance

Pure functions under `server/race-results/` normalize adapter-specific source data. Shared rules:

- derive classifications and positions only from explicit evidence;
- distinguish unknown, unsupported, and ambiguous values from zero;
- preserve fuel added separately from fuel level;
- classify pit service only when tyre or fuel evidence exists;
- retain source details and the rule used for derived flags.

Game adapters expose source data without changing the shared result contract.

## Reconciliation

Live completion projects a result after committed timeline and lap updates. `server/race-results/reconcile.ts` provides bounded historical enrichment: it reads a current canonical timeline or invokes the shared raw rebuild entry point when replayable events are missing or stale, then upserts the result projection. It does not redetect or persist a separate event ledger.

Failures enrich reconciliation status instead of invalidating the underlying session. Results report processed, enriched, unchanged, skipped, ambiguous, and error outcomes with per-session reasons.

## APIs and consumers

Typed routes expose individual results, bounded reconciliation, recent summaries, and aggregates. Aggregate queries scope by game before applying driver, car, or track identity filters. Clients consume shared DTOs rather than reproducing result calculations in page components.

## Primary implementation

- `server/race-results/derive.ts`: normalized derivation
- `server/race-results/source.ts`: adapter source extraction
- `server/race-results/reconcile.ts`: idempotent result enrichment and rebuild coordination
- `server/race-results/aggregates.ts`: game-scoped summaries
- `server/db/schema.ts`: `session_results` and session-owned `race_events`
- `server/db/race-event-queries.ts`: canonical timeline reads used by projections
- `server/db/session-result-queries.ts`: result persistence and reads
