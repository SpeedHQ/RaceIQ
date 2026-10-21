# RaceIQ Online upload recovery progress

Current implementation status updated 2026-10-21. The [release contract](raceiq-online-contract.md), [desktop backend plan](raceiq-live-service.md) and [UI plan](raceiq-online-ui.md) retain all acceptance requirements. Checked implementation items below do not imply full application or release acceptance. Current evidence and E01–E19 gaps are recorded in [verification](../../.omp/evidence/raceiq-online-implementation/verification.md).

## Current status

**Queue infrastructure, persistent status, dedicated worker and native recording producer integration are implemented.** Upload preparation reuses published artifacts and existing native framing/context infrastructure, not a competing session slicer. Main integration retains released classification migration82, relocates named Online migrations to83–94, and routes Online worker SQL through the shared application authority with separate read connections.

Genuine F1 World and both Bahrain LMU laps pass isolated Rust HTTP publication, archive download and canonical native reparse with original GUIDs and matching-binding Self. After main integration, fresh F1/LMU Community imports and repeated desktop and 390 px mobile Open Replay passed with advancing playback, original GUIDs and authors, borrowed ownership, and no duplicate rows. Private and signed-out Community gates suppress Open Replay. ACC fixture coverage remains parked; iRacing is excluded from the current recording investigation.

## Done

- [x] Persistent **Upload queue** panel in General settings, including empty, loading, signed-out, blocked and stale/unavailable states.
  - Account-scoped queued/uploading/rejected counts, current error/block and localized Last synced with exact ISO timestamp.
  - No fabricated counts while status is unknown; no previous-account data after sign-out/switch.
  - Stable accessible status region; all 12 locale catalogs updated.
- [x] Replace fixed-zero backend status with an atomic, account-owned SQLite ledger summary.
  - Last synced advances only after confirmed transfer/accepted-key reconciliation, not refresh, failure or validation alone.
  - History survives restart and authorization-epoch rotation; storage failures propagate instead of returning invented empty status.
- [x] Replace custom generic claiming, leases and retry scheduling with **Effect PersistedQueue + SQLite**.
  - Pin `effect` and `@effect/sql-sqlite-bun` to `4.0.4`; the installed local `@speedhq/live-client@0.2.0` candidate remains unpublished.
  - Package owns durable delivery, locks, heartbeats, retries and cleanup in `raceiq-online-queue.db`.
  - One account-scoped consumer; durable work contains job reference/request key, not credentials, recording bytes or authorization epochs. The v2 namespace re-admits legacy exhausted references from the ledger without changing upload identity.
- [x] Keep upload-specific identity and outcomes in the separate business ledger.
  - Durable UUIDv7, payload fingerprint/reference, reservation token, remote job ID and immutable acceptance timestamp.
  - Same-key reconciliation after ambiguous work survives the five-attempt definite-no-send budget and subsequent reservation failures; package retries retain capped backoff. Accepted-marker redelivery does not transfer again.
  - Legacy keyless ambiguity remains held; migrations preserve successful timestamps.
  - Rejected-lap deduplication, faster-lap admission, coalescing and retired file-reference retention. Capacity limits count only pending, dispatching and ambiguous work, so terminal history cannot exhaust admission and faster replacements fit at capacity.
  - Interrupted keyed work with no payload or reservation resumes preparation, including previously stranded `process_interrupted` rows; superseded no-send intents retire across authorization epochs. Genuine uncertain transfer outcomes remain held for same-key reconciliation.
- [x] Preserve privacy/account barriers and final transport authorization checks.
  - Refresh authorization at processing; recheck immediately before actual SDK fetch after asynchronous credentials/serialization.
  - Restrictive changes withdraw unsent/reconcilable intents across epochs; another account cannot dispatch them.
  - Server Retry-After is a durable not-before barrier; shutdown prevents new starts and waits for started delivery/receipt.
- [x] Confirm authoritative service protocol from `SpeedHQ/online`.
  - Exactly one logical lap per recording; F1 World native car ID is `"41"`; no canonical eligibility-proof API exists.
  - Reservation locks, expiration and already-accepted-key responses are classified by the adapter.
- [x] Remove the competing session-slicing implementation, extraction-dependent tests and temporary smoke scaffolding.
- [x] Update backend/UI plans, shared contract notes and changelog to distinguish queue readiness from deferred recording integration.
- [x] Extract Online contracts, service/adapter, delivery and separate storage into `@raceiq/online`; the backend app composes host credentials/runtime while frontend consumers import only `@raceiq/online/contracts`. Package-owned tests retain all queue recovery regressions; the app-owned lap-candidate query stays in backend core.

## Remaining — integrate published lap artifacts

- [x] Main supplies automatic per-lap BIN publication and its metadata contract.
  - Use `resolveLapCaptureArtifact` in `server/session-capture/source-loader.ts`; do not guess filenames, offsets, framing or readiness signals.
- [x] Bind the native recording producer to production candidate selection and upload preparation.
  - Dedicated worker resolves immutable original membership, native bindings, GUIDs and artifact readiness before preparing a candidate.
  - Producer/source/codec regressions pass; full connected desktop selection/enqueue and auth-transition acceptance remains unchecked below.
- [ ] Verify all supported game formats against the authoritative service parser.
  - Every recording must contain exactly one intended logical lap with required sparse context/boundaries.
  - Reject missing, truncated, oversized, unsupported or identity-mismatched data without sending bytes.
- [x] Implement embedded F1 setup sanitization for per-lap recordings.
  - Native codec and actual HTTP/archive checks preserve local originals and omit embedded setup packets; separate setup attachments remain opt-in.
  - The complete desktop privacy/setup/account race matrix remains part of production-path acceptance below.
- [ ] Exercise the complete production recording path after integration.
  - Real per-lap input → selection/enqueue → reservation → immutable payload → transfer → persisted acceptance.
  - Cover restart, privacy/setup/account races, source changes, rate limits and same-key reconciliation.
- [ ] Establish authenticated remote upload acceptance and any validation/publication feedback.
  - Upload acceptance is not cloud validation or public publication. Supported withdrawal behavior remains a separate end-to-end gate.

## Verification recorded

- **Passed:** root `bun run typecheck`, including locale compilation and workspace checks.
- **Passed:** ledger/adapter/auth/status/payload-identity regressions; legacy migration and fresh-process status checks.
- **Passed:** coordinator regressions for nine same-key attempts through ambiguity/reservation failure to acceptance, accepted-row restart without redelivery, faster-lap admission, exhausted v1 reference recovery, five-attempt definite failure rejection, retry deadlines, account isolation and graceful stop. Ledger regressions cover cross-epoch interruption recovery, terminal-history admission, active account/global limits and at-capacity replacement.
- **Passed:** fresh-process runtime smoke: interruption before payload persistence → same-key coordinator acceptance under a new authorization epoch → faster-lap admission.
- **Passed:** extracted package verification: `bun run --cwd packages/online test` (27 tests), focused backend/candidate regressions (15 tests), and client Online contracts (6 tests). A compiled Bun queue fixture verified ambiguous reconciliation, legacy namespace recovery, definite-failure budgeting, retry deadlines, account isolation and graceful stop. The production bootstrap bundle passed with existing DuckDB externalization; host singleton/storage/coordinator startup-shutdown smoke and client production build passed.
- **Passed:** `bun run test:shards` — ordinary tests assigned exactly once.
- **Passed:** `bun run i18n:check-keys` — complete supported catalogs.
- **Passed:** `bun test packages/tooling-release/test/changelog.test.ts --timeout 60000`.
- **Earlier UI proof:** real local Hono/RPC/SQLite status, desktop/mobile DOM and mobile accessibility audit. Package extraction changes UI imports, not presentation; no new visual inspection or screenshot is claimed.
- **Premerge native correction gates:** desktop20 tests, cloud30 native/trend plus10 scoped parser tests, desktop34/34 typecheck, cloud processor typecheck and11 changelog tests passed at recorded inputs. Actual HTTP/archive smoke covers April09 primary, both Bahrain LMU laps and four April22 additional F1 laps.
- **Post-main integration gates:** migration/dashboard105, native/classification107, runtime/portable-import101, real worker write-coordination E2E13 and changelog11 tests pass. An actual isolated backend retains auth/setup/Online-state200 with an occupied UDP port. Main's worker SQL authority, migration lineage and extracted catalogue boundaries are retained; exact commands, typecheck outcomes and remaining connected/release gaps are linked from the verification report.
- **Connected replay after main:** importer standalone reads use the read connection and registration uses the shared write authority. Actual SDK PKCE and callback verification used a pinned loopback provider; browser-hosted OAuth is not claimed. Fresh, repeated and mobile F1/LMU playback and private/sign-out gates are recorded in `connected-main-replay.json`; 12 importer/controller tests and the final 37-package typecheck passed. Full E18 race/error coverage and wider release acceptance remain incomplete.

## Relevant implementation and tests

- UI: `client/src/components/settings/OnlineSection.tsx`.
- Package/contracts: `packages/online/src/contracts.ts`, exported as `@raceiq/online/contracts`.
- Ledger: `packages/online/src/outbox-storage.ts`.
- Delivery: `packages/online/src/{coordinator,outbox,adapter,upload-dispatch,service,payload}.ts`.
- Host composition: `apps/backend/src/integrations/online.ts`; app lap selection query: `server/db/online-upload-queries.ts`.
- Regression coverage: `packages/online/test/{outbox,persisted-queue,payload-identity,adapter}.test.ts` and their isolated fixtures.
- Backend status/auth: `apps/backend/test/routes/{online-queue-status,online-auth}.test.ts`.
- Context: [Backend plan](raceiq-live-service.md), [UI plan](raceiq-online-ui.md), [contract](raceiq-online-contract.md).

## Next action

Preserve the completed local connected replay proof and continue only authorized release-acceptance work against the canonical contract. Hosted OAuth, compatible published releases, Windows execution, the complete E18 race/error matrix and broader E01–E19 scenarios remain unverified. Keep ACC/Evo fixture gaps explicit; do not require another production sign-in, force attribution, or search for more ACC recordings.
