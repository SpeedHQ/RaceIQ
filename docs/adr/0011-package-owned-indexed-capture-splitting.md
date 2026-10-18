---
status: proposed
---
# Package-owned indexed capture splitting

## Context

Issue #463 requires closed recordings to become lossless, independently replayable per-lap BIN artifacts. The intended algorithm is sequential: follow detector-indexed windows, append the next lap's first frame as non-owned trailing context, finalize the previous artifact, and start the next with that same frame.

The current implementation already has `@raceiq/capture-splitting`, but generic checkpoint preparation and overlap normalization remain application-owned. Review also found physical source ranges calculated from decoded sparse payload sizes, acceptance of incomplete source tails, lost import bootstraps, stale publication after reprocessing, unsafe queued-source compression, incomplete bundle cleanup, and unwired readiness notifications.

## Decision

Correct and reuse `@raceiq/capture-splitting` as the owner of indexed-window validation/normalization, generic initialization preparation through injected game-owned codecs, sequential artifact writing, verification, manifests, and worker protocol. `@raceiq/capture-formats` owns exact encoded source boundaries and strict decoding. Concrete parser state and checkpoint encoding remain game-owned.

The package imports no backend, server, client, DB, game registry, or concrete game parser. The host supplies source/index and binds opaque checkpoint codecs. Backend wrappers invoke package APIs; they do not retain another splitting or preparation algorithm.

Backend retains queue/recovery, source revision and attempt fencing, transactional DB publication/invalidation, maintenance coordination, and status notifications. Workers stage and verify but never publish DB references or retire sources. Client renders authoritative readiness.

Preserve reconstructed native frame bytes, order, and timestamps; independent sparse checkpoint encoding may differ from original storage bytes. Context duplication does not change ownership. Preserve auxiliary source records and existing game-controlled delayed-finish behavior.

Completed-session publications use one physical sparse `.bin` file per persisted lap, with separate auxiliary files and directory manifest v3 / database layout 1. Logical members inside a shared archive do not satisfy this requirement. Historical layout-2 archives remain readable until consent-driven, verified physical-file migration commits; new completed splits and imports do not publish archives. Canonical source retention remains unchanged. This clarification supersedes the completed-session representation proposed in [ADR 0012](0012-indexed-session-lap-archive.md), without activating the separately release-gated live recorder.

## Rationale and consequences

A small sequential writing loop is sufficient; sparse storage dependency and stateful parser initialization are explicit format requirements, not reasons to redetect laps or introduce a new framework. One writing pass does not require one total source read: existing opaque checkpoint preparation and independent verification may scan separately. Injected codec preparation avoids backend dependencies and per-frame cross-thread RPC.

Keeping preparation in backend would preserve duplicate domain ownership. Loading concrete game adapters in the worker would violate the backend-free package boundary and risk dependency cycles. Neither is required for the correction.

Publication activates bundle consumers, so reprocessing, durable import, compression/deletion, provenance, and UI corrections must pass before release. Retain monolithic sources throughout; their retirement is not part of this correction. Preserve legacy reads and existing published manifest interpretation.

Implementation follows this proposed contract. Exact encoded offsets and strict decoding come from `@raceiq/capture-formats`; package preparation uses injected opaque codecs and the writing pass is sequential, with independent conservation verification. Imported bootstraps persist through pending and active recording. ZIP initialization/completion context remains non-owned; saved timing/validity restores from existing metadata, never inferred ownership. Workers stage and verify; backend fences publication and invalidation. Compression protects split-job/published sources; migration fences and requeues unpublished work after releasing the maintenance lock while preserving active/published provenance. Reference-aware cleanup accounts for nested/shared bundles, restores readiness on pre-delete failure, and reports partial irreversible deletion. Committed snapshots supply cache/reconnect readiness; notification failures cannot undo publication. Null-layout legacy exports remain valid.

Status remains proposed: this records the architecture contract and its implementation, not formal ADR acceptance.

Plan: [Correction phases and acceptance criteria](../plans/lossless-per-lap-capture-correction.md)

Physical-file cutover plan: [Storage, migration, and verification](../plans/sparse-split-migration-backend-plan.md#physical-file-implementation-phase).

Related: [Lossless sparse canonical recordings](0001-lossless-sparse-canonical-recordings.md)
