# RaceIQ Online desktop backend implementation plan

Status: design confirmed 2026-10-21; documentation only. No implementation, worker launch, commit or deployment is authorized by this plan. This revision replaces the earlier per-track-only upload selector, single-source snapshot takeover, profile opt-in and dated cloud-history proposals.

Contract: [shared release boundary and E2E scenarios](raceiq-online-contract.md).
UI: [separate implementation plan](raceiq-online-ui.md).
Cloud: [parallel backend implementation plan](../../../../../projects/raceiq%20cloud/docs/plans/raceiq-online-deployment-backend.md).
ADR: [accepted decision](../adr/0011-raceiq-live-service.md).
Language: [domain glossary](../../CONTEXT.md).

## Scope and authoritative definitions

Implement worker-owned durable uploads, immutable single-user original ownership, verified in-game stint attribution, local personal summaries and automatic account-wide lifetime contribution sync. All product semantics, DTO shapes, endpoint errors and acceptance IDs belong in the shared contract; this plan references them rather than inventing another definition.

Preserve working optional onboarding, offline capture/analysis, typed Hono RPC, account epochs/revision checks, OAuth/PKCE, OS-protected refresh tokens, default-off public recording/setup choices and community/website import provenance. Signing in does not authorize recording uploads. It does initiate aggregate sync after current-policy acceptance, without a new profile-sharing toggle. Local/Online scopes must be explicit.

Sources defining current dashboard semantics: `shared/racing/sessions/dashboard.ts`, `server/db/dashboard-queries.ts`, `server/db/dashboard-summary-queries.ts`, `client/src/components/home/HomePageContainer.tsx`. Reuse the existing time/favourite/count/period mechanisms. Personal attribution changes the input population; do not replace formulas with a new session timer or lap-count-first favourite ranking.

## Evidence baseline, not new acceptance

On 2026-10-21, desktop root typecheck passed with Turbo cache hits, an isolated runtime probe confirmed no recording producer means null upload context, and isolated real cloud HTTP/processor smoke passed using provider fixtures. Cloud release command failed version equality. These do not prove newly planned single-user ownership, driver-swap or lifetime behavior.

Current gaps: `apps/backend/src/integrations/online.ts` provides no recordingProducer; `apps/backend/src/runtime/boot.ts` starts the Effect coordinator in main. `packages/online` already contains durable Effect/SQLite/ledger/identity/privacy infrastructure worth preserving. Session schema has local integer IDs and capture/cloud provenance, but that is not a universal cross-device original-activity identity or native-driver ownership proof. LMU exposes driverName; other adapters need a source-specific evidence audit. Never equate a car slot, display name or legacy ownership='mine' with a verified personal stint.

## D0 — freeze technical seams and migration ownership

Desktop integration owner owns browser-safe DTOs, worker protocol, AppType and app/Online migration ordering; cloud owner owns OpenAPI/generated SDK. Implementers validate exact source coverage/identity and native driver evidence per game before format activation. No invented eligibility-proof endpoint or silent assumption that legacy copies are unique.

Preserve existing single-account command context, native binding descriptors, portable activity identity/coverage and same-ID correction receipts against the shared contract. Do not add local profile IDs, driver-selection generations or a profile picker. SDK baseline 0.1.13 remains pinned until compatible release is available. UI can use contract-conforming fixtures while real handlers are developed; never publish stub success handlers to unblock compilation.

## D1 — single-user installation and immutable account ownership

Owned scope: authoritative `server/db/{schema,migrations}*` and original-ownership queries; existing account routes and `packages/online` single-account lifecycle. One owner integrates shared state/schema changes.

1. Support one local user per installation. Remove unreleased multiple-profile tables/APIs, picker, selection generations, per-profile library isolation and multi-account credential machinery without deleting recordings or unrelated existing data. This is a clean single-user cutover, not a hidden multi-account implementation.
2. First verified Discord sign-in transactionally/idempotently claims existing unassigned owned records, never borrowed imports or previously claimed originals. Preserve immutable cloud owner metadata on records and queued work; a different account cannot inherit it.
3. Keep the existing single-account auth/keystore/consent/preference lifecycle. Sign-out clears credentials and stops remote starts without deleting local data, native bindings or offline recording capability.
4. Personal dashboard/contribution/upload eligibility still excludes borrowed/Other/Unknown activity. The local library remains available to this installation user; do not introduce profile-scoped library or query-selection machinery.
5. Preserve ownership and account/revision barriers across failed, cancelled or stale OAuth callbacks, including callbacks during capture. No account switching, deferred profile activation or account-replacement flow is required.
6. Keep the worker-safe app DB connection/bootstrap boundary: main initializes migrations/backfills once before spawning Online worker; worker does not become another app migration owner.

Acceptance: revised DR-01/02, UP-06, PF-01/04; shared E04/E09/E13/E14. Migration/restore preserves existing users and original ownership. Existing vehicle/tuning `profiles` are unrelated and must not be removed as local-account scaffolding.

## D2 — per-game in-game driver and stint attribution

Owned scope: `packages/game-{acc,ac-evo,f1-2025,iracing,lmu}` and native metadata contracts as required; shared source/frame/session attribution types; capture publication/export/import metadata; app DB stint/lap evidence; dashboard summary inputs. Coordinate source metadata changes with cloud parser owner; preserve native one-to-one semantics and pinned game/Effect APIs.

1. Audit native local-driver IDs, active driver changes, spectator/team signals, refresh/freshness and missing-source behavior per game. Document trustworthy mappings against actual recorded fixtures. Car index, currently signed-in Discord identity and matching names are not substitutes.
2. Use trustworthy native local-driver evidence or explicit per-game binding for this installation user. Persist binding revision/source descriptor; show confirmation requirement where source cannot establish Self. Stale/conflicting/missing evidence becomes Unknown, not guessed Self/Other.
   Implement the shared trusted-candidate confirmation boundary and preserve immutable captured binding snapshots. A structure-valid client actor is not evidence; resolve opaque candidates against actual current native source. Remote registered IDs/revisions are mapped separately from local captured revisions, without re-labelling native verification or invalidating history when today's session differs. E15 covers candidate expiry/source reset, explicit confirmation and historical binding preservation.
3. Publish immutable original ownership plus time-varying Self/Other/Unknown stint evidence and original-source ranges. A swap never changes the installation user or automatically credits another account.
4. Reconstruct swap boundaries on replay/reprocessing and persist them through supported source encodings. Gaps/uncertain boundaries remain Unknown. Binding changes invalidate unsent preparation and recompute affected eligibility safely.
5. A personal lap requires Self over its entire logical interval. Mixed/Unknown laps remain shared-session context; exclude them from personal completions, fastest-lap queries and uploads. Invalid but wholly Self laps follow existing dashboard rules, never valid-upload admission.
6. Attribute measurable time on the dashboard's existing clock/basis; keep separate session-type duration semantics. Split only where evidence supports it; no proportional allocation, name matching or wall-clock fallback. Own headlines exclude Other/Unknown, while detail shows separate contextual time/coverage.

Acceptance: DR-03/04, PF-01/02, UP-01/06; E07/E08/E15/E16. A game is not ready merely because its binary decoder runs: native attribution or explicitly confirmed identity and safe uncertainty handling must be proven. Do not silently drop required games; record named evidence gaps as release blockers.

## D2a — persistent global lap GUID and original provenance

Owned scope: app lap schema/migrations and capture identity/publication/export/import metadata; source-bound GUID reconciliation; `packages/online` DTOs/producer/reservation/submit; cloud importer. Same integration owner as D2 controls shared capture metadata; do not launch competing editors.

1. Give every lap a canonical persistent globally unique GUID, including invalid, mixed, Unknown, Forza and local-only laps. Mint new UUIDv7 once before durable publication; do not substitute local row ID, source filename, account ID or upload key.
2. Backfill existing laps with durable original-identity maps. Resolve downloaded source GUID from authoritative cloud provenance; ambiguous duplicate/derivative identity remains held, not a new personal GUID.
3. Preserve GUID through restart/reprocess/split/downsample and every supported artifact/export/import/download; map genuine re-segmentation explicitly. Existing imported content keeps author/borrowed ownership and cannot become an upload candidate.
4. Include original GUID in upload/reservation and lifetime contribution references; preserve server conflict/reconciliation semantics. Fresh GUID/request key must never be presented as a retry fix for rejected copied content.
5. Implement required GUID import manifest v3 in coordination with cloud schema/SDK migration; use committed metadata registration without re-detection. Verify original bytes/author/times survive metadata-only migration and repeated Open Replay reuse.
   Preserve the shared optional manifest-v3 provenance fields only when authoritative source metadata supplies them. Missing values remain unknown; neither one-lap metadata nor a cloud row ID establishes full original-activity coverage. E17/E18 exercise exact GUID/author/timing preservation without re-detection or personal reauthoring.

Acceptance: LP-01/02, DR-01/04, PF-03, UP-04; E10/E16/E17/E18. Cloud owns canonical native-content detection and owner indexes; app GUID/provenance checks are defense in depth, not sole enforcement.


## D3 — supervised Bun Online worker

Owned scope: `apps/backend/src/runtime/{boot,shutdown,startup-worker}*` integration/reference patterns, new Online entry/supervisor, `apps/backend/src/integrations/online.ts`, existing Online routes, `packages/online/src/{runtime,service,coordinator,sync-events}*` and compiled worker-entry configuration.

1. Move service/coordinators/profile preparation into one real worker, with typed RPC from main. Effect fibers on main are not worker execution. No duplicate service/consumer in host.
2. Main owns only HTTP callback ingress and platform-required OS browser/keystore operations; use private ephemeral messages. Recording/setup buffers never cross main; upload work reads source by IDs in worker.
3. Forward durable source/publication/reprocess/profile changes as coalesced wake hints. Recover missed events from persisted generations; respect capture-layout readiness and app migration ordering. Worker opens supported DB connections without importing main boot/telemetry singletons or becoming a second migration owner.
4. Worker installs restrictive account/consent/preferences barriers before acknowledgment; immediately invalidate stale host/UI generations. Yield during bounded preparation; check current driver, token, policy and operation-specific permission at actual SDK transport.
5. Supervise ready/unavailable/crash/stop lifecycle. Stop admission/new sends before shutdown, reconcile ambiguous sends and leave durable work recoverable. End old worker authority before replacement. Include worker entry in compiled Windows artifact.
   Replay import requests/state/activation use the shared access-context definition. Main ingress obtains current worker authorization; state reads/retries/acknowledgments and cached activation cannot reuse stale access. E18 validates exact GUID/selection, privacy changes during download/registration/navigation and acknowledged activation not being rearmed.

Acceptance: UP-03/04/06, DR-01/02; E03/E04/E05/E09/E13/E14. Cloud/profile operations share worker infrastructure, not public-recording permission.

## D4 — complete valid personal recording uploads

Owned scope: `server/db/online-upload-queries.ts`, `server/session-capture/source-loader.ts` consumer seam; `packages/online/src/{selection,identifiers,payload,upload-dispatch,adapter,coordinator,outbox-storage}*`; worker composition. Producer ownership stays with capture subsystem; no second session slicer.

Preserve existing F1 World car `41` recording/competition eligibility, as explicitly confirmed by the user; other F1 cars remain local/aggregate activity, not new public competition entries. E01/E02 cover accepted World recordings, non-World recording rejection and unaffected F1 aggregate sync.

1. Consume `resolveLapCaptureArtifact` only after durable publication; saved metadata alone is not readable recording readiness. Bind verified codecs for all five allowed games.
2. Select fastest valid wholly Self lap per game/track/car, not per track alone. Backfill, new save, owned import, reprocess and faster replacement share eligibility. Preserve provenance; borrowed/mixed/unknown laps are excluded.
3. Validate single intended logical lap, sparse context/boundaries, identity/times, game-driver binding revision and format/size against real cloud parser. Align local 128 MiB limit with the existing 500,000,000-byte service range using bounded worker I/O, or document an explicitly accepted limit change—never silently narrow support.
4. Implement actual F1 embedded-setup stripping, verify decoded output and unchanged originals. Attach only supported optional setup under current independent choice. Do not invent opaque attachment from a JSON snapshot.
5. Guard Forza at selection/admission and final reserve/transfer, including stale ledgers. Retire its intents without sending; Forza aggregate contributions remain allowed.
6. Preserve Effect generic delivery, immutable payload identity, reservation/key reconciliation, Retry-After and durable receipts. Re-check authenticated/original owner, current policy, binding and public/setup barriers before actual send. Changed payload gets new recording identity; ambiguous old send reconciles, not blind resend.
   Prepared source/binding snapshot fields are defined once in the shared contract. Validate immutable original owner and whole-lap portable provenance independently of full-activity aggregate coverage; no caller-supplied author field overrides bearer ownership. Producer and dispatcher consume the same required shape, without optional missing-producer success.
7. Read actual remote job validation/publication after acceptance and after restart. Turning public sharing off only blocks future recordings; do not automatically call unpublish. Existing explicit website account management remains outside desktop upload controls.

Acceptance: UP-01/02/04/06, DR-03/04; E01/E02/E05/E06/E15. Required formats stay blocked until proven, not quietly removed from release.

## D5 — dashboard-derived lifetime contributions and merge sync

Owned scope: dashboard DB/query/reducer inputs, new focused `server/driver-summary/` contribution modules following backend-core conventions, app/Online ledgers and activity identity metadata, `packages/online` worker/adapter/coordinator and local summary routes. Do not create a parallel dashboard aggregation system.

1. Reuse dashboard formulas/favourite eligibility/period views for this user's personal local data after stint attribution. Keep Unknown driver vs unclassified session time separate; expose Other/Unknown only as local context.
2. Introduce portable original activity identity preserved by capture manifests, split/downsample/export/import paths. Verify canonical source coverage; partial/overlapping copies cannot count or overwrite full source statistics. Keep ambiguous legacy contributions local/held with visible coverage.
3. Produce minimal per-original aggregate contributions, including favourite numerator inputs rather than only each device's favourite labels. No dated cloud activity, other-driver names/time, recordings or setups. Forza metrics are permitted.
4. Persist account ownership, source identity, immutable payload/content hash, cloud receipt and correction revision before delivery. Identity receipts survive local source cleanup so deleted/reimported data cannot count again. Local deletion changes local view only; no cloud negative/tombstone write.
5. Correct same original using exact-revision replacement, even if totals decrease. Reprocessing/import representation is not new identity. On conflicting device corrections fetch the same original; only deterministic resolution may advance revision. Unresolved conflicts stay held, never numeric-max or additive fallback.
6. Start profile sync automatically after verified account/current acceptance, including when recordings are private. No additional toggle/source claim/takeover. On policy change pause both pipelines until re-acceptance; on sign-out stop remote work while offline recording continues.
7. Use Effect durable delivery with distinct contribution job kind; coalesce unstarted superseded corrections without changing in-flight payload identity. Reconcile ambiguous commit via owner activity receipt; fetch real account-wide merged summary rather than label a device snapshot lifetime.
8. Retain original account ownership on all contributions/receipts/history. An original already owned by account A must not become B's contribution through imports or a different login; server enforces owner association without disclosing A to B.
9. Follow the shared reported-statistics/validated-recording ownership boundary: private and non-uploaded GUIDs do not require recording/proof registration; known foreign originals and uncertain conflicts stay held. Consume the SDK's executable typed hash protocol, including UTF-8 ordering and negative-zero normalization, rather than another JSON hash.
10. Handle owner legacy-only readback explicitly as unverified, never v2 zeros or additive lifetime data. Propagate later authoritative eligibility holds/corrections and retain distinct historical receipts. Canonical favourite labels come from existing game metadata, not client label inputs.
11. Own and extract the authoritative per-lap facts/reducer path from existing dashboard queries/materialized inputs; reuse it for dashboard, personal summary and per-original generation. Direct joins to actual lap attribution/GUID facts are authorized where old session aggregates cannot filter correctly. The shared local-only context groups Other/Mixed/Unknown whole-lap positive time, never proportional personal time or native session duration. A required SDK hash dependency/factory is permitted; no default or parallel hash algorithm.

Acceptance: PF-01–05, UP-03/04/06, DR-01/03/04; E07/E08/E09/E10/E13/E15/E16. Server availability gates live merge, not offline local dashboard.

## D6 — durable Upload read models and UI integration

Owned scope: `packages/online/src/{contracts,outbox-storage,service,adapter}*`, worker read models and local Hono/AppType routes. UI owns React/locale changes.

Implement paginated active queue and delivery history from actual queue/ledger outcomes; Effect cleanup must not erase business history. Show real retry/block/rejection/ambiguous states and remote receipt/validation/publication separately. Profile confirmation is not lap Last synced. Signed-out local history remains readable; remote data is cached/stale or unavailable, never fabricated zeros. Reject late account/revision responses after sign-out or restrictive changes.

Implement local profile versus merged Online all-time reads with pending/held/revision/coverage feedback. Expose Other/Unknown context safely. UI integrates typed real Hono handlers; no force upload/retry/cancel actions, production fixtures, `any` casts or raw external fetch.

Acceptance: UP-05, PF-05, DR-01/02; E04/E06/E07/E09/E10/E11/E13.

## D7 — Track Details Community entitlement and exact replay

Owned paths: Online service/adapter and typed leaderboard API; `apps/backend/src/routes/cloud-lap-import-routes.ts`; `server/session-capture/cloud-lap-import*`; `client/src/hooks/cloud-lap-import.tsx` interface with UI owner; original GUID/borrowed registration queries.

Current inspected wiring: LapManagement renders OnlineCommunityLaps; startCloudLapImport reaches the real controller and root activation opens game/session/lap replay. Leaderboard service checks sharing/consent; getImportAccessToken currently checks authentication only. No new runtime proof is inferred.

1. Use one backend entitlement for protected board and all app remote import/retry/deep-link/Community cached-reuse paths: authenticated account, current consent, confirmed effective public lap sharing, no privacy barrier. No minimum successful publication; aggregate sync alone does not qualify.
2. Recheck before availability/download, registration/reuse and activation and after async credentials/work; revoke rows/results on private/sign-out/policy changes. UI gating alone is insufficient. Already independent local replays remain usable offline.
3. Fetch real board by explicit game/track/car, preserve exact selected cloud ID/GUID/author, validate current import availability and register one committed lap atomically without detection/timing recomputation. Reuse prior import and navigate to exact actual replay, not a generic analysis page or different lap.
4. Scope import state/activation/ack and query keys to existing account epoch/preference revision; stale account or privacy intents cannot acknowledge/register newer work. Preserve website public browsing and unrelated legacy community integration.

Acceptance: CM-01/02, LP-01/02, DR-01, UP-06; E18 plus E04/E09/E12/E17. Integrator/UI owner must run real Track Details → times → Open Replay on desktop/mobile.


## Integration order and parallel ownership

| Phase | Work | Genuine prerequisite / exit |
| --- | --- | --- |
| P0 | Integrator freezes DTOs, identity/coverage construction and migration/worker seams; cloud owner confirms API source contracts. | No incompatible source/ownership assumptions; required fixture/evidence gaps explicitly named. |
| P1 | D1 single-user ownership cutover and D3 worker; cloud API/rejection/policy work; UI typed fixtures proceed independently. | One editor per state/schema/worker scope; real interfaces, no stubs. |
| P2 | D2 attribution and D5 activity identity/reducers proceed by owned files; D4 codecs/producer integrate their verified outputs; D6 read models/UI proceed against DTOs. | Shared metadata/service/coordinator edits have one integrator. No competing reducers, slicers or queue owners. |
| P3 | Integrate regenerated SDK, actual app routes/worker, cloud parser/merge and UI. | All five formats plus account/stint/source cases supported; no fake runtime fallback. |
| P4 | Execute shared E01–E19 and project gates, repair failures, then authorized release. | Passing mapped evidence, including GUID/copy rejection, actual Community replay, policy/legal alignment, hosted and compiled Windows worker. |

If implementation is later authorized, bounded workers must not delegate, stage/commit or run build/test/lint/format gates mid-flight. Integrator owns shared edits and final gates. This documentation approval creates no checkpoint or implementation dispatch.

## Verification and completion

The shared contract defines all [E01–E19](raceiq-online-contract.md#shared-e2e-strategy-and-scenario-ownership). Desktop owner executes actual capture/profile/worker/account/GUID paths; cloud owner supplies real HTTP/processor/merge/policy/provenance evidence; UI owner verifies actual settings/dashboard/library/Track Details replay. Integration owner records final cross-project results.

Extend existing Online package/backend route and child-process regression fixtures, actual app E2E, and Rust/Bun smoke harness. Deterministic captures must include native A→B→A swaps, same-name different drivers, no-self-at-start, gaps/stale bindings, mixed laps, independent devices/copies and legacy ambiguous coverage. Mocks may replace external provider locally only; never replace the application integration being validated.

Run root `bun run typecheck`, applicable game/capture/dashboard/Online/profile regressions, targeted browser desktop/mobile/accessibility/locale proof, migration/recovery smoke and compiled Windows worker run after implementation. Exact current policy enforcement and lifetime correction semantics require actual HTTP readback. Final hosted E12 includes current auth, five-game valid personal submissions, aggregate readback, Open lap round-trip, ingress boundaries and upgrade/restore/rollback.

Record build identities, commands, observed values, evidence paths and blockers. Planned/skipped/not-run is not passing. This revision changes documentation only; no new implementation or runtime test evidence is claimed. Update customer docs/changelog once implemented/proven; remove temporary verification scaffolding then.

Legal release dependency: source Terms/Privacy now contain best-effort accuracy/authenticity/tampering and moderation/removal limitations. Candidate versions/effective dates need operator review and aligned API/processor/client notices, including removal of continued-use-only wording. Preserve explicit re-acceptance before recording/profile sync and offline access; no GUID/validation/replay UI may imply certification. Acceptance LG-01 through E19 is a release dependency, not proof supplied by source edits.
