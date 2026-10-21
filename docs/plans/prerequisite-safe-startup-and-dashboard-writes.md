# Prerequisite-safe startup and coordinated dashboard writes

Status: implemented and verified. All S-E1–S-E8 and W-E1–W-E7 application scenarios pass, including abrupt worker-exit rollback with parent-owned SQL. Required project gates and manual HTTP smoke passed; see the [writer inventory and verification report](prerequisite-safe-startup-and-dashboard-writes-verification.md).

Issues: [#468](https://github.com/SpeedHQ/RaceIQ/issues/468), [#475](https://github.com/SpeedHQ/RaceIQ/issues/475).

ADR: [Parent-owned startup-worker SQL](../adr/0014-parent-owned-startup-worker-sql.md).

## Scope and authoritative references

Backend-only work. Preserve existing HTTP contracts and UI; no frontend redesign, new dependency/version, new scheduler, generic workflow engine, fake fallback, or hide-tire changes. Both issues are implementation scope, not optional follow-ups.

- [Scheduled recording maintenance](../contributing/scheduled-recording-maintenance.md): Effect lifecycle, shared storage locks, non-cancellable Promise I/O, awaited shutdown.
- [Recording-frequency plan](recording-frequency.md), especially its Effect lifecycle section: reuse conventions, not its historical version assumptions.
- Current `server/package.json`, `apps/backend/package.json`, and `bun.lock` pin Effect **4.0.4**. Preserve those pins and existing Bun tests/tooling.
- Consulted `effect-solutions list` and `show basics services-and-layers data-modeling error-handling testing`. Reference checkout: `~/.local/share/effect-solutions/effect`. Its beta APIs and the guide's Vitest installation examples are not authority over this repository. Use installed-version public APIs and current code (`Schema.TaggedError`, `Ref`, `ManagedRuntime`, `Fiber`, scoped finalizers); verify additional API signatures during implementation without inspecting dependency source.
- Existing startup guards: `apps/backend/src/runtime/startup-worker.ts`, `startup-worker-entry.ts`, and `server/session-capture/layout-migration.ts`. These are the immediate dependency-free safety fix and must remain effective throughout cutover.
- Durable repair authority: existing layout/move journals, session detector/capture markers, LMU identity fields, race-result processor versions, and dashboard revision/dirty state. Do not add a competing durable completion ledger.
- Existing mutation/publication contracts: `server/db/session-queries.ts`, `dashboard-summary-queries.ts`, `server/session-capture/import-pipeline.ts`, and `apps/backend/src/routes/laps/transfer-routes.ts`.

## Observed starting point

Startup already defers worker launch until layout readiness, subscribes before checking readiness, and gates historical → LMU → race → dashboard on result predicates. Layout completion notification is already emitted after the maintenance-lock callback settles and storage reservation releases. Preserve these properties rather than treating Promise resolution as success.

Historical replay returns missing/failed counts. LMU returns unresolved/missing/malformed counts and can use discovered identity evidence when captures are unavailable. Race backfill returns both per-session errors and failed games; legitimate persisted ambiguous outcomes are terminal. Existing worker shutdown has a five-second forced termination path: not safe proof that active writes settled.

Dashboard candidates already carry source revisions and publication rechecks revision. Strengthen transactional existence/deletion checks rather than replacing this mechanism. Deletion currently retains contributions until a tombstone publication subtracts them; preserve correct subtraction without double counting.

`server/db/index.ts` currently contains an inline `serializeClient` proxy that globally queues reads and writes. A separate `serialized-client.ts` is not the current implementation location. Its queue is per JS context; startup/dashboard worker and HTTP backend have independent clients. Keeping that proxy or adding independent per-context semaphores does not satisfy #475.

## Observable acceptance criteria

Issue identifiers are namespaced below; original numbering is retained.

| ID | Required observable result |
| --- | --- |
| S-AC1 (#468 AC1) | Typed stage specs expose explicit completion predicates. Order is organization → historical replay → LMU identity → race results → dashboard. Pending/running/partial/failed/interrupted predecessors and returned error counts prevent every successor. |
| S-AC2 | Legacy `<game>/` organization requires explicit consent. Files and capture references are not organized/replayed before consent. Any unfinished or unreadable journal blocks, including zero remaining legacy entries. |
| S-AC3 | Successful organization wakes startup in the same process only after file/DB cutover, journal deletion, maintenance-lock release, and reservation release. Duplicate/racing wakeups admit exactly one execution. |
| S-AC4 | Missing/corrupt historical captures and failed repairs retain pending markers/history and block successors. Unresolved LMU identities block race/dashboard; race errors/failed games block dashboard. Legitimate terminal ambiguous/skipped results remain terminal. |
| S-AC5 | Restart resumes incomplete work using existing durable state and skips successful repairs. Notes, favorites, relationships, lap timing, ownership, and capture references survive. |
| S-AC6 | Scoped subscriptions/fibers stop while deferred or active; no late stages/publications. Stop awaits protected writes/finalizers before DB close and releases locks, reservations, and write leases. Repeated stop is safe. |
| S-AC7 | Blocked stage/reason is accurate. Completion logs and stale-session notification clearing occur only after the relevant completion predicate holds. Actual backend HTTP stays usable for prerequisite resolution. |
| W-AC1 (#475 AC1) | Deletion overlapping candidate preparation or publication completes without SQLITE_BUSY. After processor drain, session, per-session projections, and its aggregate contributions stay removed. |
| W-AC2 | Recording imports overlapping refresh complete without SQLITE_BUSY or lost source writes. Drained dashboard totals equal final persisted source data. |
| W-AC3 | Publication transaction rejects candidates prepared before source revision/existence changes; stale work cannot recreate deleted projections or overwrite newer contributions. |
| W-AC4 | Transaction failure or interruption rolls back uncommitted work, closes the transaction, and releases permit after I/O settlement. Subsequent delete/import/publication succeeds. |
| W-AC5 | Read-only application queries do not acquire or queue behind the application write permit. A read can finish while that permit alone is held. |

## Design decisions and internal contracts

### One ordered startup lifecycle

Use Effect for the existing startup queue, not a parallel scheduler. Parent scope owns layout subscription/readiness, worker lifetime, and worker write transactions. Worker scope owns reconciliation, dashboard processing, and its native read connection. CPU/file parsing stays in the existing worker. Do not share the recording-maintenance runtime across worker contexts or couple its shutdown to startup lifetime.

Define a typed stage ID union and stage spec tying each stage's result type to its completion predicate. Model runtime states as discriminated variants: pending, waiting (stage/reason), running, complete, failed, interrupted, stopping/stopped. Only complete unlocks a successor. Expected prerequisite blocks are not defects or successful empty results. Typed errors retain stage, reason, and underlying cause; defects/interruption terminate advancement at the lifecycle boundary.

Subscribe before initial readiness inspection. Atomically admit startup once with `Ref.modify`; wakeups request a fresh readiness check, never directly bypass it. Preserve generation checks in layout readiness. Coalesce duplicate wakeups; stop wins against late readiness/callbacks. Layout remains an externally consented prerequisite, not an automatically executed migration stage. Do not introduce automatic retries for destructive organization.

Per-stage completion:

- **Organization:** no active/partial/error organization or relocation, no journal, no legacy files/references; completion event only after releases. Inspect failure retains a concrete blocked reason, not an inferred successful empty scan.
- **Historical:** zero failed/missing captures and no eligible pending/stale repairs. Retain the separate error counts: `countStaleSessions` only considers available captures and cannot prove missing captures complete. Delete eligible empty sessions and clear stale notification only after this predicate; keep failed rows pending.
- **LMU:** no unresolved required identity fields. Count resolved using the same nonempty/nonlegacy identity predicate used to select pending rows, so numeric legacy IDs cannot become false success. Missing/malformed capture diagnostics do not erase identities recovered legitimately from existing discovered catalogs; if identity remains unresolved, block.
- **Race:** zero errors and zero failed games; current persisted ambiguous outcomes are successful terminal results, not perpetual retry work. Do not advance processor versions on failed writes.
- **Dashboard:** start exactly once after all predecessors complete. Its processing/retry behavior remains backend-owned; successful startup does not imply every dashboard projection has already finished.

### Shared write ownership across HTTP and worker contexts

Introduce a narrow Effect write-coordination service in backend-core, with one permit authority owned by the backend lifecycle. HTTP writers acquire it locally; the existing startup worker acquires the same authority through a typed parent-port lease protocol. A module singleton in each thread is explicitly insufficient.

Internal protocol: acquire(requestId) → granted(requestId, leaseId) or rejected(requestId, reason); cancel(requestId); release(leaseId) → released(leaseId); stop/drained acknowledgements. Release acknowledgement follows native cleanup and physical permit release; worker finalizers await it before publication notifications. IDs are unique per worker lifetime. Only the owner releases its lease; stale/duplicate messages are harmless. Cancellation racing grant must release a granted-but-unused lease. Parent does not reclaim an active lease merely because interruption was requested: wait for submitted SQL settlement, then roll back/close remaining parent-owned transactions after actual worker exit before releasing admission. Channel loss blocks new writes and triggers owned shutdown; no independent-permit fallback. This is write admission, not a second job scheduler.

All competing write paths must participate before removing global serialization. Inventory raw-client writes, Drizzle transactions/autocommit writes, and import adapters reachable while dashboard runs, including live/background paths using the same connection. Record the concrete writer list in the implementation review. Explicit write helpers own admission across the entire write unit; do not classify SQL text or recreate a global read/write serialization proxy. Worker writer execution uses the approved SQL transport below only after acquiring its lease. Native reads bypass both this transport and write admission. Nested helpers reuse the current lease and transaction executor.

At minimum cover dashboard publication/cursor/retry/checkpoint writes, session deletion and empty-session deletion, recording import session/lap/source/finalization/rollback writes, and other same-connection source writers found by that inventory. Include canonical BIN, ZIP, staged IBT, LMU DuckDB, and MoTeC entry points through their real persistence paths; do not assume wrapping `importSessionBin` covers the others. Scope permits to DB write units, not capture decoding or an entire upload.

Preserve existing storage lock order: storage reservation when applicable → maintenance lock when applicable → DB write permit → transaction. No permit-held callback acquires storage/maintenance locks. File cleanup and expensive evidence/candidate computation run outside the write permit; publication notifications run after commit and permit release.

Use Effect resource acquisition/finalizers for permit and transaction ownership. Waiting for a permit is interruptible. Protect non-cancellable Promise statements and commit/rollback until settlement. Check interruption before commit; interrupted uncommitted work rolls back. Interruption arriving after successful commit cannot undo that commit: release resources and report settled outcome without duplicate publication. Do not blindly interrupt a `tryPromise` and release a permit while SQL continues. Preserve original failure if rollback/close also fails, reporting cleanup failure at the boundary.

### Parent-owned worker SQL execution (approved)

The user selected parent-owned transactions after real W-E7 failures showed Bun 1.4.3 can retain a live libSQL transaction lock after forced worker termination. Synchronous worker exit hooks were unreliable and are not a solution. Preserve the installed native SQLite client and Effect versions; no new driver, busy retries, or forced ordinary shutdown.

The integration owner owns `write-coordination.ts`, DB binding selection, worker wiring, package exports, and final verification. `server/db/worker-sql.ts` owns the SQL wire codec, native parent execution, and worker-side `Client` executor. Tests own a separate runtime test file.

Module contract for independent implementation:

- `WorkerSqlOperation`: discriminated `type` union for `execute` (`statement`), `batch` (`statements`, optional `mode`), `execute-multiple` (`sql`), `migrate` (`statements`), `sync`, and `begin` (optional `mode`). The first three accept optional `transactionId`. `commit`, `rollback`, and `close` require `transactionId`. Use public libSQL input types; batches preserve both statement objects and `[sql,args]` tuples.
- `WorkerSqlRequest`: `{ type: "write-lease-sql"; leaseId: string; operationId: number; operation: WorkerSqlOperation }`.
- `WorkerSqlResponse`: `{ type: "write-lease-sql-result"; operationId: number; value: WorkerSqlValue }` or `{ type: "write-lease-sql-error"; operationId: number; error: WorkerSqlError }`. Payloads are structured-clone-safe. Result sets retain columns/types, numeric and named row access, BLOBs, bigint insert IDs, affected counts, and lazy JSON serialization. Preserve native error message/name/code/extended code/raw code and useful causes.
- `WorkerSqlSender = (operation: WorkerSqlOperation) => Promise<WorkerSqlResponse>`.
- `createWorkerSqlClient(getSender: () => WorkerSqlSender): Client`. Obtaining a sender requires the active remote lease; no local/native-write fallback. Transactions capture that lease-bound sender so finalizer close works outside async-local scope. Implement the existing public file-client methods, overloads, close/reconnect state, and real error behavior. Closing this remote executor never closes the parent database.
- `createWorkerSqlHost(client: Client)` returns `{ openLease(leaseId: string): void; receive(request: WorkerSqlRequest): Promise<WorkerSqlResponse>; closeLease(leaseId: string): Promise<void>; close(): Promise<void> }`. Only opened leases admit SQL. Transaction IDs belong to their lease; foreign, closed, or stale ownership cannot touch native handles. Keep only live leases/transactions and monotonic operation IDs, not a completion ledger.
- The host preserves port submission order within a lease. Closing admission rejects queued work that has not begun, awaits already-submitted native work, then rolls back/closes uncommitted transactions before removing the lease. Cleanup still closes after rollback failure; no permit release while native work/handles remain unsettled.
- The parent lease authority opens a SQL lease before granting it. Release and actual worker exit await SQL lease cleanup before releasing the underlying shared permit. A `write-lease-released` acknowledgement follows physical release and is awaited by worker finalizers. Parent `workerExited()` becomes awaited. Ordinary stop and actual-exit test acknowledgements preserve this resource ordering.
- `withDatabaseTransaction` opens a transaction inside its lease context. Main-thread `client` stays native; worker `client` uses the lease-bound executor. `readClient`/`readDb` remain native query-only file connections in both contexts.

Supplemental native-database tests cover result/BLOB/bigint/JSON transport, real commit and rollback, foreign transaction IDs, duplicate/stale operation IDs, closed channels/leases, and rollback-before-next-writer on lease loss. These support W-AC2/3/4 but do not replace W-E1–W-E7. The actual W-E7 forced-exit HTTP scenario must pass before either issue closes. All existing source/data-preservation criteria and E2E scenarios remain unchanged.


### Publication correctness and reads

Compute contributions/capture evidence outside the transaction. Within a short permitted write transaction, re-read `dashboard_summary_state` revision/deleted flag and session existence. Accept a live candidate only when session exists, is not deleted, and revision matches; otherwise return rejected without changes. Accept a current tombstone only when session is absent/deleted and its revision matches; atomically subtract retained old contributions and remove projections. Preserve day/month/time-bucket subtraction and idempotence. Handle missing state as rejection.

Do not trust a pretransaction `prior` summary if another publication has replaced it. Validate the candidate publication baseline (`publishedRevision`/relevant capture state) inside the transaction; reject and reprepare if changed, keeping expensive recomputation outside the transaction. No stale-capture preservation from a superseded baseline.

After participating writer cutover, remove inline `serializeClient` and any obsolete equivalent module/callers. Read paths use the native read path without the write permit. If reads would otherwise share an active write-transaction connection, provide a dedicated read connection/executor with the same file DB and awaited lifecycle; do not execute application reads inside another operation's transaction. W-AC5 concerns application permit admission, not a promise that arbitrary SQLite schema/exclusive locks never delay reads. No busy-timeout increase/retry loop as substitute for coordination.

### Shutdown and diagnostics

Keep `startStartupWorker(...): StartupWorkerHandle` and Promise route boundaries. Use existing Effect runtime/finalizer patterns, not `Effect.run*` inside programs. Wire stop → reject new admission/remove subscriptions → interrupt waiting work → await active protected units and dashboard stop → release leases/runtime → close worker DB → acknowledge stopped. Replace ordinary five-second force termination with awaited draining; diagnostic timeout may report stuck work but must not close the DB/release ownership beneath active writes.

Parent shutdown must mark startup stopping early enough to prevent new stages during ingress/maintenance draining. Track admitted layout migration settlement where needed: its detached Promise must not outlive owned shutdown without an awaitable drain. Preserve existing migration HTTP `202` admission semantics and 400/409/500 errors. Existing layout status supplies user resolution; use structured internal stage/reason messages/logs without inventing a frontend API.

## Implementation work packages

One integration owner owns worker message protocol, lifecycle wiring, and write-coordination interfaces. Do not edit these shared interfaces concurrently.

1. **Shared prerequisite:** define typed stages/results and cross-context write lease contract; add deterministic tests for admission, grant/cancel races, failure/interruption, and resource settlement. No runtime behavior cutover until safety guards remain covered. Maps S-AC1/3/6, W-AC4/5.
2. **Startup slice:** replace Promise/boolean orchestration with scoped Effect ownership in `startup-worker.ts`/`startup-worker-entry.ts`; retain/strengthen layout readiness and each result predicate in issue #468 paths. Update `shutdown.ts` only for lifecycle ordering/drain. Maps S-AC1–7.
3. **Writer slice:** implement explicit permit/transaction helpers; migrate dashboard publication and all discovered competing deletion/import/source writers, including worker bridge. Remove global client serialization only after coverage is complete. Maps W-AC1–5. This can proceed alongside startup slice after the shared interfaces are settled.
4. **Integration:** exercise actual startup plus active dashboard and real import/delete routes. Verify stop drains bridge/SQL correctly. Update `server/session-capture/README.md`, maintenance contributor guidance where lifecycle rules change, and one coherent customer-facing changelog entry per shipped behavior. Register new tests in existing suite manifests; no new test framework.

## E2E and edge-case matrix

Extend `apps/backend/test/e2e/database-upgrade.test.ts` for S scenarios. Extend `apps/backend/test/db/dashboard-summaries.test.ts` and add targeted backend E2E scenarios for W using the actual dashboard processor and deletion/import entry points. Use isolated **file-backed** temporary SQLite DBs, real committed captures, actual `bootServer`, production worker bridge, and real HTTP requests. Reuse existing fixture conversion and expected Tourist times. No mock DB or mock import pipeline substitutes.

Add narrowly injected test barriers at candidate-prepared, transaction-open/before-commit, and repair-entry boundaries. Use `Deferred`/explicit acknowledgements, not scheduling sleeps. Hooks exist only as injected test dependencies, never externally reachable production controls. Each scenario uses fresh data or explicitly awaited restart; release barriers and stop/drain all processes in `finally`.

| Scenario | Setup/action → expected evidence | Criteria |
| --- | --- | --- |
| S-E1 consent | Start with legacy files/references and pending repairs; GET actual backend layout status before POST consent → bytes/references/repair markers unchanged, blocked reason recorded, no successors; HTTP succeeds. | S-AC1/2/7 |
| S-E2 collision/retry | Publish conflicting destination bytes; explicitly consent → partial/error, source/conflict preserved, successors absent. Remove conflict; POST retry → same process runs once after lock/reservation release. | S-AC2/3/4 |
| S-E3 journal recovery | Restart with all entries cut over, zero legacy files, unfinished relocation journal; also exercise malformed journal → blocked, no replay. Explicit valid recovery deletes journal and releases resources before advancement. Invalid journal stays actionable/error without destructive auto-repair. | S-AC2/5/7 |
| S-E4 successful cutover | Real release-seeded Tourist capture; consent → inspect organized DB paths at replay-entry barrier; resume → layout identity restored and valid lap times exactly 398.781/401.277, annotations/relationships preserved, stage-entry order exact, dashboard starts once. | S-AC1/3/4/5/7 |
| S-E5 failed capture | Parameterize missing and corrupt capture → preserve pending marker, lap/history/annotations and references; no LMU/race/dashboard or stale-notification clear. Restore real capture and restart → repair resumes. | S-AC1/4/5/7 |
| S-E6 successful restart | After complete repair, restart same DB → no successful replay/identity repair repeats; processor versions skip completed race work; no duplicate dashboard startup in one lifecycle. | S-AC3/5 |
| S-E7 stop | Stop deferred startup then emit completion; stop during blocked repair/write then release barrier → no late stage, transaction settles before DB close, listeners/worker/leases drain, repeated stop resolves safely. | S-AC6; W-AC4 |
| S-E8 downstream failures | Unresolved LMU including legacy numeric identities; real SQLite trigger rejects race write; thrown and returned failures → exact blocker, no successor. Separate current ambiguous/nonrace outcomes → dashboard allowed without repeated repair. | S-AC1/4/5/7 |
| W-E1 deletion after prepare | Active processor pauses after preparing live candidate; DELETE via session route; resume old publication and drain tombstone → no SQLITE_BUSY, no resurrection, zero per-session projections and removed day/month/time contributions. Repeat duplicate publication to prove no double subtraction. | W-AC1/3 |
| W-E2 deletion during publish | Hold actual worker publication transaction; request HTTP deletion and observe permit wait; release publication → deletion completes, drain removes projections/contributions, no SQLITE_BUSY. | W-AC1/4 |
| W-E3 import overlap | Hold publication; submit real recording through upload/import entry point; release and drain → success, source session/lap/capture references intact, exact dashboard counts/times match final source. Cover each distinct import persistence path and rollback path, not merely each extension. | W-AC2/4 |
| W-E4 stale source | Prepare candidate; mutate source through participating application path, including raw-source checkpoint/revision change; attempt old publication → rejected, newer revision/contributions unchanged; fresh refresh matches source. Also race two candidates sharing a source revision but different publication baseline. | W-AC2/3 |
| W-E5 failure/interruption | Inject real transaction failure; interrupt permit waiter and active precommit transaction at barriers → rollback leaves no partial source/projection deltas, no leaked/granted-unused lease. Subsequent delete/import/publication succeeds. Test late interruption after commit as settled success, not rollback claim. | W-AC4 |
| W-E6 reads | Hold permit without an SQLite write transaction; issue actual application read request → completes before permit release. Repeat with active short WAL transaction using read executor → committed snapshot, no application permit queue. | W-AC5 |
| W-E7 bridge lifecycle | Cross-worker grant/cancel/stop races, duplicate releases, worker exit while queued/holding transaction → no second simultaneous writer, no orphan admission, subsequent operation succeeds after actual settlement/exit. | S-AC6; W-AC1/2/4 |

Deterministic stage/coordination tests supplement these E2E scenarios: zero work, every non-complete predecessor variant, returned vs thrown failure, duplicate wakeups during initial readiness, stop racing grant/readiness, repeated stop, transaction begin/commit/rollback failures, nested executor reuse, and lock-order/non-reentrant admission. They do not replace application evidence.

Existing upgrade harness uses a test-only migration control server and log markers. Extend it to discover and call the actual backend HTTP port/routes for consent, status, deletion, import, and availability assertions. Completion logs alone do not prove order, lock release, persistence, or HTTP health; use barriers and DB/filesystem assertions.

## Execution and evidence required before implementation completion

Run from repository root after implementation, preserving suite isolation:

```sh
bun run --cwd apps/backend test:unit
bun run --cwd apps/backend test:integration
bun run --cwd apps/backend test:e2e:recordings
bun run --cwd server test
bun run typecheck
bun run effect:check
bun run lint
```

The recording E2E manifest already includes `database-upgrade.test.ts`. Its release-upgrade scenario needs an available stable Git tag and frozen-install access for that release; required captures must exist. Report missing prerequisites precisely; do not silently skip that scenario or substitute mocks. Run existing changelog validation if the changelog changes.

Record scenario ID, executed command, observed DB/filesystem/HTTP outcome, and pass/fail in the implementation verification report. Store full failure output outside this plan. Every S-AC/W-AC and matrix scenario requires passing applicable E2E evidence before either issue is closed. Blocked/unexecuted evidence is not completion.

Planning research is complete. Implementation verification is tracked separately in the [verification report](prerequisite-safe-startup-and-dashboard-writes-verification.md); failed, cancelled, or unexecuted scenarios do not satisfy acceptance criteria.
