# Prerequisite-safe startup and dashboard writes: implementation verification

Implementation plan: [prerequisite-safe startup and coordinated dashboard writes](prerequisite-safe-startup-and-dashboard-writes.md).

Status: implementation and required acceptance verification complete. All S-E1–S-E8 and W-E1–W-E7 application scenarios pass with parent-owned worker SQL. The final recording manifest has no failures or skips; integration and core suites report four and two skips, respectively.

## Concrete writer inventory

All paths below use the backend-owned write authority. The startup worker uses the parent-port lease transport, not an independent local permit. Parsing, hashing, file copying, and capture decoding remain outside database admission. Existing transactions use their transaction executor while ownership is held.

| Writer family | Participating implementation |
| --- | --- |
| Database initialization, migrations, initialization backfills | `server/db/index.ts`: `initDb` |
| Session insertion, identity/source/raw-file updates, favorites, deletion, capture split admission/progress/publication/recovery | `server/db/session-queries.ts` |
| Lap insertion, annotations, timing, sectors, setup, favorites, deletion | `server/db/lap-mutation-queries.ts`; favorites in `session-queries.ts` |
| Historical lap replacement, raw indexes, downsample/reference cutover | `server/db/lap-reprocessing-queries.ts` |
| Race results, pit events, pit-cycle lap invalidation | `server/db/session-result-queries.ts` |
| Dashboard projection, tombstone subtraction, day/month/time-bucket contributions | `server/db/dashboard-summary-queries.ts`: `publishDashboardSession` |
| Dashboard backfill cursor, retry state, capture checkpoints | `server/session-capture/dashboard-processor.ts` |
| Live capture creation, source identity, progress, member publication, state transitions | `server/db/live-capture-queries.ts` |
| Compressor reference cutover | `server/session-capture/compressor.ts` |
| Consented layout organization and recording relocation | `server/session-capture/layout-migration.ts`, `relocate-recordings.ts` |
| Capture cleanup/reference clearing | `server/session-capture/session-cleanup.ts` |
| Direct recording manifest and lap ownership publication | `server/session-capture/direct-recorder.ts` |
| Live recovery and seal | `server/session-capture/live-recovery.ts`, `live-seal.ts`; `apps/backend/src/session-capture/live-recovery.ts` |
| Capture split migration retry state | `apps/backend/src/session-capture/split-migration.ts` |
| LMU identity repair | `apps/backend/src/imports/lmu-session-identity-backfill.ts` |
| BIN, ZIP, staged IBT, LMU DuckDB, MoTeC import persistence and rollback | Existing import adapters converge on the session/lap/source/finalization/deletion helpers above; ZIP annotation restoration also uses `apps/backend/src/laps/archive.ts` |
| Authentication setup, login/logout, protection and network changes | `apps/backend/src/runtime/dashboard-auth.ts` |
| Analyses and metrics caches | `server/db/analysis-queries.ts`, `line-spread-cache-queries.ts`; `server/lap-analysis/metrics-store.ts` |
| Driver profile cache and run history | `server/db/driver-profile-queries.ts` |
| Discovery and track geometry | `server/db/discovered-cars.ts`, `discovered-tracks.ts`, `track-queries.ts` |
| Tunes and assignments | `server/db/tune-queries.ts`, `community-tune-queries.ts` |
| Experiments, versions, action log, lap associations, undo | `server/db/experiment-queries.ts`, `experiment-version-queries.ts`, `experiment-action-queries.ts`, `experiment-lap-queries.ts`; `server/experiments/undo.ts` |

## Read and resource ownership

- Main-thread `client`/`db` use the native writer. The startup worker uses a lease-bound SQL executor backed by parent-owned native handles; the global serialization proxy is removed.
- File-backed `readClient`/`readDb` use separate query-only native connections in both contexts. Historical paging, lap metadata, and application reads do not acquire the write permit or enter another operation's writer transaction.
- Parent SQL leases own native transactions and submitted operations. Actual worker exit awaits submitted SQL, rolls back/closes remaining transactions, then releases admission. Closing the SQL host does not close the shared parent client.
- Worker finalizers await `write-lease-released` after native cleanup and physical permit release. Publication notifications cannot precede this acknowledgement.
- The synchronous dashboard snapshot connection is explicitly closed during backend and test teardown.
- Shutdown closes database connections only after ingress, recording maintenance, layout migration, recorder, split manager, startup worker, and write authority have drained. A component failure cannot skip other owners or force a successful process exit.
- Candidate preparation snapshots source state and the published capture baseline. Publication rechecks both inside its transaction; capture decoding also rejects a changed baseline.

## Observed verification

Full logs are retained under `.omp/evidence/prerequisite-safe-startup/` in this workspace. The following results supersede earlier failed or cancelled diagnostic runs.

| Command or surface | Observed outcome | Evidence |
| --- | --- | --- |
| `RACEIQ_FEATURE_IRACING_ADAPTER=true bun run --cwd apps/backend test:unit` | 373 passed; no failures. Includes startup/readiness, shared admission, and native MessageChannel SQL transport regressions | `backend-unit-accepted.log` |
| `bun run --cwd apps/backend test:integration` | 2,956 passed, 4 skipped, no failures across 221 files. Includes native dashboard publication/baseline regressions | `backend-integration-verified.log` |
| `bun run --cwd server test` | 26 passed, 2 skipped, no failures across core unit and integration suites | `backend-core-verified.log` |
| `bun run --cwd apps/backend test:e2e:recordings` | 108 passed, no failures or skips across 11 files, including all 13 dashboard write scenarios and 18 upgrade/startup scenarios | `recording-e2e-parent-owned-accepted.log` |
| `bun run typecheck` | 14 packages passed; backend passed in 984 files | `workspace-typecheck-verified.log` |
| `bun run effect:check` | 0 errors, 0 warnings, 11 informational diagnostics | `effect-check-verified.log` |
| `bun run lint` | 33 packages passed | `lint-verified.log` |
| `bun test test/changelog.test.ts --timeout 60000` | 11 passed; no failures | `changelog-verified.log` |
| Manual production-backend HTTP smoke | Fresh startup/dashboard readiness; auth setup HTTP 200; staged IBT import persisted exactly one lap/session; session/dashboard reads HTTP 200; deletion HTTP 200; session list empty; graceful SIGTERM exited 0 | `manual-startup-smoke-final.log`, `manual-startup-backend.log` |

The optional iRacing adapter is explicitly enabled for its unit tests. Product feature defaults and Effect 4.0.4 pins are unchanged. The live catch-up regression retains its five-second deadline, concurrent-ingress assertions, native digest checks, and every control acknowledgement; its producer now stops when member publication completes rather than adding unrelated frames while acknowledgements drain.

## Resolved native runtime failure

On Bun 1.4.3, forcibly terminating a worker with a live native libSQL transaction left SQLite's write lock held after worker exit and termination acknowledgement. Closing worker clients and synchronous exit hooks did not reliably clean up the transaction connection. Those experimental wrappers and debug logs were removed.

The approved [parent-owned SQL decision](../adr/0014-parent-owned-startup-worker-sql.md) keeps native transaction handles reachable in the parent after worker failure. The real W-E7 scenario now observes rollback before queued production HTTP deletion succeeds, retains the previous committed revision until deletion/tombstone processing, and verifies cleanup after restart without `SQLITE_BUSY`. No database driver swap, busy retries, timeout increases, independent worker permit, or completed-operation ledger is shipped.

The admitted-only worker executor also exposed two old reader bindings: historical session paging and `getLapsForSession`. Both now use `readDb`; real release-upgrade and missing/corrupt-capture recovery scenarios pass. MoTeC's standalone fixture uses the existing canonical application assembly rather than depending on another file's registry/notifier initialization. Native transport tests materialize SQL rejection before inspecting error metadata, avoiding Bun's blocking asynchronous throw matcher without changing the production wire protocol.

## Scenario-to-acceptance evidence

The implementation plan maps each scenario below to its acceptance criteria and edge cases. `R` is the final recording manifest (`recording-e2e-parent-owned-accepted.log`); `W` is its dashboard write matrix; `D` is the native dashboard publication suite in the final integration gate (`backend-integration-verified.log`). Unit/static checks supplement, rather than replace, these actual backend HTTP, filesystem, worker, and persisted-database observations.

| Scenario | Surface | Observed application evidence | Outcome |
| --- | --- | --- | --- |
| S-E1 | R | Actual layout status HTTP succeeds before consent; legacy bytes, references, stale timing, and repair markers remain unchanged; no completion/successor log | Passed |
| S-E2 | R | Conflicting destination and source survive failed consent; removing the conflict and retrying in the same process succeeds; historical entry observes no storage import reservation or relocation owner | Passed |
| S-E3 | R | Malformed/unreadable and zero-entry unfinished journals block startup; a cut-over journal with zero legacy files requires explicit recovery before replay | Passed |
| S-E4 | R | Release-seeded capture is organized before historical entry; Tourist identity and times 398.781/401.277 are restored; annotations, favorites, IDs, and relationships survive; dashboard starts once | Passed |
| S-E5 | R | Missing/corrupt captures retain pending markers and history while real HTTP remains available; restoring capture and restarting resumes repair | Passed |
| S-E6 | R | Successful repair restart retains sentinel timings and skips already-current race results; trigger-protected terminal ambiguous/nonrace results remain unchanged | Passed |
| S-E7 | R, W | Deferred and active ordinary stop prevent successors; precommit stop rolls back, postcommit stop preserves commit, worker/database/lease shutdown settles; abrupt exit cleanup also passes | Passed |
| S-E8 | R | Unresolved LMU strings/numeric identities and trigger-induced race writes block successors; persisted unavailable/ambiguous and practice results permit dashboard startup without replay | Passed |
| W-E1 | W | HTTP deletion after candidate preparation removes session/projections; stale candidate cannot recreate them; duplicate tombstone publication leaves exact zero aggregates | Passed |
| W-E2 | W | Real worker transaction holds admission; HTTP deletion waits and succeeds after release; projections and contributions drain away | Passed |
| W-E3 | W | BIN, ZIP, staged IBT, DuckDB, and MoTeC success/failure paths overlap publication; persisted source totals match dashboard day/month/time buckets; failed inserts roll back source rows | Passed |
| W-E4 | W, D | Real capture checkpoint/source revision invalidates prepared work; fresh publication catches up; native transaction rejects an old same-revision capture baseline | Passed |
| W-E5 | W | Active precommit stop preserves prior committed revision; late postcommit stop retains commit; subsequent deletion and restarted publication succeed | Passed |
| W-E6 | W | Real session HTTP read completes while the permit alone is held; dashboard HTTP read during uncommitted worker transaction returns the prior committed snapshot | Passed |
| W-E7 | W | Queued stop/exit releases unused admission. Forced exit after actual projection mutations awaits parent rollback/close before queued HTTP deletion returns 200; committed revision and restarted tombstone cleanup remain correct | Passed |
