# Indexed session lap archive

Status: superseded by the explicit [physical per-lap file cutover](sparse-split-migration-backend-plan.md#physical-file-implementation-phase). The archive representation below is historical and is no longer the completed-session writer contract. Earlier measurements remain recorded in [progress](../../progress.md#indexed-session-lap-archive).

ADR: [Indexed gzip storage for split session captures](../adr/0012-indexed-session-lap-archive.md)

Related baseline: [Lossless per-lap capture correction](lossless-per-lap-capture-correction.md). This plan changes the published storage container, not lap detection or native-frame semantics.

## Goal

Store all split laps and remaining source records in one compressed archive per published session bundle, inside that session's folder. Reading one lap must seek to and decompress only that lap's entry, without extracting the archive, decompressing other laps, or replaying the monolithic session.

Storage reduction is an objective to measure, not an assumed consequence of putting files in a container. Keep monolithic sources retained under the existing policy; do not claim their space is reclaimed.

## Proposed representation

Use the existing gzip implementation with independently compressed members and a versioned JSON sidecar index. This replaces the original ZIP/ZIP64 proposal at the user's explicit request. Do not use a solid stream or nest gzip files inside another compressed container.

```text
<game-recording-directory>/
  session-<sessionId>/
    <jobId>-<attemptId>-<sourceRevision>/
      manifest.json
      capture.bin.gz
```

The data file concatenates one independent gzip member per lap or auxiliary range. Manifest v4 records controlled entry identities, physical member offsets, compressed lengths, uncompressed lengths, and existing source ownership/checkpoint fields. Seek directly to the selected member and bound the compressed read to its declared range. Each range must contain exactly one member, with validated CRC, size, and complete DEFLATE consumption. Safe-integer offsets support large sessions without ZIP64 structures. The sidecar and archive publish together through the existing atomic attempt-directory rename.

This is one archive for the current published bundle, not one archive per lap. Attempt identity remains in the directory for publication fencing. Temporary staging and older referenced attempts follow existing recovery/reference-aware cleanup rules; never overwrite an archive that readers already reference.

A lap member contains its independently decodable sparse capture, required parser bootstrap, owned records, and permitted non-owned completion context. Auxiliary members preserve source records outside lap windows, including startup, gaps, trailing records, and context markers. An auxiliary chunk ID identifies one such range; it is not a lap number. Preserve existing chunk identities where possible; derive controlled entry names from identifiers, not user labels.

## Non-negotiable invariants

- Reconstruct exactly the same native frame bytes, order, timestamps, and timestamp absence as the retained source. Compression changes storage bytes only.
- Keep detector offsets/counts authoritative. Boundary context is duplicated only as explicitly non-owned context; every source record has exactly one owner across lap and auxiliary entries.
- Each lap replays independently with its existing checkpoint/bootstrap semantics. No decoder state may depend on another archive entry.
- A single-lap read may read archive metadata and that lap's compressed entry only. No full-archive materialization, permanent extraction cache, or silent monolith fallback for an invalid published layout.
- Bound memory by metadata and the selected lap's existing consumer needs, not the session's uncompressed size. Stream decompression where the consumer permits it.
- Verify the closed archive before publication. Cancellation, corrupt output, stale attempts, or failed publication must not expose partial results.
- Keep existing published directory manifests readable with their original interpretation. Null-layout historical fallback remains unchanged.

## Current integration points

- `packages/capture-splitting/src/contract.ts`: explicit v3 directory and v4 indexed-gzip manifests. Published DB layout 1 retains directory semantics; layout 2 stores the JSON and archive paths separately.
- `packages/capture-splitting/src/{index,worker,client,protocol}.ts`: package-owned writing, verification, staging worker and progress contracts.
- `apps/backend/src/session-capture/split-manager.ts`: currently creates `session-<sessionId>/<attemptKey>/`, renames staging, then publishes references in a fenced transaction.
- `server/session-capture/source-loader.ts`: bounded manifest caching and typed selected-member sources; archive entry names are never invented filesystem paths.
- `server/session-capture/{compressor,cleanup,session-cleanup,layout-migration,relocate-recordings}.ts`: maintenance and representation accounting.
- Audit DB publication/readiness, reprocessing, raw lap readers, recorded replay, export/import, hashing/provenance, and cache invalidation consumers before changing their contracts. Locate their actual callsites during implementation rather than creating a parallel reader convention.

## Phase 1 — Archive contract and bounded reader

1. Reuse existing streaming gzip APIs. Prove bounded range reads and selected-member decompression; do not select an API that loads the complete archive into memory.
2. Introduce manifest v4 for archive-backed bundles, retaining explicit v3 directory schemas. Distinguish archive filesystem location from member identity, physical member offsets and compressed/uncompressed sizes from artifact-local and source offsets. Preserve physical source-size semantics and ownership fields. Validate the index against archive size, member framing, checksums, and exact compressed-byte consumption.
3. Persist a distinct nullable `captureArchiveFile` DB reference under layout version 2. Keep `captureManifestFile` as the JSON path for both layouts; layout 1 retains v3 directory semantics. Upgrade schema/contracts and writers/readers together.
4. Implement one shared artifact-source abstraction using existing streaming/reader conventions. Support legacy files and bounded gzip member streams; adapt consumers that genuinely need a selected lap buffer without buffering other laps.
5. Cache only validated archive index/manifest metadata, keyed by immutable publication identity. Bound cache growth and invalidate on publication, deletion, relocation, or replacement.
6. Reject duplicate or unsafe identities, overlapping/gapped/out-of-bounds member ranges, unsafe numeric offsets, unsupported gzip flags, malformed/truncated headers or trailers, hidden additional members, size mismatches, and checksum failures. Apply explicit manifest/member size limits; never extract archive-supplied paths.

Acceptance: a generated multi-member archive reads one requested lap through the production reader; instrumented file ranges and decompression callbacks prove other lap payloads are untouched. Safe offsets above 4 GiB work without 32-bit truncation; invalid/corrupt input fails explicitly. Existing v3 directory bundles and historical null-layout reads remain supported.

## Phase 2 — Lossless archive writer and atomic publication

1. Keep sequential splitter ownership/preparation logic unchanged. Stream each completed capture into an independent gzip member with bounded writer state. Finalize the JSON index after physical member metadata is known.
2. Prefer direct archive writing. If library constraints require temporary per-entry files, document the reason, bound staging disk usage, and remove those files before publication; no loose lap files may remain as the published representation.
3. Verify through the production archive reader: source conservation, strict EOF handling, native bytes/times/order, entry identity and sizes, and independent lap replay. CRC is corruption detection, not a replacement for semantic losslessness checks.
4. Stage a complete archive within the session folder, close all handles, apply the project's durability convention, then atomically rename and publish its references under existing source/revision/attempt fences and maintenance locking.
5. Preserve truthful scan/write/verification counters, cancellation, retry limits, crash recovery, and notification ordering. Do not add unrelated progress UI changes.

Acceptance: successful splitting publishes one indexed gzip data file containing every lap and auxiliary range, with its JSON sidecar. Cancellation, disk/write failure, interruption before/after rename, failed DB transaction, stale attempt, and corrupt/truncated archive cannot publish partial or stale output. Retry/restart recovery preserves the last valid publication.

## Phase 3 — Consumer and lifecycle cutover

1. Migrate direct lap replay, Analyse reads, recorded replay, ZIP export, import/reprocessing paths, and semantic provenance to the selected artifact source. Keep saved timing/validity and frame-time behavior unchanged. An export may stream the selected member into its existing external format; it must not require extraction of the session archive.
2. Keep session-source hashing distinct from artifact hashing. Define hashes over the intended content representation; do not silently change identity to gzip's metadata-dependent bytes. Version any genuinely changed persisted identity contract.
3. Update cleanup, retention, session/lap deletion, compression, recording relocation/migration, readiness and storage accounting for a shared archive. Count its bytes once. Deleting one lap must not remove an archive referenced by other laps or sessions.
4. Protect queued/active work and all published references from orphan compression/deletion. Do not recompress the indexed gzip archive as a monolithic stream. Invalidate archive metadata/telemetry caches on the same publication/invalidation events as existing artifacts.
5. New splits write archives only. Existing directory bundles remain readable; automatic bulk conversion is not required. A future explicit re-split may publish an archive from retained source using the same fences, then remove unreferenced old representations through existing cleanup policy. Never mutate old manifests in place.
6. Remove obsolete new-write directory assumptions and temporary code. Retain only the explicit legacy read/lifecycle support needed for published v3 bundles.

Acceptance: replay/export of a chosen lap succeeds with the monolith unavailable and other entry payloads inaccessible to the reader. Cold/restarted and batched reads preserve telemetry and metadata. Reprocessing invalidation, reconnect readiness, relocation, shared references, cleanup with a missing monolith, and interrupted maintenance leave accurate usable references and byte accounting.

## Phase 4 — End-to-end proof, storage measurements, documentation

- Run actual source -> split archive -> independent replay across all six games, plain/gzip input. Compare reconstructed native bytes, timestamps including absence, ordering, consumer telemetry, saved timing/validity, sparse checkpoints, parser bootstraps, segment resets, final laps and delayed completion context.
- Independently account for all owned records in lap and auxiliary entries; separately check allowed synthesized initialization and duplicated boundary context.
- Measure selected-lap reads with the monolith unavailable. Record actual bytes/ranges read, selected compressed/uncompressed entry bytes, other entries decompressed (must be zero), latency, and memory scope. Separate application-cold from OS-cold claims.
- Compare matched directory and archive outputs on the same real source recordings with the same ownership windows. Report logical bytes, allocated disk bytes where supported, compression/write time, selected-lap latency, and peak memory using an appropriate measurement tool. Compare against already-compressed artifacts too if supported; do not present aggregation alone as compression savings.
- Use an actual multi-lap session, preferably 50 completed laps when a fixture is available; disclose repeated-window or synthetic workload limitations. Investigate regressions beyond measurement noise without inventing an unapproved performance threshold.
- Run focused behavioral regressions and applicable package/backend/client compiler gates, followed by backend integration after inputs stabilize. Include a standalone package smoke without backend imports. Exercise the existing UI only where readiness/export behavior is affected.
- Update architecture docs, capture storage contributor guidance, customer changelog, and progress status after verification. Report measured storage savings separately from retained-monolith storage.

Release acceptance requires every phase above. Evidence must distinguish losslessness, random-access isolation, compatibility, publication safety, and storage/performance measurements. Failed or unavailable checks remain explicit blockers or qualifications, never inferred passes.

### Implementation verification

All four phases are implemented. New publications contain only `manifest.json` and `capture.bin.gz`; explicit directory/legacy readers remain. Native-record conservation and independent consumer replay passed for six games with plain/gzip inputs, including compact real IBT-derived iRacing data. Actual workloads contain 3–7 saved detector windows per selected session, including invalid/start/end fragments; no repeated-window or 50-completed-lap claim is made.

Selected-reader instrumentation proves bounded physical reads and zero unrelated decompressions. A sparse-file probe exercises a member above 4 GiB. Full backend integration, package tests, workspace typechecks and lint pass. Production-route UI readiness, export, cold reload and actual WebSocket reconnect pass with the selected monolith hidden. Both headless screenshot attempts timed out; no visual-capture success is claimed.

Matched storage, streaming-gzip comparisons, allocation diagnostics, latency, memory scopes, retained-source totals and source timestamp qualifications are in [progress](../../progress.md#indexed-session-lap-archive). Container aggregation does not materially reduce already-gzipped payloads, and measured read overhead remains explicit. No source retirement, commits, or formal ADR acceptance occurred.

## Out of scope

Source retirement; live archive rotation; new lap detection; cloud/range-upload protocols; solid cross-lap compression; generic archive framework; automatic bulk migration; unrelated UI redesign. Implementation was authorized by the current request; commits, formal ADR acceptance, and removal of retained recordings were not requested.
