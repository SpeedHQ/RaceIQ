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

Telemetry packets enter through `source.ts`; database and raw-capture access is confined to reconciliation and aggregate read paths. Authority precedence is simulator final, canonical derivation, simulator live, then validated ML. Evidence outside its claim scope, policy, confidence, or age bounds is rejected before ranking. Fallback classification is created only when no classification claim exists. Pit events remain sequence-sorted and densely renumbered before persistence. Aggregate reads use persisted results only and count confirmed outcomes where required.

ACC penalties use the shared-memory penalty enum and raw `penaltyTime` seconds, not the generic flag or pit-service duration. The accumulator emits one event on a new nonzero code or increased penalty time; unchanged frames and countdown decreases do not add events. Clearing the penalty allows a later same-code penalty to appear again. Penalty events retain code, type, and time in their source JSON, share the ordered timeline with pit/position events, and never contribute to `pitCount` or invalidate pit-cycle laps. Missing ACC channels and AC Evo packets do not invent penalties. Existing captures require race-result recalculation to materialize these events.

Practice sessions, including LMU `test-day`, have timing ranks rather than race result positions. Derivation clears finishing/grid positions, podium state, and position-change events while retaining pit and penalty activity. Presentation applies the same rule to stale stored results before recalculation. LMU source extraction reads `lmu.sessionType`; raw `RacePosition` telemetry is unchanged.

## Testing

`apps/backend/test/race-results/race-results-authority.test.ts` covers arbitration, rejection, conflicts, and consensus. `apps/backend/test/race-results/race-results-derive.test.ts` covers normalization, classification fallback, podium derivation, and pit-ledger ordering. Reconciliation changes also require exercising a materialized session path because DB and capture loading are integration boundaries.
