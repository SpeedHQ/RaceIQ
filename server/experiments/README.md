# Experiments

## Purpose

Own tuning-experiment state, setup lineage, reversible actions, lap evidence, and statistically defensible arm comparisons. Domain code turns stored lap/setup data into experiment decisions and evidence; it does not own HTTP routing, database schema, telemetry decoding, setup-file formats, or AI presentation.

## Structure

- `active.ts`, `auto-exclude.ts`, and `undo.ts` manage local active-session state, experiment-scoped lap curation, and action reversal.
- `setup-lineage.ts` resolves setup-bearing ancestors and active setup context across file-backed and snapshot-backed games.
- `representative-lap.ts` provides the single-lap fallback used when aggregate evidence is unavailable.
- `lap-evidence/aggregate.ts` selects clean laps and builds symptom, track-condition, consistency, and line-spread evidence.
- `comparison/metrics.ts` defines metric-specific curation and sampling; `stream.ts` samples frame metrics within the disclosed frame budget; `compare.ts` performs deterministic statistical comparison; `load.ts` connects those pure calculations to experiment and lap reads.

## Boundaries and invariants

- Lap eligibility, outlier handling, reference-lap choice, sample ordering, minimum frame count, and frame-budget drops are explicit parts of comparison evidence. Never trim or reorder them silently.
- Frame metrics hold one reference lap and one candidate lap at a time. Both comparison arms use the same fence policy and are streamed sequentially.
- Significance describes distinguishability from noise, not a tuning verdict. Persisted verdicts remain human decisions.
- Setup lineage walks through drill nodes to the nearest setup-bearing ancestor and guards cycles. F1 setup state is JSON snapshot data; ACC and AC EVO normally use guarded setup files.
- Active experiment state is process-local and singular. Undo preserves action order and uses existing database operations for reversible subtree changes.
- Database queries, telemetry parsing, corner/consistency analysis, setup-file I/O, HTTP validation, and AI wording remain owned by their respective domains; this folder consumes those contracts without redefining them.

## Testing

Pure curation, metrics, statistics, frame selection, streaming equivalence, and evidence aggregation should use deterministic synthetic laps. Integration coverage should exercise setup lineage, database-backed comparison loading, active-session stamping, and undo behavior while asserting unchanged sample counts, lap-id order, response fields, and persisted payload shapes.
