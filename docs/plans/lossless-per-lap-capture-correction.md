# Package-owned lossless per-lap capture correction

Status: implementation and behavioral acceptance verified; release remains blocked by the existing backend `TS2589` typed-route compiler failure. ADR remains proposed; implementation does not constitute formal acceptance.

ADR: [Package-owned indexed capture splitting](../adr/0011-package-owned-indexed-capture-splitting.md)

Progress: [Issue #463 implementation status](../../progress.md)

## Implementation status

The package owns exact encoded record-end handling, strict source decoding, indexed-window normalization, and generic preparation through injected opaque game codecs. It writes artifacts sequentially and verifies source consumption independently. Backend workers stage/verify; backend retains attempt/source fencing, transactional publication/invalidation, and source retention.

Imported parser bootstraps persist through pending and active recorder paths. ZIP exports mark initialization and trailing completion frames as non-owned context; cold F1/iRacing imports preserve telemetry and saved timing/validity without inferring ownership from labels. Compression protects split-job and published sources. Migration fences and requeues unpublished queued/failed jobs after releasing the maintenance lock, but protects active attempts and published provenance. Cleanup clears session/lap/job readiness together, restores references on pre-delete failure, and accounts for shared bundles and irreversible partial deletion.

Acceptance evidence: complete backend integration passed (2,767 tests passed, 4 skipped, 0 failed); capture-format/splitting, server, and client typechecks passed; package cancellation passed. Six-game plain/gzip smoke compares native bytes and consumer JSON. The cache-cold workload repeats one real persisted FM detector window 50 times (4,704 frames per window), verifies every artifact with the monolith unavailable, and compares sequential telemetry hashes. This is not an actual 50-lap race; OS caches were not cleared, logical file-size accounting is not physical I/O, and before/after memory deltas are not peak memory. Desktop/mobile screenshots, live WebSocket coalescing, reload, reconnect, and invalidation passed. Backend typecheck still emits `TS2589` without a source location; the earlier location was `apps/backend/src/routes/session-routes.ts:31`. Full evidence: `.omp/evidence/lossless-per-lap-captures/`.

## Goal

Correct issue #463 around a simple sequential algorithm in the existing `@raceiq/capture-splitting` package: consume a closed recording and detector index, write each lap, append the next lap's first frame as non-owned context, finalize, and start the next artifact with that same frame. Produce independently replayable artifacts without duplicating lap detection in the splitter.

The correction must address all review findings, not merely relocate code. Automatic publication currently exposes incomplete import, reprocessing, maintenance, and readiness behavior. Do not release the current implementation or retire source recordings before the correction passes acceptance.

## Ownership and contract

| Owner | Responsibility |
| --- | --- |
| `@raceiq/capture-formats` | Decode source storage; expose exact encoded record boundaries; reject truncated records; encode existing sparse/checkpoint/bootstrap formats. |
| `@raceiq/capture-splitting` | Validate and normalize detector windows, prepare initialization through injected game codecs, sequentially write lap/auxiliary artifacts, verify conservation, produce manifest/progress, and run staging workers. |
| Game-owned parser packages | Create/reset parser state and capture/restore versioned opaque checkpoints. No lap ownership policy in parser checkpoints. |
| Backend | Supply source and persisted detector index, bind game codecs, queue/recover attempts, publish DB references transactionally, invalidate stale publication, coordinate maintenance, and send notifications. |
| Client | Render authoritative status and readiness; refresh the affected query caches. |

Reuse `packages/capture-splitting/`; do not create another splitter package. The package must not import server, backend, client, DB, game registries, or concrete game parsers. Host binding supplies codecs; generic preparation logic belongs in the package, not `apps/backend/src/session-capture/split-windows.ts`.

Keep the existing split request/manifest contracts where their meaning remains correct. Change contracts only for required boundary, initialization, progress, or error information; update every caller. Preserve historical published manifest reads. Any incompatible persisted manifest change needs an explicit version/migration decision, not silent reinterpretation.

## Invariants

- Split only closed recordings. Never rotate live recording files per lap.
- Ownership comes exclusively from detector `rawByteOffset` and `rawFrameCount`. `lapNumber` is a label, never a boundary inference.
- Preserve every reconstructed native source-frame byte, original order, timestamps, and timestamp absence. Sparse storage bytes may change when creating independent checkpoints; this is not permission to change native payloads.
- A next-lap boundary frame is owned once, by the next lap. The previous lap can contain one duplicate as non-owned trailing context.
- Normalize an existing one-frame detector overlap inside the package. Reject larger overlaps and unaligned starts. Do not rewrite the persisted detector index merely to match artifact-local offsets.
- Do not append arbitrary following frames across auxiliary gaps. Non-boundary delayed-finish context remains controlled by game `appendsDelayedFinishFrame` metadata.
- Preserve source records outside lap windows in auxiliary artifacts, including segment/context markers. Preserve bootstrap semantics and reset parser/storage state at the existing boundaries.
- Each lap starts with an independently decodable storage checkpoint and, when required, the parser state immediately before its first owned frame.
- Verification distinguishes owned records from synthesized initialization and duplicated context. All original records must be accounted for exactly once in ownership; incomplete source records must fail.
- Worker stages and verifies only. Backend publishes references and owns source retirement. Failure cannot expose a partial bundle.
- Retain monolithic sources throughout this correction. Historical null-layout fallback remains; invalid non-null published layouts fail explicitly.

## Sequential algorithm

1. Validate the ordered detector index. Read source records sequentially with physical decompressed source start/end offsets and decoded native payloads.
2. At a lap start, reset output storage encoding, write required parser bootstrap, and write its first frame as an independent checkpoint. Track source offsets separately from artifact-local offsets.
3. Write the indexed owned frames. Use the next indexed start to normalize a shared completion frame without assigning it to both laps.
4. When the next record is the next indexed lap's first frame, write it as the current lap's trailing context, finalize that artifact, then write the same frame as the next lap's first owned checkpoint. Auxiliary-gap and final-lap context follow the explicit metadata policy above.
5. Finalize remaining auxiliary records and manifest. Verify source conservation and independent replay before returning a publishable result.

This is one sequential writing pass, not a promise of one total source read. Existing stateful formats may require a package-owned preparation pass to obtain opaque parser checkpoints through injected codecs; independent verification also rereads input/output. Backend should only call preparation and worker APIs, not implement their scanning loops. Do not add per-frame cross-thread RPC, transfer parser functions to workers, load backend registries in workers, or invent a new checkpoint sidecar to force a single total pass.

## Phase 1 — Package algorithm and format correctness

Targets: `packages/capture-formats/src/session/framing.ts`, `packages/capture-splitting/src/{index,contract,client,protocol,worker}.ts`, and `apps/backend/src/session-capture/split-{windows,runner}.ts`.

- Add exact encoded record-end information to framing; migrate affected consumers. Never derive source boundaries from decoded payload length. Keep decompressed source offsets distinct from compressed physical file size.
- Make strict decoding reject missing payload, timestamp, and metadata bytes after any consumed prefix. Permit clean EOF only before a new record begins; preserve intentional zero-length fields according to format rules.
- Move generic window normalization and checkpoint preparation into the package with a minimal injected codec/source contract. Remove obsolete application-owned algorithms; retain only game binding and invocation.
- Implement the sequential ownership/context loop above; reuse existing encoders and parser checkpoint formats.
- Verify complete source consumption independently of record equality so a shared decoder cannot silently approve an omitted truncated tail.
- Preserve worker failure codes and classify unknown/protocol errors explicitly. Report scan/write/verification phases truthfully, with frame and artifact counters whose meanings do not change between layers.

Acceptance: plain/gzip adjacent sparse laps and lap-to-auxiliary boundaries succeed; storage-full and storage-delta lap starts replay identically; exact boundary duplication/ownership is demonstrated; every truncation position fails before publication; malformed capture is not reported as bootstrap failure; independent Bun package invocation works without backend startup/imports. Include segment resets, empty auxiliary ranges, final lap, cancellation, and delayed-finish metadata boundaries. Existing package and focused backend behavioral tests pass.

## Phase 2 — Publication, reprocessing, and durable consumers

Targets: split manager, session queries, lap reprocessing/read/replay storage, import pipeline/live recorder, source loader, archive export, and recorded replay.

- Preserve verified staging -> rename -> fenced DB transaction publication. Reject changed source, game, ownership windows, or attempt before publishing references. Keep transaction failures and interrupted artifacts recoverable.
- When reprocessing changes ownership or source identity, atomically clear the session publication and affected chunk references before readers can observe new metadata with old artifacts. Requeue from retained source. Preserve user-owned lap fields and matched IDs; unchanged ownership need not invalidate a valid bundle.
- Persist imported parser bootstraps through both pending-recorder and active-recorder paths before dependent frames. Preserve multiple segments/checkpoints and replay after cache eviction/restart.
- Fix iRacing archive context generation to restore the bootstrap before decoding native deltas and preserve complete-lap-start/delayed-finish semantics. Route canonical bootstrap-only recordings to framed replay rather than native dump decoding.
- Keep direct lap replay/export/semantic provenance tied to the selected artifact. Keep legacy fallback only for null layout; clear affected caches when publication/invalidation changes their source.

Acceptance: changed-window reprocessing serves corrected frames rather than the old manifest; new replacement laps remain replayable; unchanged-window replacement remains valid; real checkpoint-dependent F1/iRacing ZIP import persists initialization and cold-replays equivalent telemetry; direct recorded replay recognizes ordinary splitter artifacts. Interrupt before/after rename, fail publication, restart, exhaust retry policy, and deliver stale events: no partial or stale bundle becomes visible.

## Phase 3 — Maintenance and representation accounting

Targets: compression, cleanup/retention, session/lap deletion, capture migration/import, hashing/provenance, and capture availability queries.

- Derive orphan protection from all live session/job/artifact references, independently of compression eligibility. Queued sources must not be compressed as orphans or deleted.
- Make source rewrites invalidate/requeue unpublished jobs safely. Define published monolith compression/migration behavior without silently invalidating artifact provenance or removing required fallback inputs.
- Include nested bundle files in cleanup/deletion accounting. Capture cleanup removes all representations intended by that operation and clears references atomically; full deletion removes unreferenced bundles while respecting shared source references and active attempts.
- Audit import and hashing/provenance callers for monolith-only assumptions. Keep intentional session-wide source hashing separate from artifact hashing; do not change identity semantics incidentally.
- Make telemetry availability and readiness agree with the remaining representation after cleanup or deletion. Do not report cleaned telemetry while bundles remain readable.

Acceptance: queued source -> manual/background compression retains valid paths; published session -> capture cleanup cannot still export retained chunks; session deletion leaves no owned bundle orphan; shared monoliths survive until their final reference is removed; maintenance cannot race publication/reprocessing into missing references. Legacy captures still read correctly.

## Phase 4 — Truthful progress and export readiness

Targets: split manager/session queries/WebSocket manager, `useWebSocket`, session queries, and existing session UI components/locales.

- Send committed queued/active/ready/failed status snapshots, including attempt and sequence. Forward meaningful processed/total source-frame counters where known; render indeterminate progress honestly otherwise.
- Coalesce progress notifications and refreshes; terminal status is not dropped. Refresh both session status and lap readiness queries on publication/invalidation and reconnect.
- Keep export readiness consistent with backend behavior and legacy support. Do not leave usable historical exports permanently blocked by an absent split job.
- Preserve existing localized UI, native progress accessibility, and actionable failure messages; update every supported locale as needed.

Acceptance: actual desktop/mobile surface shows transitions, error, publication-ready export, reload, disconnect/reconnect, and reprocessing invalidation. Screen-reader announcements and disabled-control explanations remain accessible. No stale readiness cache after a ready event.

## Phase 5 — End-to-end acceptance and release documentation

- Exercise real split -> independent lap replay for all six games, including stateful parser checkpoints, sparse boundaries, timestamps/absence, segment resets, and delayed finish. Compare frames and consumer-visible telemetry, not just imported lap counts.
- Run cache-cold 50-lap reads with the monolith unavailable; observe bounded artifact reads and no session-wide replay. Record latency/memory without inventing a performance threshold; compare matched baseline and investigate regression beyond measurement noise.
- Run changed-path runtime smokes and focused regressions, then applicable package/client/backend checks and backend integration suite after relevant inputs stabilize.
- Root/backend typecheck has an existing `TS2589` blocker at `apps/backend/src/routes/session-routes.ts:31`. Do not rerun merely to reconfirm it or count it as passed. Resolve the underlying typed-route issue during final integration, or report it explicitly as a release blocker.
- Update architecture documentation, customer changelog, and `progress.md` once the behavior is verified. Distinguish record-conservation, independent replay, durable import, UI, and performance evidence.

Release acceptance requires every phase above. Source retirement remains out of scope for this correction; storage-space savings must not be claimed while monoliths remain retained. No new cloud/upload format, live lap rotation, replacement detector, generic parser framework, compatibility shim, or unrelated redesign is included.
