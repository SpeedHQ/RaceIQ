# Race results

## Purpose

Materialize durable race outcomes from captured telemetry, arbitrate conflicting classification evidence, derive pit and podium facts, and expose persisted summaries.

## Structure

- `source.ts` extracts game telemetry observations and evidence.
- `authority.ts` applies the configured classification authority policy.
- `derive.ts` normalizes sessions and derives the canonical result.
- `pit-ledger.ts` builds ordered pit events.
- `reconcile.ts` loads session inputs and persists reconciled results.
- `aggregates.ts` reads summaries and recent materialized results.
- `provenance.ts` records parser, catalog, derivation, authority, and input identities.
- `types.ts` defines in-domain observation and derived-result shapes.

## Boundaries and invariants

Telemetry packets enter through `source.ts`; database and raw-capture access is confined to reconciliation and aggregate read paths. Authority precedence is simulator final, canonical derivation, simulator live, then validated ML. Evidence outside its claim scope, policy, confidence, or age bounds is rejected before ranking. Fallback classification is created only when no classification claim exists. Pit events remain sequence-sorted and densely renumbered before persistence. Quality linkage compares event and packet timestamps only when their game-specific clock domains match; otherwise it requires matching lap numbers. Aggregate reads use persisted results only and count confirmed outcomes where required.

## Testing

`test/race-results/race-results-authority.test.ts` covers arbitration, rejection, conflicts, and consensus. `test/race-results/race-results-derive.test.ts` covers normalization, classification fallback, podium derivation, and pit-ledger ordering. Reconciliation changes also require exercising a materialized session path because DB and capture loading are integration boundaries.
