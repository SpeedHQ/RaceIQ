# Live lossless lap splitting

Status: proposed implementation plan. No runtime changes implemented or performance claims verified.

ADR: [Incremental live lap capture publication](../adr/0013-live-lossless-lap-splitting.md)

Related plans: [Lossless per-lap capture correction](lossless-per-lap-capture-correction.md), [Indexed session lap archive](indexed-session-lap-archive.md).

## Goal and scope

Extend lossless lap splitting into live recording. Capture each source record once at ingress, prepare independent lap initialization while parser state is available, and write, compress, verify, and publish completed laps in the background. Normal session close must not scan the recording, rerun lap detection, prepare all parser checkpoints, recompress completed laps, or invoke the existing whole-session split job.

Keep one indexed gzip archive per session capture, native-frame losslessness, existing detector ownership, independently replayable laps, auxiliary records, and retained canonical source policy. Imports, historical recordings, explicit reprocessing, and exceptional recovery retain the closed-source splitter. This proposal extends the previous closed-recording-only policy; it does not authorize source deletion or change external export formats.

“Non-I/O-blocking” means no filesystem operation, compression, verification, durability wait, or new publication DB wait on packet ingress. It does not mean zero CPU work, zero copies, instantaneous shutdown, or unlimited buffering. Existing detector DB work is separate; this change must not introduce additional per-frame DB work.

## Current integration and gaps

| Area | Existing behavior | Required change |
| --- | --- | --- |
| `server/telemetry/live-pipeline.ts` | Writes source before `detector.feed`; rewrites the triggering frame after recorder epoch changes; `_reconcileRecordedSession` queues splitting after close. | Ordered record/control events, canonical offset repair before boundary publication, incremental close acknowledgement instead of normal split enqueue. |
| `packages/capture-formats/src/session/{recorder,sparse-recorder}.ts` | Sparse encoding and logical offsets; filesystem opening includes synchronous directory checks/creation; buffered flush and final header patch. | Separate logical encoding/offset reservation from worker-owned file lifecycle, writes, flush, and close. |
| `server/games/packet-dispatch.ts`, `server/games/types.ts` | Live parsing owns mutable state privately; checkpoint hooks exist but are not handed to live capture. | Exact pre-frame parser initialization handoff, with checkpoint coverage for every supported stateful game. |
| `server/lap-detection/{types,detector}.ts`, `packages/telemetry-core/src/processor/` | Detector owns offsets/counts; saved notifications are not an authoritative raw-window protocol; predictions and replaceable snapshots are insufficient. | Explicit stable ownership/start transitions, separate from UI notifications and provisional snapshots. |
| `packages/capture-splitting/src/` | Package-owned preparation, normalization, writing, verification, gzip members, and worker protocol. | Shared incremental state machine and bounded worker transport; no second splitter implementation. |
| `packages/capture-splitting/src/archive.ts` | Closed archive index must cover exactly the complete file. | Explicit live committed-prefix contract; preserve strict closed-archive validation. |
| `server/db/session-queries.ts`, `server/db/lap-read-queries.ts`, `server/session-capture/source-loader.ts` | Session-wide fenced publication/readiness; layout 2 / manifest v4 archives and legacy directory reads. | Per-lap committed publication, live generation fencing, bounded prefix reads, and final seal. |
| `apps/backend/src/runtime/udp-listener.ts`, backend split manager/runner | Additional recorder ownership and closed-source worker lifecycle. | Audit every live ingress/recorder owner; ensure one writer and no duplicate source recording or automatic second split. |

The existing archive plan/ADR status text can lag implementation. Use current contracts as the implementation baseline; do not assume live append safety from the presence of archive support.

## Required invariants

1. Preserve reconstructed native bytes, order, acquisition timestamps and their absence. Do not reconstruct source bytes from normalized telemetry.
2. Detector `rawByteOffset` and `rawFrameCount` remain ownership authority. Lap labels, packet-list membership, `onLapSaved`, and `shouldCheckpointBeforeWrite` are not ownership decisions.
3. Every accepted source record has exactly one owner across lap and auxiliary ranges. Initialization and permitted duplicated completion context are explicitly non-owned. Normalize the existing one-frame overlap exactly as the offline splitter does; reject larger overlap or unaligned ranges.
4. Every lap starts with independently decodable sparse storage and required parser state immediately before its first owned frame. Preserve imported bootstraps, segment resets, startup/gaps, and trailing records.
5. No artifact is ready before its complete member is closed, independently verified, durable under the stated policy, and transactionally referenced. Active/incomplete snapshots are not immutable completed laps.
6. Published archive bytes never change. Append is allowed only beyond the previously committed end; readers are bounded to a validated committed snapshot.
7. Memory and queued work are bounded by configured byte budgets and bounded unresolved state, never full session duration. All errors and gaps remain visible; no silent drop or success after failure.
8. Normal close performs only outstanding-tail work and metadata sealing. Completed source windows and archive members are never rescanned or recompressed at close.

## Proposed architecture

### 1. Ordered ingress and worker transport

Keep existing sparse source encoding and logical encoded-offset reservation on ingress initially. Detectors require the source offset immediately; moving offset allocation behind worker RPC would serialize packet processing on the worker. Keep this CPU-only path bounded and measured. Refactor out all filesystem access rather than merely wrapping the existing synchronous recorder API in an async function.

Emit an ordered stream keyed by capture epoch and monotonically increasing record/control sequence: start, framed source record, bootstrap/segment marker, candidate start/checkpoint, resolved ownership window, persisted lap binding, and close. Records include exact encoded start/end, native record identity, and timestamp presence. Reserve transport capacity before mutating encoder/offset state so enqueue failure cannot advance a supposedly captured source. Session-rotation trigger rewrites remain explicit and occur once per affected capture epoch.

Use batched transferable buffers with a fixed in-flight byte budget, maximum batch bytes, and short maximum batching delay. Acknowledge consumed bytes and durable sequence separately. Never transfer/detach buffers still owned by parsers, sparse encoders, or callers; take at most the necessary owned transport copy. Avoid per-frame cross-thread request/response, structured-cloning telemetry objects, and unbounded promise chains. Control events share ordering with frames and cannot bypass the byte budget.

The worker owns canonical source file creation/writing/header patching, artifact encoding, gzip, verification, and flush/sync. Backend binds opaque game checkpoint operations; the generic package must not import concrete games, DB, or backend registries. Independent parser replay checks run through existing host-bound codecs outside packet ingress, not by sending parser functions through worker messages.

### 2. Boundary and initialization protocol

Add detector transitions carrying canonical source coordinates and a stable ownership revision, including next-window start, finalized prior window, exact allowed trailing context, and explicit final incomplete-window handling. Bind the persisted lap ID asynchronously; source processing does not wait for publication. If the DB lap insert fails, preserve records but do not publish an unbound ready lap.

Use candidate starts for preparation only; seal ownership only after detector confirmation. Serialize feed, recorder epoch repair, session transitions, snapshot replacement, stale flush, and finalization. Provisional paused-session snapshots remain replaceable and cannot seal a member.

Before selecting the buffering strategy, audit all game engines for delayed completion, start trimming, packet-rate filtering, reset, and retroactive ownership. Establish a detector watermark: records before this point can no longer move between lap and auxiliary ownership. Fix any discrepancy between persisted offsets/counts and trimming semantics; do not introduce different live ownership to hide it.

Capture parser initialization at the parser boundary, not after `processPacket` has already received a parsed packet. Avoid a deep parser snapshot on every frame: use game-owned copy-on-write/versioned pre-frame state or bounded checkpoint anchors with incremental candidate preparation. Capture only state required for independent replay. A candidate invalidated by later detector resolution is discarded, not published.

This is a release gate, not an assumption: every possible authoritative start must have valid pre-frame initialization. For retroactive starts, retain a bounded candidate interval and replay only that unresolved interval from its checkpoint outside ingress. If a game cannot provide bounded initialization or ownership resolution, implement the missing game contract before enabling its live path; do not silently use a session-close preparation scan.

### 3. Streaming write and incremental verification

Extract reusable ownership normalization, artifact initialization, encoding, and verification primitives from the existing splitter. Keep the offline API using those primitives.

Stream the active candidate member as records arrive; maintain only the boundary lookbehind and unresolved candidate data needed by the detector contract. Do not buffer an entire lap in memory. Do not append tentative bytes to the published archive: use bounded streaming staging for the unresolved member. Ambiguous intervals can spill to the retained canonical source; any reread is limited to that unresolved interval and happens during capture, not as a normal full-session close pass. Cancel/rebuild only unpublished tentative output if ownership changes.

At a confirmed boundary, finish the prior member with the explicit context policy, then start the next member from its independent checkpoint and parser initialization. Keep source byte coordinates, artifact-local offsets, archive physical offsets, and member lengths distinct. Preserve auxiliary ranges and reset markers even when no valid lap is detected. Long auxiliary ranges may be chunked at safe checkpoint boundaries to bound pending work.

Maintain incremental source ownership counts and ordered semantic digests over native bytes, timestamp presence/value, and required source metadata. Independently decode each closed staged member through production readers, compare its owned stream against the expected source ledger, and validate context/initialization separately. Where independent parser replay is needed, run it while that lap is being finalized; persist the successful checkpoint/replay result. CRC alone is not a semantic verifier. Do not share encoder state with the verification decoder.

Verification may reread a closed lap member during recording. The eliminated work is the normal whole-source preparation/split/verification round after session end, not all verification I/O. Once verified, append its final gzip bytes once to the session archive; never recopy the completed archive to add a lap.

### 4. Incremental archive publication

Do not append to a v4 archive and weaken its exact-EOF validator. Introduce an explicit live storage/index contract, provisionally a new layout version, with capture epoch, attempt token, sequence, committed archive length, source watermark, and immutable member descriptors. Allocate the concrete version during implementation after checking concurrent schema changes.

Keep one archive at a stable capture-owned path. Each commit extends a contiguous verified prefix; published member bytes cannot be overwritten. Readers validate the index against the committed prefix, require exact member framing/CRC/DEFLATE consumption within it, and ignore only the explicitly uncommitted suffix. Closed v4 archives retain exact physical EOF validation. Cache by capture epoch plus committed generation, not mutable path alone.

Persist incremental member descriptors and progress in durable DB rows or the project's equivalent transactional journal. Do not rewrite an ever-growing full JSON manifest on every lap or copy an archive for each generation. After archive bytes are durable, transactionally insert the member descriptor, extend the committed prefix, bind the unchanged lap window/ID, and publish readiness. Fence capture epoch, attempt, prior generation, lap ownership revision, and source watermark. File growth is not a source-revision mismatch; unexpected replacement is.

Publish a lap-ready notification only after commit. An earlier lap remains readable while later members are staged/appended. Lap readiness is independent of whole-session readiness. Deleting or replacing a lap cannot delete shared archive storage still referenced elsewhere.

At successful close, serialize the final manifest once and atomically transition to the existing closed archive representation if its invariants are met, reusing the same archive bytes and preserving in-flight reader snapshots. Otherwise retain a sealed version of the explicit live contract; decide this schema detail before coding readers, not by reinterpreting v4. Neither option may require archive rewriting.

### 5. Close, durability, overload, and recovery

**Normal close:** finalize detector ownership; enqueue final lap/auxiliary context and close marker; drain outstanding worker work; patch/close canonical source; seal final archive metadata; publish terminal status. Suppress `_reconcileRecordedSession` split enqueue only after successful live seal. Close can await outstanding work without blocking the event loop; a backlog is reported as finalizing, never ready. Do not claim constant-time close while unverified work remains.

**Durability:** distinguish accepted in memory, written, verified, and durably committed sequences. Define and implement file sync and required directory sync/rename ordering before DB readiness. Periodic source durability bounds the crash-loss window; queue acknowledgement alone does not make a frame crash-safe. Do not promise zero crash loss for UDP packets not yet durable. Graceful close drains all accepted records; hardware/process failure preserves the last durable prefix.

**Overload:** reserve independent byte limits for transport, unresolved state, and pending verification. Favor canonical source writes over derived work. When derivation lags, retain source plus incremental ownership/checkpoint metadata and catch up from the earliest unresolved watermark during recording; do not hold arbitrary laps in memory. Keep overall worker scheduling bounded so compression cannot starve ingress drains.

Finite RAM, an unpausable UDP source, arbitrarily stalled disk, and unconditional lossless capture are incompatible. At exhausted transport capacity, fail recording explicitly at the last accepted sequence and preserve the durable prefix; do not block packet ingress waiting for disk, silently discard accepted records, or report a complete session. Telemetry display may continue, but recording failure/gap must be visible. Recovery cannot recover packets that were never accepted/durable.

**Restart/failure:** reconcile archive physical length against the durable committed prefix. Preserve committed members; remove/truncate only uncommitted tails under exclusive capture ownership. Recognize crash-after-file-sync/before-DB-commit without duplicate publication. Recover unpublished work from the canonical source and persisted checkpoints/windows starting at the last safe watermark. A damaged checkpoint can require exceptional offline recovery; expose that state explicitly.

Existing closed-source jobs remain for imports, historical captures, changed-window reprocessing, and explicit exceptional repair. Startup must not enqueue a second whole-session job for a healthy live capture. Reprocessing invalidates changed ownership transactionally before consumers can pair new windows with old members. Maintenance, retention, relocation, compression, and deletion must protect active capture files, staged data, journals, and all published prefixes.

## Implementation phases

### Phase 1 — Contracts and ownership proof

- Specify detector watermark/start/finalized-window events and source/transport offset accounting; update every detector implementation and recorder consumer.
- Audit all six games' live parser state and establish exact initialization coverage, including retroactive boundaries and running-start trimming.
- Define live index/DB schema, readiness, durability order, byte budgets, overload semantics, and compatibility migration before changing publication.
- Preserve legacy directory/v4 readers and existing import behavior. Document how live policy extends ADRs 0011/0012 without relabeling their historical decisions.

Acceptance: production-path fixture traces show authoritative windows and pre-frame initialization matching the offline path across every supported game, including session-trigger rewrites, segment resets, shared boundaries, delayed finish, snapshots/resume, and final incomplete laps. No reliance on checkpoint prediction as ownership truth.

### Phase 2 — Bounded worker writer and live splitting

- Separate CPU-only source encoding/offset reservation from worker-owned filesystem operations; migrate all live recorder owners.
- Implement ordered bounded batching, source durability acknowledgement, reusable streaming split primitives, candidate staging, per-member semantic verification, and archive append.
- Bind checkpoint/replay work through existing game interfaces; keep package/backend boundaries intact.

Acceptance: run actual ingress through worker capture for a multi-lap session; independently replay completed members while the next lap is recording. Slow/failing disk and saturated queues do not introduce ingress disk waits, unbounded memory, detached-buffer corruption, hidden loss, or false readiness. Observed native bytes and timing match the accepted source.

### Phase 3 — Publication, consumers, and lifecycle cutover

- Add fenced per-member commits and live prefix reader support; update lap readiness, cache keys, notifications/reconnect, replay, analysis, export, and relevant provenance consumers.
- Integrate final seal, startup reconciliation, maintenance protection, deletion/shared accounting, and changed-window invalidation.
- Remove the automatic close-time split for successfully sealed live captures; retain explicitly classified offline/recovery work only.

Acceptance: lap replay/export succeeds before session close with the monolith unavailable to readers; another lap can append without invalidating that read. Crash before/after archive sync, DB commit, final manifest write, and close preserves only valid references. Restart is idempotent; no duplicate members/jobs. Normal close records zero whole-source split/preparation/verification scans and zero recompression of completed members.

### Phase 4 — Performance and end-to-end release gates

- Compare baseline live recorder plus post-session split against the new pipeline on matched real multi-lap sources for all six games; use existing recorder/pipeline benchmark infrastructure.
- Measure ingress processing p50/p95/p99, event-loop delay, sustained throughput at observed peak game rates and burst replay, CPU, peak RSS, queued/unresolved bytes, disk bytes read/written, lap-ready latency, and close drain/seal latency. Report dataset/runtime/hardware and synthetic limitations.
- Verify queue and unresolved-state memory plateaus over long sessions, including long/unfinished laps and disk slowdown. Demonstrate no synchronous filesystem calls or awaited worker/publication I/O on the changed ingress path; wall-clock latency alone is insufficient proof.
- Independently compare native streams, ownership conservation, timestamps/absence, parser replay telemetry, saved timing/validity, sparse reset behavior, and auxiliary preservation. Compare new live results to the same detector's offline output; investigate disagreement rather than normalizing it away.
- Exercise the real recording and lap replay/export surface, readiness/reconnect, recording failure, and finalizing states. Run focused existing capture/backend regressions and applicable package/backend compiler and integration gates after inputs stabilize. Add permanent tests only for behavioral boundaries and failure invariants.
- Record measured results and choose numeric performance budgets against the baseline before enabling the new live default. No unsupported “fast” claim or invented timing guarantee.
- Update architecture/contributor docs and customer changelog after verification. Remove temporary probes. Do not claim storage savings from retaining both canonical source and archive.

Release requires every phase. Planning alone passes no runtime gate. No implementation or commit is authorized by this document.

## Explicit non-goals

Source retirement; solid cross-lap compression; a new lap detector; per-frame worker RPC; a replacement game parser framework; a new external upload/export format; bulk migration of historical captures; unrelated UI redesign; hiding unsupported games behind normal end-of-session splitting.
