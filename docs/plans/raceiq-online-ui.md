# RaceIQ Online UI implementation plan

Status: local implementation/acceptance work in progress, 2026-10-22, following user authorization. One local user per installation remains the confirmed design. Multiple local accounts/profiles and switching remain out of scope. Settings now uses the established modal primitive with labelled semantics, focus containment and dismissal. Selected real-browser evidence exists; full UI/release acceptance remains open. No deployment or desktop control is authorized.

Shared contract: [authoritative DTOs, rules and E2E](raceiq-online-contract.md).
Desktop backend: [worker, attribution and local ownership](raceiq-live-service.md).
Cloud backend: [parallel service/API work](../../../../../projects/raceiq%20cloud/docs/plans/raceiq-online-deployment-backend.md).
ADR: [accepted decision](../adr/0011-raceiq-live-service.md).
Remaining acceptance: [R01–R22 and V01–V22](raceiq-online-remaining-plan.md).
Completion ADR: [accepted evidence-gated release closure decision](../adr/0016-raceiq-online-release-acceptance.md).
Language: [domain glossary](../../CONTEXT.md).

Current U1 evidence: the actual seeded app exposes Settings as a labelled `aria-modal` dialog, contains forward/backward keyboard navigation after focus settles, dismisses through Escape/backdrop and restores trigger focus. Desktop 1280×900 and mobile 390×844 have no document/dialog horizontal overflow. Upload History retains its accepted receipt while remote validation/publication are explicitly unavailable. See [behavioral scope and screenshots](../../.omp/evidence/online-remaining/settings-modal-verification.json). This English unavailable/history case does not close the complete R15/R16 pagination, locale, announcement or state matrix.

## Scope and ownership

UI owns existing app profile/account controls, settings navigation and `Settings.tsx`, `packages/online/ui/settings/OnlineSection.tsx` and Upload components, dashboard/home/library/detail/compare attribution presentation, onboarding components, `packages/online/ui/hooks/raceiq-online.ts`, `packages/online/ui/lib/raceiq-online.ts`, query keys and every supported locale catalog. Inspect incumbent routing/components before editing; reuse existing shadcn/Paraglide/React Query/Hono RPC patterns. No broad redesign, second account app, raw external SDK/fetch or UI-side recording aggregation.

Backend owns shared exports, AppType, immutable original ownership, native identity/bindings, dashboard calculations, durable queue, GUID/provenance verification and cloud enforcement. Cloud owns OpenAPI/SDK/public-profile contracts. UI fixtures can proceed independently after DTO agreement; actual worker/API integration is a final dependency, not something fixtures certify.

## UI1 — existing single-account auth and per-game identity

1. Retain existing account/settings composition and single-account sign-in. Do not add a local profile picker, add-account/account-switch controls, per-profile libraries or an account-replacement flow.
2. Local recording/analysis/history works offline, after refresh-token expiry and after explicit sign-out; remote controls show signed-out/unavailable/consent-required truthfully. Sign-out does not change original ownership or clear local activity.
3. First Discord sign-in explains that existing unassigned personal records bind to that account, excluding borrowed/previously owned records. Render actual backend claim/auth errors without implying that another login moves historical ownership.
4. Surface per-game native identity/binding confirmation when required. Separate game identity from Discord name and car/slot identity. Show source evidence/binding revision in bounded driver-facing terms; a matching name alone is not verification. Binding failures/changes invalidate stale Online commands.
   Consume the shared opaque observed-driver candidate API for explicit confirmation; no raw native-ID editor or caller-created actor descriptor. Expired/changed/unavailable candidates remain unavailable, not a guessed binding. E15 includes a candidate changing before confirmation and known-AI/Other candidate rejection; offline local confirmation remains available.
5. When game drivers swap, the installation user does not change. Shared-session detail shows Self, Other and Unknown attribution separately; another game's driver is not a second local account.

Acceptance: revised DR-01–04 and visible UP-06/PF-01; E07/E08/E11/E13/E14/E15. Test no-self-at-start, same-name/different native identities, unknown evidence, offline/signed-out use and stale auth callbacks through actual app.

## UI2 — Settings → Upload

Required destination is **Settings → Upload** using established app settings navigation/link-state conventions. Direct opening/reloading selects Upload by the incumbent mechanism; do not introduce a parallel router. Move queue/status/history out of General; one destination, not duplicated panels. Keep connection/public/setup controls in incumbent account settings and link to them from relevant blocks.

1. Show this installation's activity text, actual queue counts, latest error/block, worker/service availability and Last synced for confirmed lap receipt. Profile contribution confirmation has a separate time/revision.
2. Render paged active queue and terminal history from actual worker/ledger Hono routes. Lap rows identify game/track/car and status; profile rows are labelled statistics sync, not recording transfer. Lap detail shows persistent original lap GUID, not merely local numeric row ID.
3. Distinguish queued/preparing/uploading/retry-wait/blocked/ambiguous/accepted/rejected/withdrawn/superseded. Show real retry-at time and sanitized guidance; acceptance is not validation or publication. Readback can show a later server rejection without altering historical acceptance time.
4. Surface native identity required, mixed/unknown driver, held legacy identity, conflicting correction and owner/GUID conflicts without presenting them as successes. Do not offer a fresh GUID or force upload to bypass them.
5. Read-only queue: no manual retry, cancel, delete or force-upload controls. Automatic retry follows backend policy. Display that disabling public recording sharing stops future uploads but leaves existing published laps online; no automatic-unpublishing progress UI is required.
   Preserve existing F1 World recording eligibility in guidance/status; non-World F1 local activity and aggregate statistics are not disabled. Do not imply that recording eligibility and personal-summary inclusion are the same gate.
6. Persist/paginate history via backend, not in-memory counters. Cursor/context changes restart the relevant query without page/account mixing. Worker crash/storage failure is unavailable, not zero or idle success.
7. Local history remains available after cloud sign-out; clearly mark remote information stale/unavailable. Drop late account/revision responses after sign-out or restrictive privacy changes; do not add driver-selection query keys.

Acceptance: UP-04/05/06, PF-05, DR-01/02, LP-01/02; E04/E06/E09/E10/E11/E13/E17.

## UI3 — local dashboard summary versus Online lifetime profile

1. Reuse existing dashboard total-time, favourites, lap-count and period mechanisms. Do not add a new favourite algorithm or clock. This user's own time is headline; Other/Unknown driver time is separate local shared-session context.
2. Show race/practice and existing classification/coverage using authoritative backend projections. Distinguish Unknown driver ownership from unknown session type. Do not assert session-duration classification totals equal the dashboard's positive-lap-time total.
3. Local period views retain dashboard boundaries; Online profile has **all-time only**, no date-range control or dated activity history upload. Label **Local dashboard** and **Online lifetime profile — all devices** so differing totals are understandable.
4. Explain lifetime contributions survive deleting local records; corrected activity can increase/decrease Online totals. Borrowed laps and Other/Unknown driver activity never become personal. Copies with the same original GUID/activity identity are not new activity.
5. Show pending/confirmed profile sync, merged Online revision/time, held ambiguous contributions, unavailable/partial coverage and correction conflict. Never label a device snapshot as merged lifetime total or claim complete account coverage from observed contributions alone.
6. Automatic profile sync starts after sign-in/current acceptance; no separate sync opt-in or source-installation takeover control. Public-lap sharing off does not disable aggregate sync. Disclose public aggregate fields, including allowed Forza statistics, without implying Forza recordings/setups upload.
7. Missing/unknown values remain missing/unknown; measured zero remains zero. Loading/rebuilding/unavailable are distinct from no activity. Cached Online summary is clearly last-known and cannot authorize mutations.
8. Render the shared owner legacy-only branch as an explicitly unverified historical snapshot, separate from local/personal v2 totals. A later authoritative identity hold must show partial coverage/conflict rather than retain a misleading confirmed lifetime total. E09/E10/E11 verify these states; no new opt-in or proof-upload control is introduced.
9. Local Other/Mixed/Unknown context uses the shared positive_lap_time basis and whole-lap classification. Label mixed time as whole mixed-lap time, not another driver's measured duration. Do not send this context to cloud or equate it to measured session-duration categories; E07/E08/E11 verify the distinction.

Acceptance: PF-01–05, DR-03/04, LP-01; E07/E08/E09/E10/E11/E15/E16/E17. UI displays backend results; it does not merge raw per-device data itself.

## UI4 — provenance and existing offline/Online flows

Preserve optional Discord/offline onboarding, zero Online side effects on initial/offline choice, validated callback flow, external Manage Account link, explicit default-off public/setup choices, display-name synchronization and Community Laps alongside local content. Current policy changes prompt explicit re-acceptance and block new recording/profile sync without blocking offline use. Do not auto-replay acceptance or infer it from sign-in.

Website/app Open lap imports retain author and required original GUID in the next manifest version. Details/compare distinguish the original driver from importing local profile. Repeated opens reuse existing original import; do not relabel downloaded content as personal, regenerate its GUID or expose an upload button for it. Backend/cloud verify provenance independently of presentation. Preserve existing original recording time/unknown-time behavior and safe setup handling.
Use the shared manifest-v3 provenance boundary: optional source metadata does not certify a driver or make a borrowed replay personal. Missing source metadata stays unknown; visible author/GUID and exact replay selection remain authoritative for the import flow. E17/E18 verify the actual registration/navigation result.

Acceptance: UP-06, DR-01/04, LP-01/02 and release integration RL-01; E01/E05/E09/E11/E12/E13/E17. The existing Open lap metadata plan gains the shared GUID/provenance extension; fixture-generated author strings are not proof.

## UI5 — Track Details → Laps Community times and Open Replay

Owned scope: the track catalogue's LapManagement host integration, `packages/online/ui/components/OnlineCommunityLaps.tsx`, Online leaderboard hooks/RPC, `packages/online/ui/hooks/cloud-lap-import.tsx`, replay activation and affected message catalogs. Retain existing legacy CommunityLeaderboard/F1 boards separately.

1. Exercise current real composition rather than replace it: explicit selected game/track/car loads actual service lap times; row action is Open Replay for the exact cloud lap. Preserve correct processed milliseconds, public driver, original GUID and real recording availability; no fake rows or placeholder navigation.
2. Both rows and Open Replay require Online sign-in, current consent and effective service-confirmed public lap sharing. No published-lap minimum. Profile statistics syncing alone does not unlock either feature.
3. Signed-out/private/unconfirmed/changed-policy states show explicit locked guidance, no rows/replay action. Turning sharing off immediately removes cached rows/actions; account/game/track/car changes reject stale results. Backend separately protects direct read/import/retry/native/deep-link paths.
4. Open Replay imports/registers or reuses one original lap, preserving source author/GUID and borrowed attribution, then navigates to actual game/session/lap replay. Availability failure/pruned archive shows unavailable; never substitute a different lap. Repeat opens do not duplicate local import or lifetime credit.
5. Revocation during download/registration/activation suppresses stale navigation and unauthorized registration. Existing independently opened local replays stay available offline; no retroactive deletion when sharing stops. Imported action status/ack/query keys use existing account epoch/preference revision.
   Use the shared replay-activation DTO/context definition rather than a UI-local shape. Poll/retry/ack with current access context; start with the exact row GUID and selected track/car plus the game header. Ignore stale access/GUID/selection and acknowledged activation IDs before navigation; the backend independently rechecks cached reuse. E18 exercises a completed cached import followed by revocation/context change and confirms no stale activation or substituted lap.
6. Verify desktop/mobile actual Track Details → Community times → chosen row → replay route plus telemetry/track state. Include new public user with no published laps, missing car, empty/unavailable board, unsupported game, unavailable recording, repeat/cached import and all gate/race states.

Acceptance: CM-01/02, LP-01/02, DR-01, UP-06; E18 and E04/E09/E12/E17. Current code wiring is not runtime evidence; fixture-only button clicks do not close this integration gate.


## Edge cases and expected handling

| Case | Expected UI behavior | Criteria / scenarios |
| --- | --- | --- |
| Sign-out or auth expiry | Keep local dashboard/history/native bindings; stop remote activity, label cached public data stale. | DR-01/02, PF-05; E04/E09/E13 |
| Stale callback or different account against claimed originals | Preserve original ownership and pending work; show sanitized existing auth error, no account-switch or replacement flow. | DR-01/02; E13/E14 |
| Game swaps A→B→A | Keep the installation user; separate Other/Unknown context; mixed/uncertain laps not personal completions/uploads. | DR-03/04, PF-02; E08/E15 |
| Same name, different native drivers | Require verified/bound identity, never automatic display-name matching. | DR-03; E15 |
| Local deletion after successful sync | Local totals may shrink; Online lifetime remains; clearly label scopes rather than show mismatch as corruption. | PF-03/05; E10 |
| Two-device correction conflict | Show held/conflict, retain last confirmed Online revision; no manual force/retry/GUID-remint action. | PF-03/05; E10/E16/E17 |
| Downloaded original claimed by another account | Preserve original author/GUID; show sanitized ownership conflict, no reauthoring. | LP-01/02, DR-04; E17 |
| Worker unavailable, empty history or old snapshot | Distinct states; no invented zero/success/completion claim. | UP-05, PF-05; E04/E11 |
| Policy update while private recording preference | Require new policy acceptance for automatic aggregate sync too; offline dashboard continues. | UP-06, PF-04; E09 |

## Parallel development and verification

After shared DTOs are frozen, build typed deterministic fixtures for single-account/native identity, shared-session attribution, Upload rows and local-versus-Online summaries while desktop/cloud implementation proceeds. Fixture imports remain preview/test-only. Backend lands real typed routes; production adapter uses existing Hono RPC, no `any` or success-shaped fallback for absent handlers.

Use existing runnable app/browser and targeted E2E surfaces before adding any minimal harness. Extend existing consumer-visible account/query/pagination regression tests where needed. One real desktop/mobile pass covers keyboard/focus/screen-reader status, non-color cues, overflow, all locales and all loading/offline/capture-active/swap/conflict states. Actual worker/API/SQLite/processor integration is required for durable/privacy/source claims; fixtures prove presentation only.

Shared [E01–E19](raceiq-online-contract.md#shared-e2e-strategy-and-scenario-ownership) defines setup/action/expected observations. UI owns E04/E07/E08/E11/E13/E14/E15/E17/E18 presentation with integration owner supplying real state; E12 hosted/Windows integration and E19 legal/policy rendering remain release dependencies. Run root typecheck, applicable locale checks and actual browser evidence after implementation. No new app tests/screenshots or runtime verification are claimed by this documentation revision.

Legal UI dependency: no validation badge, GUID, leaderboard rank or Open Replay availability may imply guaranteed accuracy/authenticity or tamper-free laps. Source Terms/Privacy now state best-effort validation/moderation/removal. Align active versions and re-acceptance notices before publication; do not leave continued-use-only copy in service/account surfaces. LG-01 maps to E19; source edits are not a claim of deployed policy or legal compliance.

## Remaining work execution amendment, 2026-10-22

This is the separate UI implementation plan for [remaining acceptance](raceiq-online-remaining-plan.md#acceptance-registry). It references the [same shared contract](raceiq-online-contract.md) as the [backend work packages](raceiq-live-service.md#remaining-work-execution-amendment-2026-10-22). The registry owns acceptance definitions and shared E2E setup/action/results; UI does not redefine DTOs, ownership, eligibility, retry or lifetime merge.

### Owned work packages

| Package | Owned components and implementation steps | Acceptance / actual E2E |
| --- | --- | --- |
| U1 — Upload and lifecycle feedback | Existing Settings/Upload components, `packages/online/ui/settings/OnlineSection.tsx`, Online query hooks/RPC and affected locales. Exercise real durable queue/history with page boundaries, settlement ties, restart, late responses, sign-out, retry/held/error/unavailable and later server validation. Repair observed display/query gaps; preserve one Settings → Upload destination, read-only controls, stable acceptance times and separate publication/validation. Render capture/worker limitations through existing sanitized contracts; never turn missing backend status into success/zero. | R15/R16 plus visible R01/R04/R05/R13/R14; V15/V16 and visible V01/V04/V05/V13/V14; E03/E04/E05/E06/E11/E13/E14. |
| U2 — local/profile/identity truthfulness | Existing dashboard/home/library/detail/compare and Online profile/binding/onboarding components, `packages/online/ui/hooks/raceiq-online.ts`, `packages/online/ui/lib/raceiq-online.ts`, query keys and locales. Extend typed fixtures for local versus all-device lifetime, pending/held/conflict, legacy-only, zero/unavailable, interval/session bases and same-name drivers. Connect to actual summary/profile/binding handlers, not UI merging. Verify corrections/decreases, local deletion, policy pause/reacceptance, offline capture and immutable account claims with real app state. | Visible R08/R09/R10/R11/R12/R14/R16/R21; V08/V09/V10/V11/V12/V14/V16/V21; E07–E11/E13–E16/E19. Backend owns reducer/identity correctness. |
| U3 — exact replay and restrictive transitions | Existing track catalogue host integration, `packages/online/ui/components/OnlineCommunityLaps.tsx`, `packages/online/ui/hooks/cloud-lap-import.tsx`, existing activation/navigation, Online hooks and locales. Extend the already working F1/LMU surface for stale selection/epoch/revision, cached actions, zero-publication user, unavailable/pruned archive and revocation at every async stage. Ignore stale results and acknowledged activation IDs; navigate only to the exact registered original. Keep independently opened local replay usable offline. | R17/R16 plus visible R06/R18/R20; V17/V16 with V06/V18/V20; E17/E18/E12. Backend independently rejects unauthorized direct/retry/deep-link operations. |

### Parallel development and shared prerequisites

After P0 freezes the existing DTOs and any proposed overload feedback boundary, U1–U3 can proceed independently of backend native fixtures, aggregate merge and cloud work. Use contract-conforming typed fixture states for presentation while real integrations develop; fixtures remain test/preview-only and never count as production-path evidence. One UI owner integrates shared hooks/locales/query keys, or allocates non-overlapping files explicitly. Backend integration owner owns AppType/DTO changes and informs UI before dependent edits.

Reuse existing app/browser/E2E surfaces and established visual design. No redesign, new account controls, manual delivery actions, raw external SDK/fetch or UI-local aggregation. Backend B5 supplies actual durable read models and replay barriers; B3 supplies aggregate readback; these are final integration prerequisites, not reasons to serialize fixture-based UI work.

### Edge cases and observable handling

- Late page, account, game/track/car or activation responses are discarded; sign-out/privacy/policy changes immediately remove gated rows/actions and cannot be reversed by stale success.
- Unknown, legacy, held, offline and unavailable remain distinct from measured zero, empty history and accepted success. Preserve last confirmed receipt separately from later validation/publication.
- Local deletion does not imply lifetime subtraction; same-original corrections may decrease totals. Explain scope/coverage rather than manufacture matching local/Online numbers.
- Same-name native drivers, expired candidates, capture gaps and binding changes never become inferred Self. Different login does not reauthor already owned records.
- Repeated/cached Community actions require current entitlement; unavailable/pruned selected laps never substitute another recording. Existing local replay is not deleted on revocation.
- Policy-version changes require explicit acceptance for profile sync even with public recordings off; offline analysis and deletion controls remain available.

These cases map to each package's R/V IDs and the shared [V execution matrix](raceiq-online-remaining-plan.md#shared-e2e-execution-matrix). Existing UI1–UI5 requirements remain in force; the amendment does not silently waive their negative states.

### Verification and completion

Run actual integrated app journeys for each package after implementation using the existing browser surface and controlled real backend state. Batch desktop/390 px mobile, all supported locales, keyboard/focus/status announcements, non-color meaning, overflow and sanitized-error checks. Mocks/fixture previews supplement, never replace actual UI → typed Hono → worker/SQLite → cloud/processor integration for the mapped criteria.

The integration owner owns shared V execution/evidence; UI owns visible assertions/screenshots and documents backend prerequisites/blockers. Run desktop root typecheck, applicable locale checks and relevant existing consumer regressions when inputs change. Hosted OAuth, compiled Windows, genuine required-game/retention fixtures and operator-approved legal rendering remain P3 dependencies. No native desktop control is permitted without current explicit scoped authorization.

Close a UI package only with passing mapped real E2E evidence and current applicable gates, not screenshots alone. Record failed/blocked/not-run states honestly. This planning revision runs no new runtime scenario and provides no new release proof.
