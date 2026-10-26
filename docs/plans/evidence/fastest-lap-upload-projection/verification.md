# Fastest-lap projection verification

Status: implementation under integration verification, not acceptance or release certification. No service deployment, staging or commit performed. Checkpoint use was declined; this file records verification evidence only.

## Passing checks

| Command/scenario | Outcome | Evidence and scope |
| --- | --- | --- |
| Root `bun --no-env-file run typecheck` | Passed | [Latest typecheck](desktop-completed-typecheck.log). Later SQL-trigger correction is covered by the pending runtime regression pass, not by typechecking. |
| Projection/source storage regression suite | Final rerun pending | Prior source/storage results do not certify the v103 indexed retry queue and latest ownership changes. |
| Online outbox, persisted queue and replacement suites | 31 passed | [Reviewed delivery log](outbox-reviewed-complete.log): generation fencing, epoch renewal, cross-board held-request progress, immutable old-key recovery and authoritative unaccepted supersession. |
| Native ingress, raw storage/reprocess and process cache suites | 25 passed | [Lifecycle log](native-source-recovery-regressions.log): native artifact handling, stale reprocess publication, repeated process refresh and unknown/absent distinction. Expected overload-path logging is not a test failure. |
| Genuine portable import restoration/conflict | 1 passed | [Native roundtrip log](portable-finish-native-trusted-close.log): controlled known T survives incoming null; conflicting non-null T2 is rejected without mutation through the production importer. Controlled T tests preservation, not source-time derivation. |
| Genuine finalized source setup | Passed | [Layout-aware source log](native-source-v100-layout-aware.log): actual F1 and LMU parser/pipeline/direct recorder, explicit trusted fixture closure, ready generation and matching closed layout-1 source proof. No manual SQL readiness publication. |
| Cloud native processor smoke | Passed | [Final native smoke](cloud-native-time-smoke-native-clock-final.log): actual API/SDK/processor/native decoding, known source finish T, missing-clock null, archive repair/upgrades, ownership/publication fences and decoder failures after fractional-clock correction. |
| Cloud workspace typecheck and website build | Passed | [Workspace types](cloud-workspace-typecheck-final.log), [website build](cloud-account-build-final.log). |
| Legacy cloud archive metadata migration suite | 9 passed | [Migration log](cloud-finish-metadata-upgrade.log). |
| SDK build, public pack and installed-artifact HTTP verification | Passed | [Build](sdk-final-build.log), [pack](sdk-final-pack.log), [installed SDK consumer](sdk-final-consumer.log). Verifies public/protected `finishedAt`, exact archive bytes, nullable schema, real multipart admission and documented auth boundaries. This is not the full release gate or publication. |
| Actual cloud website/API DOM checks | Passed, with visual limitation | [DOM evidence](website-record-time-browser-dom.json): known finish renders June 1 rather than publication date; null renders `Unknown` at mobile width. Screenshot and one targeted retry timed out; no screenshot proof. Two font requests failed; no application JavaScript error was observed. |
| Desktop workspace build | Passed | [Workspace build](desktop-completed-build.log). No Windows native-hardware certification. |
| Customer release-note gate | 11 passed | [Changelog checks](changelog-gate.log). Existing feature notes cover finalized fastest-lap uploads and original timing/identity preservation. |

## Fixture and environment boundaries

The immutable finalized source used for current desktop smokes was created under canonical OS temporary storage:

`/private/var/folders/pb/5svw71yn047bpq35gcddj7mm0000gn/T/raceiq-projection-fallback-v101.NYKNOp`

It contains genuine F1 World laps (fastest 79328 ms) and Bahrain LMU laps (fastest eligible Self 85169 ms). The older Spa fixture failed cloud metadata resolution; the earlier `raceiq-fastest-lap-two-boards-UFxZ6q` had no ready sources. Neither is current acceptance evidence.

Cloud checkout: `/Users/acoop/orca/projects/raceiq cloud`. Smokes use isolated app/cloud databases, ports, TLS and provider dependencies. No user database is used. Private key/token contents are not recorded.

[Native duration inventory](native-duration-inventory.log) found no controller-qualified complete valid lap longer than five minutes in the available cloud-native catalog. This is a concrete FL-E12 coverage gap, not permission to manufacture native timestamps, ownership or actor evidence.

## Integration acceptance matrix

| Scenario | Current evidence/status |
| --- | --- |
| FL-E01 upgrade/backfill | Storage regression passed; real desktop lifecycle acceptance pending. |
| FL-E02 steady state | Real desktop lifecycle/restart counters pending. |
| FL-E03 publication | Genuine ready F1/LMU setup passed; real desktop two-board delivery pending. |
| FL-E04 mutation/deletion | Storage and reprocess regressions passed; real mutation/deletion variants pending. |
| FL-E05 preparation holds | Real fallback/recovery variant pending. |
| FL-E06 in-flight replacement | Persisted-queue held-request regression passed; real A/B/C plus LMU D proxy variants pending. |
| FL-E07 concurrent evaluation | Storage stale-CAS regression passed; real native faster-candidate barrier variant pending. |
| FL-E08 crash boundaries | Outbox crash/retry regressions passed; actual desktop crash/HTTP recovery variants pending. |
| FL-E09 acceptance/rejection | Cloud processor smoke passed; desktop controlled external rejection/fallback and deletion coverage pending. |
| FL-E10 restrictions | Existing focused gates supplement, but do not replace, pending desktop privacy/auth integration runs. |
| FL-E11 rule upgrade | Storage selector-version regression passed; real worker upgrade variant pending. |
| FL-E12 session readiness | Actual recording-finalization variant pending; genuine >5-minute and native Windows cases unavailable. |
| FL-E13 resume/restart/publication | Durable claim/source regressions passed; actual active-mutation and interrupted-reprocess variants pending. |
| FL-E14 historical readiness | Completed-cursor retry regression passed; real historical/surviving-lap recovery acceptance pending. |
| FL-E14A/B confirmed closure and survivor continuation | Isolated real-DB regression rerun pending after v103 queue cutover. |
| FL-E14C/D exclusive mutation and generation ACK | Real fixture extensions implemented; latest finalization/reprocess execution remains required. |
| FL-E14E bounded retry backlog | Indexed implementation present; dedicated real-app backlog scenario not implemented/executed. Not accepted. |
| FL-E15 / RT record time | Native cloud derivation/readback and production portable preservation passed; combined desktop retry/reprocess evidence still required. |

## Failures and release blockers

- Desktop lifecycle attempts exposed incompatible fixture SQLite APIs and missing script bindings; these failures are recorded in `desktop-two-board-lifecycle-*.log`, not counted as passing E2E evidence.
- Ad hoc full-script typechecking remains failed: [cloud diagnostics](cloud-native-smoke-static-check-corrected-symbols.log), [desktop diagnostics](desktop-smoke-static-symbol-check.log). The corrected cloud script has no remaining undeclared-symbol errors, but 25 script typing diagnostics remain. Project/workspace typecheck results above are separate scopes.
- SDK publication is blocked by npm registry authentication: `npm whoami --registry=https://registry.npmjs.org` returned `E401 Unauthorized`. No SDK publication or published desktop dependency pin is claimed.
- Canonical full SDK release remains blocked by unrelated API statistics smoke: `scripts/smoke-api.ts:685` expects an empty zero-metric game list; current user-owned statistics implementation retains zero-metric `f1-2025`. No statistics semantics or assertion were changed to bypass it.
- Latest desktop end-to-end attempts failed or were cancelled after source-verification and trigger defects were found. Final reruns are in progress; failed attempts are not passing evidence.
- No native Windows certification, five-game native acceptance certification or successful browser screenshot capture is claimed.
