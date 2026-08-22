# Findings

## Boundary

This directory defines browser- and Node-safe, versioned, serializable findings. Producers remain authoritative for telemetry calculations and quality decisions. Adapters translate producer output into `FindingRecord`; they do not recalculate it. Persistence, UI, reports, profile generation, AI context, and future live consumers share these records through explicit leaf imports. No barrel exists.

`FindingRecord` contains deterministic evidence and measurements. `FindingRecommendation`, `FindingNarrative`, and `FindingDelivery` are separate downstream concepts. Generated prose, AI cache state, delivery policy, and recommendation text never enter finding identity. `FindingGenerationReceipt` records source/rule/config/schema lifecycle without embedding prose or raw telemetry.

## Identity

`createFindingId` uses finding type, complete scope coordinates, sorted evidence kind/ID coordinates, comparison reference ID, analysis source generation ID, and rule version. Object key order and evidence insertion order cannot change identity. Title, narratives, recommendations, delivery, and other prose cannot change identity. Comparison reference changes identity. Conflict checks reject materially different structured records sharing one ID.

## Availability

Missing data remains `null` or an unavailable/indeterminate finding; it never becomes numeric zero. Available findings require typed measurements and evidence. Null measurements carry `unavailableReason`. Unavailable and indeterminate findings carry stable limitation codes, with optional human detail and evidence references. `unknown` confidence does not imply zero confidence or available evidence.

Findings report observations and deterministic associations only. They do not establish causation. Producers, renderers, aggregators, UI, and AI consumers must not upgrade correlation, timing, or repeated occurrence into causal claims.

## Integration flow

1. Existing analysis producer computes result and quality decision.
2. Adapter preserves exact IDs, ranges, units, semantic IDs, derivation version, comparison selection, and limitations.
3. `createFindingId` assigns canonical identity; `validateFinding` verifies contract and identity.
4. Completed-lap processing stages and atomically activates the whole generation after the lap is durable, then publishes a typed read-only event. Failed activation preserves the previous generation and publishes nothing; publication has no delivery or voice side effect.
5. Compatible repeated lap findings may aggregate through median, majority, and observed frequency. Cross-session, participant, car, track, context, generation, rule-version, reference, or target-scope input is refused. One-off findings remain unmerged below configured persistence threshold.
6. Analyse, Compare, exports, and the deterministic renderer consume structured records directly. AI receives quality-qualified structured context downstream and may cite supplied available evidence only.
7. Narratives, recommendations, caches, and delivery records link by finding ID but remain independently versioned and stored.

Canonical units are explicit stable unit identifiers. Sample counts describe actual contributing samples. Telemetry evidence uses exact references and ranges, never packet copies. Aggregation preserves contributing lap IDs plus best, worst, and typical examples; these examples remain evidence selection, not causal explanation.
