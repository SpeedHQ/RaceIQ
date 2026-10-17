---
status: superseded
---
# Indexed gzip storage for split session captures

Plan: [Indexed session lap archive implementation](../plans/indexed-session-lap-archive.md)

Related decision: [Package-owned indexed capture splitting](0011-package-owned-indexed-capture-splitting.md).

Superseded by the explicit physical-per-lap requirement in [ADR 0011](0011-package-owned-indexed-capture-splitting.md) and the [physical-file cutover plan](../plans/sparse-split-migration-backend-plan.md#physical-file-implementation-phase). The content below records the earlier proposal, not the current completed-session output format.

## Context

Split captures previously published a directory containing a manifest and independently replayable lap/auxiliary artifacts. The implemented change groups those artifacts into one compressed archive per session publication while preserving the ability to read only a selected lap. Losslessness includes native bytes, order, acquisition timestamps or their absence, parser initialization, and exact-once source ownership; equal lap counts are insufficient.

## Proposed decision

Publish one indexed gzip data file per current session bundle inside an immutable attempt directory under `session-<sessionId>/`. Use the existing gzip implementation to write each sparse lap capture and auxiliary range as an independent member. A versioned JSON sidecar records each member's physical offset, compressed length, uncompressed length, and semantic ownership metadata. Auxiliary ranges retain records outside detected laps rather than discarding them.

Seek to the selected member through bounded file reads. Decompress only that range; never materialize or extract the complete archive to read one lap. Validate gzip framing, CRC, size, and exact DEFLATE consumption, rejecting hidden extra members. Keep independently decodable checkpoints/bootstrap state in each lap. Use safe-integer offsets for large captures.

Introduce an explicit archive storage/manifest version and migrate consumers together. Preserve existing directory manifest interpretation and legacy null-layout behavior. Keep source offsets, artifact offsets, archive locations, entry names, and physical compression metadata distinct. Reject corrupt or ambiguous archives instead of silently falling back to the monolith.

The splitter package continues to own generic splitting and verification; the backend continues to own fenced atomic publication, DB references, invalidation, maintenance and retention. Verify the closed staging archive before publication. Cleanup and accounting treat it as one shared representation, removing it only when no references remain. Retain monolithic sources under existing policy.

## Rationale and consequences

Indexed independent gzip members preserve the existing compression implementation while providing isolated lap access and fewer files. This replaces the original ZIP proposal at the user's explicit request. Whole-session single-member gzip and solid compression require decoding unrelated data and remain rejected. Keeping separate lap files does not meet the requested single-data-file representation.

Independent compression may save less than solid compression. Container aggregation alone does not guarantee savings, especially against already-compressed files; matched measurements must establish actual results. Bounded streaming, checksum validation, safe index validation, legacy reads, publication recovery, and shared-reference cleanup remain release requirements.

This proposal was not formally accepted and is now superseded for completed-session storage. Its historical implementation and measurements do not override the current physical-file requirement or authorize source retirement.
