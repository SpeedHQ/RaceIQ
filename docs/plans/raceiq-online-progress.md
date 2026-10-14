# RaceIQ Online upload recovery progress

Updated: 2026-10-14. This records completed work and remaining gates, not a claim that automatic recording uploads are finished.

## Current status

**Queue infrastructure and persistent status are implemented and verified. Recording production/integration is intentionally on hold.** Another branch owns automatic splitting into one lap per BIN. This branch must not implement a competing session slicer.

The reported successful sign-in is not the missing prerequisite. Default recording dispatch remains gated until a real per-lap producer and verified recording codec are supplied.

## Done

- [x] Persistent **Upload queue** panel in General settings, including empty, loading, signed-out, blocked and stale/unavailable states.
  - Account-scoped queued/uploading/rejected counts, current error/block and localized Last synced with exact ISO timestamp.
  - No fabricated counts while status is unknown; no previous-account data after sign-out/switch.
  - Stable accessible status region; all 12 locale catalogs updated.
- [x] Replace fixed-zero backend status with an atomic, account-owned SQLite ledger summary.
  - Last synced advances only after confirmed transfer/accepted-key reconciliation, not refresh, failure or validation alone.
  - History survives restart and authorization-epoch rotation; storage failures propagate instead of returning invented empty status.
- [x] Replace custom generic claiming, leases and retry scheduling with **Effect PersistedQueue + SQLite**.
  - Pin `effect` and `@effect/sql-sqlite-bun` to `4.0.4`; retain `@speedhq/live-client@0.1.13`.
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

## Remaining — held on the recording branch

- [ ] Land the automatic per-lap BIN producer and its actual publication/metadata contract.
  - Do not guess filenames, offsets, framing or readiness signals.
- [ ] Bind that producer to upload preparation; enable production selection/enqueue only when recordings are durably ready.
  - Cover historical best-per-game/track backfill, new laps, imports, reprocessing and faster replacements.
  - Existing wake notifications/coordinator are implemented; they do not replace producer integration.
- [ ] Verify all supported game formats against the authoritative service parser.
  - Every recording must contain exactly one intended logical lap with required sparse context/boundaries.
  - Reject missing, truncated, oversized, unsupported or identity-mismatched data without sending bytes.
- [ ] Complete and verify embedded F1 setup sanitization for per-lap recordings.
  - Preserve local originals; optional attachments require separate current opt-in and verified game support.
  - Do not invent an opaque setup attachment from the local JSON setup snapshot.
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
- **Not run / not established:** per-game recording compatibility, final producer wiring and authenticated live recording uploads. Session-recording extraction remains paused by request; the package extraction is verified above.

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

Wait for the recording branch's real per-lap producer contract. Then integrate that output and verify compatibility/privacy before enabling recording dispatch. Do not restart session extraction or require another sign-in to compensate for the missing producer.
