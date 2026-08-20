# Analysis provenance

RaceIQ persists one versioned receipt for each telemetry-derived artifact set. Receipt JSON is browser-safe and contains source identity, telemetry and analysis component versions, effective configuration, output inventory, coverage, capability, warnings, and verification checks. `analysis-receipt-v1` is strict: unknown fields are rejected and hashes use canonical JSON with `sha256:` followed by 64 lowercase hexadecimal characters.

## Receipt contract

`AnalysisProvenanceReceipt` contains `receiptSchemaVersion`, `generationId`, `artifactSetId`, `artifactSetType`, `generation`, `lifecycle`, `sessionId`, optional `participantId`, `evidence`, `telemetryVersion`, sorted `analysisComponents`, hashed `configuration`, `context`, `sourceFidelity`, `outputs`, optional `canonicalInventory`, warnings, unsupported fields, rebuild capability, verification checks, and lifecycle timestamps.

Artifact-set types are `canonical_archive`, `session_analysis`, `lap_analysis`, `comparison_analysis`, `driver_profile`, and `report`. User statuses are `current`, `stale_rebuild_available`, `stale_source_missing`, `rebuild_in_progress`, `verification_failed`, `incompatible`, and `corrupt`. Stale reasons are `receipt_missing`, `source_hash_changed`, `source_unavailable`, `receipt_schema_changed`, `telemetry_contract_changed`, `detector_changed`, `algorithm_changed`, `configuration_changed`, `output_verification_failed`, and `rebuild_interrupted`.

Rebuild capability is `exact`, `limited`, or `unavailable`, with source kind, rebuildable artifacts, unavailable artifacts, and limitations. Fixed verification checks are `source_hash`, `schema_supported`, `session_identity`, `participant_identity`, `ordering`, `coverage`, `channel_inventory`, `partitions_readable`, `analyse_read`, `compare_read`, and `storage_state`; each is `passed`, `failed`, or `not_applicable`.

## Lifecycle and status

Receipt lifecycle is persisted state: `rebuild_in_progress`, `active`, `superseded`, or `verification_failed`. User-facing status is computed from receipt validity, persisted artifact audit, current source identity, current component/configuration identity, and registered rebuild capability. Lifecycle never substitutes for status: a failed attempt can coexist with a still-served active generation, and storage damage reports `corrupt` even when receipt JSON remains valid.

Legacy sessions have no fabricated generation or receipt. Readable raw evidence reports `stale_rebuild_available`; missing evidence reports `stale_source_missing`. A failed attempt reports `verification_failed` while previous active artifacts remain served.

## Active-generation rules

Each artifact set has monotonically increasing generations, at most one in-progress attempt, and at most one active generation. Activation validates the complete receipt and inventory, supersedes the old active row, stamps compatibility projections, and commits in the caller transaction. Terminal rows are immutable. Failed activation rolls back artifact replacement and records a separate terminal failure attempt.

For `session_analysis`, one generation covers laps, race events, session runs, race result, and quality. SQLite IDs, timestamps, local paths, user notes, and tune links are excluded from semantic hashes. Inventory audit reconstructs semantic hashes and coverage from active rows before reporting current status.

## Verification gate and rebuild sequence

1. Read source under capture-maintenance lock and compute source hash.
2. Allocate generation attempt; same-set concurrent work returns conflict.
3. Build complete candidate artifacts in memory, including analysis generation on events and runs.
4. Re-hash source and verify identity, ordering, references, counts, coverage, schemas, and configuration.
5. In one SQLite transaction replace replayable artifacts, update quality/source projections, rebuild persisted runs, persist receipt, supersede prior active row, stamp projections, and activate.
6. Invalidate replay caches and publish notifications only after commit.

Canonical archives use same receipt contract. Availability is true only for a valid active `canonical_archive` receipt with source/output hashes, supported schema, semantic channel inventory, readable partitions, and every applicable canonical verification check passed. This issue does not create Parquet bytes or a reader.
