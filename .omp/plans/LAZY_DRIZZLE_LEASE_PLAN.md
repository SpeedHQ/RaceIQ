# Unblock lazy Drizzle worker SQL and resume upload verification

## Context

The recorded Bun 1.4.3 regression fails at the remote worker SQL lease guard: `Worker SQL requires an active remote database write lease`. Both `.then()` and native-Promise bridging have already failed; do not repeat those as a fix or add a process-global lease fallback. The authoritative feature scope remains `docs/plans/online-upload-profile-sync.md`, with current evidence in `docs/plans/evidence/online-upload-profile-sync/verification.md`.

## Findings

- `server/db/write-coordination.ts` resolves the worker SQL sender from `AsyncLocalStorage<Lease>` at dispatch. `withDatabaseWrite()` currently invokes `operation().then()` inside `leaseContext.run()` and Effect-scoped admission.
- `apps/backend/test/runtime/worker-sql.test.ts:38` intends to exercise remote SQL but runs worker-client calls in the parent process. Recorded result: 22 pass, 1 fail across worker SQL and coordination suites.
- `docs/adr/0014-parent-owned-startup-worker-sql.md` requires parent-owned native handles, lease/transaction ownership validation, release acknowledgement after cleanup, and query-only worker reads. Preserve this contract.
- Actual application upload startup and E05/E06/E09/E13 plus hosted terminal rejection remain unverified. Planning ran only read-only, in-memory diagnostic probes, not the reported suite or app E2E.

## Approach

### 1. Correct the regression topology

Root `bunfig.toml` preloads `server/test-support/setup-data-dir.ts`, which imports and initializes `server/db/index.ts`. That module installs the main-thread local authority. `acquireLease()` at `server/db/write-coordination.ts:278` prefers `localAcquire` over `workerTransport`; local leases contain `release`, not `sql`. Configuring a transport in the same process cannot make those leases remote.

Replace the in-process worker setup in `apps/backend/test/runtime/worker-sql.test.ts` test `lazy Drizzle run stays inside remote write lease and releases it for next writer`. Keep native DB and `createDatabaseWriteLeaseAuthority(..., native)` in the parent. Move transport installation, worker client, Drizzle and admitted SQL into a real `node:worker_threads` worker.

Add `apps/backend/test/fixtures/worker-sql-lease-worker.ts`. Reuse the transport listener pattern from `apps/backend/src/runtime/online-worker-entry.ts:35–55`: requests travel through `parentPort.postMessage`; response listeners receive `write-lease-*`; close emits channel-closed. Import coordination and Drizzle directly. Do not import DB initialization, install a local authority, or open native SQL in this worker. Launch with `new Worker(new URL("../fixtures/worker-sql-lease-worker.ts", import.meta.url))`, following the existing `node:worker_threads` construction in `apps/backend/src/runtime/startup-worker.ts`.

The parent forwards lease requests to its authority and authority responses to the worker. Add test-only messages, separate from production RPC:

- Worker sends `{ type: "test-held" }` after admitted writes but before releasing its outer lease.
- Parent sends `{ type: "test-release" }` after observing the queued competing writer.
- Worker sends `{ type: "test-done" }` after completing the scenarios, or `{ type: "test-error", message: string }` on failure.

Reject pending test promises on worker error or premature exit; use bounded deadlines and message barriers, not sleeps.

Keep production coordination unchanged, including `withDatabaseWrite<T>(operation: () => Promise<T>, signal?: AbortSignal, operationName?: string): Promise<T>`, sender guard, admission priority and RPC types. LSP found 159 references to `withDatabaseWrite`; no caller migration is needed. Do not stop the parent authority to simulate a worker, add global leases, patch Drizzle, or retry SQL. Preserve the parent-owned native-handle contract in `docs/adr/0014-parent-owned-startup-worker-sql.md`.

### 2. Prove lazy SQL, isolation, error recovery and release

Reuse existing file-backed `withDatabase()` and `entries(id INTEGER PRIMARY KEY, value TEXT)` fixture.

1. Worker calls `withDatabaseWrite(() => db.run(sql`INSERT INTO entries (id, value) VALUES (1, 'committed')`))`. Preserve the directly returned lazy query, not an eagerly executed substitute.
2. Worker acquires another lease, inserts row 2 through `worker.execute()`, then inserts row 3 through nested `withDatabaseWrite()` returning lazy Drizzle SQL. Hold that outer operation at `test-held`.
3. While held, parent calls its own `createDatabaseWorkerClient().execute()` outside an admitted write. Require `Worker SQL requires an active remote database write lease`; its attempted row must not exist.
4. Parent starts `withDatabaseWrite()` inserting row 4 with a unique operation name. Use existing `installDatabaseWriteTestHooks()` to observe queuing. Require row 4 absent before sending `test-release`; then await its successful insertion.
5. Worker issues duplicate-primary-key SQL through directly returned lazy Drizzle in another lease. Require rejection, then insert row 5 successfully in a subsequent lease.
6. Worker invokes SQL outside `withDatabaseWrite()` after release. Require the same guard error. Parent native query must contain exactly IDs 1–5 and their expected values, with no unauthorized row.

These assertions exercise the real authority/client integration; the held-writer case specifically prevents a global-lease fallback. Restore hooks/transport in `finally`. Close worker port normally; on failure terminate only the test-owned worker and await exit. Parent must await `authority.workerExited()` before closing native SQL. Keep all existing worker transport and coordination tests.

### 3. Resume runnable actual-application checks

After steps 1–2 pass, run existing lifecycle and HTTP recovery fixtures against fresh native source and actual hosted service. No new UI or endpoint changes are planned. Do not substitute stubbed `online-user-journeys-smoke.ts` for app/service proof.

`server/db/online-upload-legacy-conversion.ts:146` directly returns lazy `db.run()` to `withDatabaseWrite()`, so production startup exercises the relevant query shape. Its current conversion no longer contains the retired DROP statements from earlier startup evidence. Observe current lifecycle before changing production code on the basis of stale errors.

Record exact commands/results/evidence paths in `docs/plans/evidence/online-upload-profile-sync/verification.md`. This request is an unblock increment, not closure of the original feature. Preserve E05 replacement, E06 deletion/invalidation, E09 nonempty legacy restart conversion, E13 community replay and authoritative hosted terminal rejection as open. The lifecycle fixture explicitly reports E05/E06/E13/rejection omissions at line 221; do not erase those or claim E01–E15 completion.

## Acceptance criteria

| ID | Observable result |
| --- | --- |
| UL-01 | Real worker directly returns lazy Drizzle SQL from `withDatabaseWrite()` and commits through the parent authority. |
| UL-02 | Nested writes reuse admission; parent writer waits for acknowledged release; rejected SQL releases its lease for the next writer. |
| UL-03 | Unrelated and post-release SQL reject without mutating data. Production admission and strict guard remain unchanged; no global fallback. |
| UL-04 | Actual app Online worker starts and lifecycle fixture proves real F1/LMU receipts, source-unavailability recovery and restart without terminal resubmission. |
| UL-05 | HTTP recovery proves same-request restart and configured transient-failure handling. Evidence retains all unexecuted original scenarios as open. |

## Verification

### Planning evidence

The reported failing suite was not rerun merely to confirm the user's observation. Two read-only Bun 1.4.3 in-memory probes ran from `server/`:

- Drizzle instrumented-client `db.run(...).then()` preserved `AsyncLocalStorage` values `direct`, `effect-0`, `effect-1`, including two calls through one Effect `ManagedRuntime`.
- Installing local authority and then remote transport before a worker-client call printed `{"requests":0,"error":"Worker SQL requires an active remote database write lease"}`. No transport request occurred.

This establishes the regression's wrong lease kind, not universal correctness of production context propagation. No file-backed regression, application E2E or build ran during planning.

### Runtime integration and edge cases

From `/Users/acoop/orca/workspaces/RaceIQ/online`, run after implementing:

```sh
bun test apps/backend/test/runtime/worker-sql.test.ts apps/backend/test/runtime/database-write-coordination.test.ts
bun test apps/backend/test/runtime/worker-sql.test.ts
bun test apps/backend/test/runtime/database-write-coordination.test.ts
```

Keep normal preload enabled. The combined and independent runs detect shared-state dependence. Require all cases passing: new lazy worker path UL-01; nested/queued/rejection transitions UL-02; unauthorized and post-release calls UL-03. Existing cancellation, shutdown, foreign/closed lease, native rollback/constraint failure and worker-exit cases must remain passing.

### Actual application and hosted integration

Use isolated temporary directories/accounts/ports and disposable TLS. Do not use user data, live accounts, service source edits, commits, deployments, SDK publication or desktop control.

Check recorded prerequisites before using them:

- `RACEIQ_CLOUD_ROOT='/Users/acoop/orca/projects/raceiq cloud'`, including `apps/raceiq/target/debug/raceiq-server` and processor entry point used by existing fixture.
- Candidate disposable TLS: `/tmp/raceiq-fastest-lap-tls-7xSqmK/cert.pem` and `/tmp/raceiq-fastest-lap-tls-7xSqmK/key.pem`. If missing, create new temporary self-signed cert/key for `127.0.0.1` with IP subjectAltName. Never print secrets.

Generate fresh source under a new canonical OS temporary directory:

```sh
DATA_DIR=<fresh-canonical-temporary-directory> NODE_ENV=test \
RACEIQ_FEATURE_F1_EXPERIMENTS=true RACEIQ_FEATURE_IRACING_ADAPTER=true \
bun --no-env-file apps/backend/test/fixtures/online-upload-native-source.ts
```

Export `RACEIQ_UPLOAD_SOURCE_DATA_DIR` to that directory, `RACEIQ_UPLOAD_TEST_CERT` and `RACEIQ_UPLOAD_TEST_KEY` to disposable TLS paths, plus `RACEIQ_CLOUD_ROOT`. Do not set `RACEIQ_TEST_MODE=1`: fixtures consume `app.db`. Preserve source installation identity for same-installation restart.

```sh
bun --no-env-file apps/backend/test/fixtures/online-upload-lifecycle-smoke.ts
RACEIQ_UPLOAD_RESERVATION_FAULTS=429,503,disconnect \
RACEIQ_UPLOAD_TRANSFER_FAULTS=503,disconnect \
bun --no-env-file apps/backend/test/fixtures/online-upload-http-recovery-smoke.ts
```

- UL-04: actual status → setup → login reaches `/api/online/state` 200; unavailable F1 source does not starve LMU; both genuine winners retain confirmed success/remote identity/time; at most one multipart body is active; terminal rows do not resend after restart; no profile writes.
- UL-05: configured 429/503/disconnect are transient, Retry-After holds, dropped accepted response leaves local terminal outcome null, restart preserves account/key/identity/fingerprint/reservation and resolves one actual hosted acceptance without duplicate body acceptance.
- Store logs outside this plan; record actual scope/outcome in existing verification evidence. Fixture `passed:true` does not prove its omitted scenarios. Do not claim anti-cheat approval from upload receipts.

## Assumptions & contingencies

- Scope is the lease unblock and resumption of existing runnable app checks. `docs/plans/online-upload-profile-sync.md` remains authoritative for remaining feature work. No separate UI/backend plans are needed for a test-topology correction with unchanged production contracts.
- If the real-worker regression also loses context, preserve strict guard, capture the exact failing boundary, and report that runtime blocker. Do not claim unblock complete or reapply failed Promise bridges; a separately grounded correction is required before UL-01–03 pass.
- If current actual startup fails, use nested cause/code from existing startup diagnostics. Do not diagnose lease loss from an outer Drizzle query error alone or restore retired profile/DDL cleanup.
- If external service/binary or native artifacts are absent, finish local regression work and report the exact unavailable prerequisite. Do not fabricate a service or change its source; UL-04/05 remain unverified.

