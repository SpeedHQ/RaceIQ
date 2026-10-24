# LMU opponent cold-load contract

Status: planning only. Finalization-only indexing follows the user's explicit requirement. The boundary below is the proposed implementation baseline; no implementation or performance acceptance is claimed.

Plans: [Backend](lmu-opponent-cold-load-backend-plan.md), [UI](lmu-opponent-cold-load-ui-plan.md). Backend integration owner owns this contract, shared DTO changes, publication identity, and final integrated verification. Both implementers must use this boundary; changes require updating all three documents before dependent work proceeds.

## Goal and constraints

Make the first opponent catalog/comparison/replay request after a backend restart use persisted metadata and selected observation blocks, not a session scan. Build artifacts only after recording/import finalization. Do not add indexing, opponent extraction, hashing, or derived-artifact writes to the live recording loop. A background worker must also defer while any recording is active or draining, including a new recording started during a build.

Preserve every recorded sample, capture key, timestamp, state, freshness, provenance, supported channel, identity incarnation, and existing lap boundary/coverage rule. Native primary/companion captures remain authoritative for byte-exact export. No recording rate changes, downsampling, synthetic values, longer-cache workaround, or first-click scan fallback.

### Existing authorities

- [Opponent DTOs](../../packages/lap-replay/contracts/opponents.ts): catalog, references, summaries, comparison requests, replay responses, and errors.
- [Opponent routes](../../packages/lap-replay/server/opponent-routes.ts): game checks, sorting, alignment, limits, and error behavior.
- [Opponent indexing](../../server/lap-analysis/lmu-opponent-laps.ts): observed distance wraps, session/vehicle/incarnation identity, gaps, partial intervals, and native export reads.
- [Source loader](../../server/session-capture/source-loader.ts) and [direct recorder](../../server/session-capture/direct-recorder.ts): source ownership and publication.
- [Recording maintenance](../contributing/scheduled-recording-maintenance.md): runtime ownership, storage admission, locking, write permits, worker lifecycle, and shutdown ordering. Effect fibers alone do not isolate CPU work.
- [Full-cadence replay contract](lmu-full-cadence-replay-contract.md): lossless representation and real-browser measurement conventions.

### Investigation evidence

The inspected recording has 30,957 frames and 16,629,358,313 source-wire bytes. Current opponent requests rebuild the session; own-lap reads select an artifact. A successful read-only 2,000-frame probe reconstructed 1,758,504,003 bytes in 2,437 ms: 539 ms inside the source decoder and 1,898 ms elsewhere in iteration/reconstruction. Companion integrity validation took 434 ms. Resolving/parsing own lap 32 produced 7,753 frames in 856 ms. These are fresh-process probes with uncontrolled OS cache, not full browser timings. The full profiling attempt timed out and produced no usable result. Existing approximately 29-second cold opponent loading is user-reported baseline.

## Shared integration boundary

Retain host authentication and required `X-Game-Id: lmu`. Preserve player-lap ownership/game checks and opaque opponent IDs/revisions. No new public operation, pagination, or production mock fallback.

### Catalog

`GET /api/laps/:id/opponent-laps` retains existing `OpponentLapCatalog` fields and adds required:

```ts
indexState: "waiting-finalization" | "queued" | "building" | "ready" | "failed" | "not-required";
```

All existing field types/nullability remain authoritative in `opponents.ts`. `indexState` is non-null. `sourceRevision` remains the native source revision, not a derived format version. `opponentAvailability` describes native source integrity, not index readiness.

- `waiting-finalization`: recording/import is not sealed; no build admitted.
- `queued`: sealed eligible source awaits idle admission, or a build yielded because recording resumed.
- `building`: admitted worker is preparing unpublished output.
- `ready`: complete validated publication matches current source identity and index version. Serve persisted summaries; do not decode native or player telemetry for the catalog. Persist player-lap comparable-channel facts during preparation so summaries retain existing semantics.
- `failed`: preparation failed; no stale publication is served.
- `not-required`: native retention is removed/not-recorded, or native data is missing/corrupt. Existing retention/availability values explain why.

All non-ready states return empty `sessions` and `laps`. A ready catalog with no observed opponents is valid and distinct from preparation. Preserve existing lap sorting/grouping. Catalog reads do not queue jobs, scan native data, or synchronously repair preparation.

Representative response, with other fields unchanged:

```json
{
  "playerLapId": 32,
  "sourceRevision": "native-source-revision",
  "opponentRetention": "retained",
  "opponentAvailability": "complete",
  "indexState": "building",
  "sessions": [],
  "laps": []
}
```

### Comparison and replay

Retain existing operations and payload definitions:

- `POST /api/laps/:id/opponent-comparison`: `opponentLapId: string`, `sourceRevision: string`, and `step: 1`, or `step: 0.1` with required finite numeric `start`/`end`. Existing range and 50,000-sample constraints remain unchanged.
- `GET /api/laps/:id/opponent-laps/:opponentLapId/semantic-telemetry?sourceRevision=...`: required opaque string revision; existing semantic replay response shape remains unchanged.

Load only blocks intersecting the requested opponent interval plus required boundary/context blocks. Player data uses the existing selected-lap artifact resolver. Existing comparison/replay DTOs, fidelity, and ordering remain unchanged; reuse an existing lossless wire codec internally where applicable without changing the HTTP representation in this work.

Extend `OpponentDataErrorCode` with `OPPONENT_INDEX_NOT_READY` and `OPPONENT_INDEX_FAILED`. Existing error body remains `{ code: string, error: string }` with non-null strings. Pending states return HTTP 409 / `OPPONENT_INDEX_NOT_READY`; failed preparation returns HTTP 422 / `OPPONENT_INDEX_FAILED`. Preserve existing invalid-request, wrong-game/missing-lap, stale-revision (409), removed-data (410), unavailable-data (422), missing-opponent (404), and storage-error semantics. Check source revision/removal/unavailability before index readiness so preparation does not mask existing errors. Never perform request-time backfill.

### UI behavior

For waiting-finalization, show that comparison becomes available after recording ends; do not poll during active recording. For queued/building, show preparation and poll the catalog every two seconds only while its surface is mounted and visible. Stop polling on ready, failed, not-required, or navigation. Recording lifecycle completion invalidates the waiting catalog through existing lifecycle/query facilities. Failed preparation shows an explicit error and refresh affordance; refresh reads status only, not a job-start API. No fake percentage, empty-catalog message during preparation, stale trace, or fabricated telemetry. Readiness errors invalidate the catalog; revision changes clear incompatible selection.

### Session and lap opening gates

Queued work also blocks opening. Apply this gate to session expansion/detail navigation and lap detail/replay/comparison entry points, not filesystem opening. Keep rows visible so users can see readiness.

Extend `SessionMeta` and `LapMeta` in `shared/racing/sessions/types.ts` with required, non-null `processing` metadata in existing session/lap list responses:

```ts
processing: {
  state: "queued" | "processing" | "ready" | "failed";
  stage: "capture" | "opponent-index" | null;
  error: string | null;
};
```

`queued`/`processing` require a non-null stage and null error; `ready` has null stage/error; `failed` has a non-null stage and user-safe non-empty error. This projects authoritative capture/publication and opponent-index state, not a second job system. Existing authentication, game filtering, pagination, and ordering on metadata routes remain unchanged. Metadata/status requests remain accessible while opening is blocked; no native scan or per-row catalog fetch is needed to produce these fields.

An affected session is blocked while its required capture preparation or opponent index is queued/building, including shared-source work across session generations. An affected lap inherits relevant shared-source work and its own capture preparation; one unrelated lap's independent work must not disable every lap or another session. Map index queued/building to queued/processing with stage opponent-index. Native retention not-required does not alone imply failed processing: preserve existing player-only access where native player data is usable. Do not redefine active live-recording access; this gate covers queued/running post-recording, import, seed, and rebuild preparation. An unresolved readiness fetch temporarily blocks opening with a loading state rather than assuming ready.

Queued rows show a spinner and “Queued for processing…”; running rows show a spinner and “Processing…”. Disable mouse, keyboard, row expansion/navigation, context-menu open actions, replay, and comparison links for the affected session/lap. Expose `aria-busy` and disabled semantics with visible status text. Preserve unrelated actions and unaffected ready rows. Failed rows stop spinning, show the error and existing applicable recovery/status-refresh action, and remain blocked until readiness is restored.

Guard direct/bookmarked session and lap routes before loading heavy content. Show the same queued/processing status shell rather than rendering stale or incomplete details; metadata/status access is still allowed. Recheck readiness at heavy backend reads so a stale UI cannot bypass the gate: pending work returns HTTP 409 with `{ "code": "RECORDING_PROCESSING", "error": "Recording is queued or processing" }`; failed required preparation returns HTTP 422 with code `RECORDING_PROCESSING_FAILED` and a user-safe error string. Preserve existing authentication, missing-resource, source-revision, native-removal/unavailability, and opponent-specific error precedence; opponent endpoints retain their more specific index codes. No new processing-start endpoint.

Use existing lifecycle invalidation/status-query infrastructure to update list and direct-route shells. Poll only visible pending statuses every two seconds, stop on terminal state/navigation, and do not create one timer/request per row. When queued work is deferred by a new recording, retain queued indication without indexing work during recording. Ready transitions remove spinners and restore opening without a page reload; no automatic navigation that steals focus.

## Durable storage and lifecycle decisions

The backend owner defines the private on-disk schema before storage implementation. Required contents: schema/index algorithm version; native revision and identity of every source dependency; catalog summaries and per-player comparable-channel facts; ordered block descriptors with length/digest/range; exact interval locators and boundary context. Use bounded independently readable observation blocks shared across overlapping opponent intervals. Do not duplicate the entire grid per opponent lap or retain native export buffers. Never JSON-round-trip bigint timestamps lossily.

1. Queue only after source files close and final manifest/reference publication commits. Finalization enqueues without awaiting the scan. Deduplicate by physical recording publication, since several session generations may share one source.
2. Execute CPU work in a managed worker, at most one build at a time, under existing storage/maintenance coordination. Stream input and block output with bounded state rather than accumulating all decoded frames. Defer admission while any recording is active/draining; on recording start, yield between bounded blocks and do not resume until idle. Measure the bounded in-flight work and ensure it cannot extend recorder startup.
3. Validate native integrity during preparation. Publish staged output atomically only after rechecking source identity and completing validation. No partial ready catalog. Keep decoding/file I/O outside database write permits.
4. On reads, validate metadata and dependency identities, and verify selected derived blocks. Unchanged validated source does not need a whole-companion hash on each process restart. Changed/replaced/missing dependencies revoke readiness and require background validation; never trust revision string alone. Preserve existing corruption/missing/repair behavior.
5. Recover interrupted preparation on startup through source discovery, not HTTP. Rebuild incompatible or missing derived formats after finalization; corrupt/incomplete staging is never authoritative. Existing unindexed recordings and finalized imports use the same idle backfill path. Launch-time lap seeding explicitly invokes this same preparation path after seeded captures and final source layout are committed. Seeding must await eligible seeded opponent publications before reporting opponent preparation complete or exiting its process; it must not leave an in-memory job behind for a process that is about to stop. If recording becomes active, defer indexing and expose pending readiness rather than blocking recorder startup or claiming seed opponent readiness. Repeat launches reuse matching valid publications; the existing “seed data already exists” early return must still reconcile missing, interrupted, or incompatible opponent indexes without reimporting laps. Preparation delay is visible and excluded from ready-load targets only when separately reported.
6. Coordinate removal, deletion, relocation, source rewrite/downsampling, and shutdown with existing ownership/locks. Opponent removal revokes and deletes derived opponent data as well as native companion data. Removal must not race with a worker publishing it again. Partial player-lap deletion retains shared blocks still referenced. Derived blocks are rebuildable; they never replace source bytes for native export.

## Observable acceptance criteria

- **OP1 — Cold catalog:** On the investigated recording, after successful publication and backend restart, catalog route plus response consumption completes within 200 ms, scans zero native frames, decodes zero player telemetry packets, and returns unchanged ordered catalog semantics.
- **OP2 — Selected loading:** Real UI comparison and opponent replay become ready within two seconds each on the same recording/selection after backend restart. Record comparison data readiness and playable replay readiness separately, including fetch/decode/preparation/render. No unrelated observation blocks or full native session scans. Compare matched own-lap timing in the same environment; report regressions, not just threshold success.
- **OP3 — Fidelity:** Existing identities, interval IDs, boundaries, coverage, timing deltas, channels, samples, exact timestamps, provenance, states, and byte-exact native exports/imports remain unchanged. Player replay and non-LMU behavior remain unchanged.
- **OP4 — Lifecycle/integrity:** Pending, changed, removed, missing, corrupt, failed, interrupted, relocated, and version-incompatible artifacts never appear ready incorrectly or expose stale data. Repair/backfill eventually produces a valid publication when eligible.
- **OP5 — No recording strain from indexing:** No indexing/derived writes during recording or draining. Finalization queues only after seal/commit. At most one bounded worker runs while idle; starting recording suspends further indexing work without blocking recorder startup. Record CPU/RSS, queue behavior, and any in-flight overlap rather than claiming literally zero OS activity.
- **OP6 — Real readiness UX:** All contracted states/errors appear correctly in picker/comparison/replay; polling stops as specified and readiness transitions reach actual selectable/playable data without reload or fake fallback.
- **OP7 — Launch seed preparation:** Fresh launch seeding produces persisted opponent catalog and observation blocks after seeded source finalization/layout publication, without requiring an HTTP request. Seed completion waits for eligible preparation; a repeated launch reuses valid publications and repairs missing/interrupted/incompatible indexes even when lap rows already exist. Native source/lap rows remain idempotent. Active recording defers preparation without a false ready state. Record seeding/indexing duration separately from restarted ready-load timings.
- **OP8 — Session opening gate:** A session queued for or undergoing required preparation stays visible but cannot expand/open through mouse, keyboard, context menu, or direct link. Spinner plus accurate queued/processing text persists until readiness; failure stops spinner and shows error. Ready transitions restore access; unrelated sessions remain usable.
- **OP9 — Lap opening gate:** A lap queued for or undergoing its own or relevant shared-source preparation stays visible but cannot open detail/replay/comparison through any entry point. Spinner, failure, direct-link protection, readiness restoration, and unaffected-row behavior match the shared gate contract. Metadata reads remain lightweight and heavy reads reject stale-client bypass.

## Shared E2E scenarios and execution owner

Backend integration owner executes all scenarios after integration and records commands, outcomes, source identities, timings, bytes/blocks read, peak memory, and evidence links. Extend existing `packages/game-lmu/test/e2e/backend/integration/opponent-routes.test.ts`, `lap-analysis/lmu-export-import-roundtrip.test.ts`, recorder safety/removal suites, and browser scenarios under `packages/game-lmu/test/e2e/browser/compare/`. Use real import/finalization, files, persistence, routes, production UI, and controlled fixtures. Barriers/test clocks may control scheduling; mocks must not replace these integrations.

| Scenario | Setup and action | Observable result / criteria |
| --- | --- | --- |
| E1 Finalization and recording priority | Capture controlled LMU input through production ingress; request catalog before seal; finalize; start another recording during a gated build; stop it | No pre-seal indexing; finalization returns without scan; build defers/yields; recorder starts without waiting for build; idle publication becomes ready. OP4, OP5, OP6 |
| E2 Cold ready requests | Prepare real 30,957-frame recording; restart backend separately for catalog, comparison, and replay; open actual browser surfaces | OP1/OP2 budgets pass; zero native scan/player decode for catalog; only selected blocks/context read; correct scene/instruments and comparison deltas. Record application-cold versus OS-cache scope and matched own-lap timing. OP1, OP2, OP3, OP6 |
| E3 Fidelity and boundaries | Finalize deterministic recordings containing wraps, partial start/end, sequence gaps, repeated observations, large bigint times, stale/missing/error values, reordered/reused/duplicate identities, no-player frames, and generation transitions; compare indexed route output with authoritative existing behavior | Exact observations/summary/delta equality; no invented complete laps or samples; no cross-identity leakage; native export/import bytes conserved; player/non-LMU routes unchanged. OP3 |
| E4 Integrity and source races | After publication, corrupt/replace/truncate/remove native dependencies or derived blocks; request routes; restore files; change source while builder is paused before commit | No stale success; existing native corruption/missing states preserved; selected block corruption rejects; stale build cannot commit; background repair produces correct ready data. OP3, OP4, OP6 |
| E5 Interruption and historical backfill | Use finalized unindexed/imported source; kill backend during staging and around publication; restart; repeat with unsupported derived version and failed disk write | HTTP never scans/builds; explicit preparation/failure states; old valid publication preserved only for matching identity; staging never ready; restart safely discovers/rebuilds eligible work once per source. OP4, OP5, OP6 |
| E6 Ownership and retention | Remove opponents or delete/relocate/rewrite source while build/read is gated; delete one player lap sharing recording; shut down with worker active | Removal cannot republish retained opponent data; shared referenced blocks survive partial deletion; relocation/rewrite invalidates or safely republishes locators; shutdown drains owned work and releases locks. OP3, OP4, OP5 |
| E7 UI state transitions | Drive waiting, queued, building, ready-empty, ready-populated, failed, removed, and source-changed states through real backend; navigate away and back | Accurate messages, disabled unavailable actions, two-second visible pending polling only, no polling after exit/terminal state, stale selection cleared, real selection and playback work after readiness. OP4, OP6 |
| E8 Launch-time lap seeding | Run the actual launch/seed entry point in an isolated data directory with a controlled LMU opponent recording; await seed preparation and restart backend; repeat launch unchanged, then with a deleted/interrupted/incompatible index; gate preparation and begin recording | Fresh seed persists ready catalog/blocks before eligible preparation completes; first real browser selection works without native request-time scans; repeat seed does not reimport laps or rebuild valid publication; missing/incompatible index repairs despite existing-seed early return; interruption cannot lose queued work on seed-process exit; recording defers indexing without false ready status. OP1, OP2, OP3, OP4, OP5, OP6, OP7 |
| E9 Queued and processing opening gates | In the existing real sessions-page/browser harness, gate seed/finalization/rebuild admission to hold a session and a lap queued, then running; keep another source ready; attempt mouse/keyboard/context-menu opening and bookmarked detail/replay/comparison routes; fail preparation, recover, and navigate away while pending | Both queued/running states display row and route-shell spinners with correct labels; opening/heavy reads are blocked with contracted semantics; no heavy load starts from disabled actions; failure stops spinner and exposes error; readiness enables opening without reload; unrelated rows work; polling stops after exit/terminal state, including a job deferred by recording. OP4, OP5, OP6, OP7, OP8, OP9 |

Run deterministic E1/E3–E9 in isolated temporary data directories with controlled dependencies and bounded input. Run E2 alone on the same real recording, without builds/other benchmarks. Unit/codec tests and compiler gates supplement these scenarios. All criteria and mapped edge paths require passing executed E2E evidence before implementation completion; unavailable environments or missed targets remain explicit blockers, not passes.
