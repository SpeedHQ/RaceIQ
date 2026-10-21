---
status: proposed
---
# Incremental live lap capture publication

Plan: [Live lossless lap splitting](../plans/live-lossless-lap-splitting.md)

Related decisions: [Package-owned indexed capture splitting](0011-package-owned-indexed-capture-splitting.md), [Indexed gzip storage](0012-indexed-session-lap-archive.md).

## Context

Live recording currently persists a canonical source, then queues whole-session preparation, splitting, and verification after recording closes. Detector ownership and live parser state are already available during capture, but are not connected to an incremental artifact publication contract. Existing closed archive validation requires an index covering physical EOF; it cannot safely represent a growing archive unchanged.

## Proposed decision

Extend the existing capture packages with an ordered, bounded live writer. Keep exact sparse encoding and logical source offset reservation on ingress; move filesystem work, artifact encoding/compression, and verification into background processing. Capture exact pre-frame parser initialization and consume authoritative detector ownership transitions. Preserve all source records, including auxiliary ranges and non-owned completion context.

Append verified independent gzip members to one session archive. Introduce an explicit live committed-prefix storage contract and transactional per-member publication; never reinterpret the closed v4 manifest or mutate previously published bytes. Readers use bounded committed snapshots. Final close drains unresolved work and seals metadata without rescanning or recompressing completed windows. Retain the canonical source under current policy.

Preserve the closed-source splitter for imports, historical captures, changed-window reprocessing, and exceptional recovery, not the normal successful live close path. This proposal extends the earlier closed-recording-only scope; it does not retroactively change those decisions or accept them formally.

## Rationale and consequences

Logical offset reservation avoids per-frame worker RPC and preserves detector byte coordinates. Worker-owned I/O and bounded batched transport isolate recording ingress from disk and compression waits. Incremental verification preserves independent replay and conservation checks without a normal post-session processing round.

Per-frame parser checkpoint copying, unbounded lap buffers, archive copies for each publication, and weakening the closed reader's EOF validation are rejected. Exact checkpoint coverage and stable detector ownership require explicit implementation gates, especially for delayed completion and retroactive starts. The concrete new storage version and final closed-layout transition must be fixed before reader implementation.

Finite buffering cannot guarantee unconditional lossless recording through an arbitrary disk stall from an unpausable UDP source. Distinguish accepted, written, verified, and durable records; fail recording explicitly on exhausted capacity rather than block ingress or silently lose accepted frames. Process or hardware failure preserves the last durable prefix, not every packet observed in memory. Numeric performance claims require matched runtime measurements.

Status remains proposed. This document authorizes no implementation, commits, source retirement, or release claim.
