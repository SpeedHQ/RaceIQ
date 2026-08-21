# Analysis provenance

RaceIQ persists one versioned receipt for each telemetry-derived artifact set. Receipt JSON is browser-safe and contains source identity, telemetry and analysis component versions, effective configuration, output inventory, coverage, capability, warnings, and verification checks. `analysis-receipt-v1` is strict: unknown fields are rejected. Hash encoding depends on hash class; every digest is `sha256:` followed by 64 lowercase hexadecimal characters.

## Receipt contract

`AnalysisProvenanceReceipt` contains `receiptSchemaVersion`, `generationId`, `artifactSetId`, `artifactSetType`, `generation`, `lifecycle`, `sessionId`, nullable `participantId`, `evidence`, `telemetryVersion`, sorted `analysisComponents`, hashed `configuration`, required `context.gameId`, `sourceFidelity`, `outputs`, nullable `canonicalInventory`, warnings, unsupported fields, rebuild capability, verification checks, and lifecycle timestamps.

Artifact-set types are `canonical_archive`, `session_analysis`, `lap_analysis`, `comparison_analysis`, `driver_profile`, and `report`. User statuses are `current`, `stale_rebuild_available`, `stale_source_missing`, `rebuild_in_progress`, `verification_failed`, `incompatible`, and `corrupt`. Stale reasons are `receipt_missing`, `source_hash_changed`, `source_unavailable`, `receipt_schema_changed`, `telemetry_contract_changed`, `detector_changed`, `algorithm_changed`, `configuration_changed`, `output_verification_failed`, and `rebuild_interrupted`.

Rebuild capability is `exact`, `limited`, or `unavailable`, with source kind, rebuildable artifacts, unavailable artifacts, and limitations. Fixed verification checks are `source_hash`, `schema_supported`, `session_identity`, `participant_identity`, `ordering`, `coverage`, `channel_inventory`, `partitions_readable`, `analyse_read`, `compare_read`, and `storage_state`; each is `passed`, `failed`, or `not_applicable`.

## Hash identities and reproduction

Structured contract, configuration, and semantic-output hashes use `analysisCanonicalHash(value)`: hash UTF-8 `canonicalJson(value)` bytes with SHA-256, then prepend `sha256:`. Use RaceIQ's `shared/core/canonical-json` implementation, not an arbitrary JSON serializer.

- Configuration hash: canonical JSON of `effectiveConfiguration`.
- Contract hash: canonical JSON of `{ receiptSchemaVersion, telemetryVersion, analysisComponents }`, with `analysisComponents` sorted by `id`.
- Semantic output hash: canonical JSON of each output's logical semantic payload, after inventory builds its documented canonical logical ordering. Semantic hashes deliberately exclude SQLite IDs, timestamps, local paths, user notes, and tune links.

Raw evidence never uses canonical JSON. For one raw capture, read stored bytes, gzip-decompress when storage is gzip, then SHA-256 those decompressed bytes. Hashing compressed storage bytes produces a different and invalid evidence hash.

For multi-artifact evidence, preserve importer artifact order. For each artifact, append and hash this exact byte sequence: unsigned 32-bit little-endian UTF-8 name length, unsigned 64-bit little-endian artifact-byte length, UTF-8 name bytes, then artifact bytes. Continue directly with next artifact; no JSON wrapper, delimiter, or sort is added. For example, a MoTeC import hashes `source.ld` followed by optional `source.ldx` using this framing. This length-prefixing makes artifact boundaries unambiguous.

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

## Canonical archives

Canonical archives use `artifactSetType: "canonical_archive"` and the same strict receipt contract as other artifact sets. Persisted archive evidence uses `canonical-archive`; `originalSourceKind` retains native source kind. Archive Parquet follows schema `canonical-archive-v1`; builder identity is `canonical-archive-builder-v1`. Receipt output inventory records `telemetry.parquet` as `artifactType: "canonical_archive"` with row count, coverage, and deterministic output hash. `canonicalInventory` records semantic IDs, event IDs, and row counts needed to verify archive contents and advertise rebuild capability.

Builds require `gameId` and a retained source content hash. Builder checks source identity before reading telemetry and again after reading it, aborting if source changes during build. Staged Parquet must be readable with expected row count before rename; receipt verification then covers source hash, supported schema, identities, ordering, coverage, channel inventory, readable partitions, analysis reads, comparison reads, and storage state. Receipt activation occurs only after candidate archive rows and hierarchy nodes are persisted and verified.

Only archives that pass this gate with `status: "verified"` and `completeness: "complete"` qualify as retained rebuild evidence or a source for session-analysis rebuilds. Partial, corrupt, unverified, or unavailable archives never advertise rebuild capability and never justify raw-capture deletion. Verified complete canonical evidence can provide only the artifacts declared by its receipt; capability remains `limited` when exact native-source reprocessing still requires retained raw evidence.
