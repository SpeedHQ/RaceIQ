# Telemetry quality

Shared, browser-safe contracts and deterministic policies for deciding what recorded racing evidence can support.

## Model

Four concerns stay independent:

1. Structural lap validity says whether lap detection produced a complete, coherent lap.
2. Lap classification records phase (`flying`, `out`, `in`, `pit`, or `grid_start`) and conditions (`caution`, `slow_zone`, or `formation`).
3. Recording quality describes lifecycle, provenance, gaps, coverage, channel fidelity, freshness, and localized facts.
4. Analysis eligibility applies one named policy to that evidence and returns `eligible`, `eligible_with_warning`, `ineligible`, or `unknown` with stable reason codes.

A valid lap can be unsuitable for pace analysis. A non-pace lap can remain structurally valid and available for timing, strategy, or incident evidence.

## Modules

- `contracts.ts` defines source, participant, quality, fact, range, confidence, eligibility, and version contracts.
- `measure.ts` measures packet cadence, ordering, gaps, track coverage, channel state, and source limitations.
- `policies.ts` owns the versioned per-lap and group eligibility rules plus shared decision resolvers.
- `reasons.ts` owns stable reason metadata.
- `display.ts` renders deterministic reason and decision text for server and AI consumers.
- `retention.ts` defines raw and canonical evidence-retention assessments.

## Boundaries and invariants

- `QUALITY_SCHEMA_VERSION`, `QUALITY_CONFIG_VERSION`, `ELIGIBILITY_POLICY_VERSION`, `SOURCE_CHANNEL_PROFILE_VERSION`, and `EVIDENCE_RETENTION_POLICY_VERSION` identify separate compatibility boundaries. Bump only the version whose contract changed.
- Missing, stale, simplified, derived, and unavailable channels remain distinct; never replace missing evidence with zero.
- Facts retain source and participant provenance, stable evidence IDs, semantic channel IDs, and optional time or distance ranges.
- Persisted decisions are reproducible snapshots tied to source and output generations. SQL and UI code may read those decisions but must not recreate policy rules.
- Consumers use `resolveEligibilityDecision`, `evaluateEligibility`, `evaluateGroupEligibility`, or shared selection helpers. Do not add local `isValid` or pace-only substitutes.
- Unknown evidence is not eligible evidence. Warning decisions remain usable only where the named policy permits them.
- Structural validity and lap classification come from their owning lap contracts; quality measurement must not rewrite either.

## Testing

Use focused tests under `test/lap-analysis/` for measurement, classification, policy, source parity, and retention behavior. Cover localized gaps, absent channels, opponent limitations, legacy evidence, and version changes without weakening exact reason-code assertions.
