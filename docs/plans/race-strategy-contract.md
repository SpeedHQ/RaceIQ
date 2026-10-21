# History-backed race strategies

Plans: [UI](race-strategy-ui-plan.md), [backend](race-strategy-backend-plan.md). Integration owner: coordinator. Backend owns shared DTOs/schema and persistence; UI owns builder/live presentation. Independent implementation begins against these agreed decisions, using current session/stint contracts rather than a second history model.

## Scope and decisions

Users create/edit/delete named race plans for one exact game, native car, native track/layout and optional PI. Select previous owned sessions and completed/interrupted stints as evidence for each planned stint. Configure race length, ordered pit laps, per-stint starting fuel and compound. No automatic optimizer or invented refuel capability. Plans are manual intent, visibly distinct from automatic live pit estimates. They can be prepared without an active race from session analysis; saved plans can be loaded/unloaded for live display and survive restart.

Authoritative existing evidence: `shared/racing/live/strategy.ts` StintSummary, session ownership, native identities, sample counts, semantic versions and remaining-health tire thresholds. Do not reuse tune-attached `RaceStrategy` (a different, non-durable tuning annotation).

Timed race length and carry-adjusted refueling extend this boundary through the [timed race strategy contract](timed-race-strategy-contract.md), with separate [UI](timed-race-strategy-ui-plan.md) and [backend](timed-race-strategy-backend-plan.md) plans. Existing lap-only payloads remain valid; the extension defines the additional optional JSON field and its normalization.

## Shared types / HTTP

New `shared/racing/live/race-plan.ts` exports schemas and types:
- `RacePlanStintInput = { endLap: number; startFuel: number|null; compounds: [string|null,string|null,string|null,string|null]; sourceSessionId: number|null; sourceStintId: string|null }`.
- `RacePlanInput = { name: string; gameId: GameId; carId: string; trackId: string; pi: number|null; totalLaps: number; fuelUnit: "L"|"tankFraction"; notes: string; stints: RacePlanStintInput[] }`.
- `RacePlanStint = RacePlanStintInput & { evidence: StintSummary|null }`.
- `RacePlan = Omit<RacePlanInput,"stints"> & { id: string; createdAt: string; updatedAt: string; stints: RacePlanStint[] }`.
Export `RacePlanInputSchema`, `RacePlanSchema`, `RacePlansResponseSchema` validating `{ plans: RacePlan[] }`, `ActiveRacePlanResponseSchema` validating `{ plan: RacePlan|null }`. JSON dates are UTC ISO strings. Server freezes evidence on create/update; clients cannot submit trusted evidence.

Routes inherit existing dashboard authentication/CSRF middleware:
- `GET /api/race-plans?gameId=<GameId>` -> `{plans}`, updatedAt DESC then id; game filter required. No pagination needed for install-local user-authored plans.
- `POST /api/race-plans` body RacePlanInput -> RacePlan, HTTP 201.
- `PUT /api/race-plans/:id` full RacePlanInput -> RacePlan, HTTP 200.
- `DELETE /api/race-plans/:id` -> `{deleted:true}`, 404 if absent; deletes active selection atomically when needed.
- `GET /api/race-plans/active` -> `{plan:RacePlan|null}`.
- `PUT /api/race-plans/active` body `{planId:string|null}` -> `{plan:RacePlan|null}`; null unloads; unknown ID 404.
Validation failures HTTP 400 `{error:string,code:"INVALID_RACE_PLAN"}`; unknown plan/source 404 `{error:string,code:"RACE_PLAN_NOT_FOUND"|"RACE_PLAN_SOURCE_NOT_FOUND"}`; database errors use existing 500 handling. Do not expose arbitrary SQL or bypass auth.

Example input: `{ "name":"20-lap race", "gameId":"fm-2023", "carId":"642", "trackId":"5", "pi":800, "totalLaps":20, "fuelUnit":"tankFraction", "notes":"", "stints":[{"endLap":10,"startFuel":0.4,"compounds":[null,null,null,null],"sourceSessionId":12,"sourceStintId":"stint-12-local-player-1"},{"endLap":20,"startFuel":0.4,"compounds":[null,null,null,null],"sourceSessionId":12,"sourceStintId":"stint-12-local-player-1"}] }`.

Validation: trimmed nonempty name <=120, native car/track nonempty <=200, notes <=4000, totalLaps integer 1–10000, 1–100 stints, strictly increasing positive endLap, last endLap == totalLaps. Finite starting fuel >=0 (tankFraction <=1); nullable is unknown. Source IDs both set or both null. Evidence must belong to that owned session, exact game/car/track/PI (PI required/equal for Forza), completed/interrupted, compatible fuel unit and per-wheel compounds. Different driver buckets or semantic versions are never averaged; each stint references its own measured snapshot. Reject source mismatch, never silently coerce. Missing rates/semantic versions remain unavailable; zero rates remain valid. Manual rows with no source are permitted but have no history-derived predictions.

Historical evidence is a snapshot, not a live promise: deletion/reprocessing of source history does not delete plans or fabricate fresh evidence; show snapshot origin/date/counts. Future edits re-resolve chosen sources and reject missing sources until user selects another or clears the reference.

## Planning and live semantics

Builder shows per-stint duration in laps, expected fuel consumption = eligible fuel rate * stint length, projected end fuel only with known startFuel and compatible rate, and four-wheel expected tire health from fresh tires = 100 * (1 - eligible wear rate * stint length), bounded 0–100. Label fresh-tire assumption and missing/unknown setup/conditions. Flag insufficient fuel and crossing current game/compound cliff/dead; no invented fuel conversion/capacity, tire service time or automatic strategy. Tire projections do not override actual telemetry.

Loaded strategy display uses current source-native game/car/track and PI where required. Exact match replaces the compact pit-estimate panel with Race strategy: plan name, current planned stint (first endLap >= current lap), next planned pit unless final finish, laps until stop, planned fuel/compounds, and compound-specific tire-life constraints. The expanded dialog retains automatic estimates and evidence. After finish the selected strategy remains visible as complete, without a next pit; unavailable lap shows no invented countdown. Mismatch/unknown identity, no selection, or failed selection retrieval leaves the automatic pit estimate in place; the dialog retains explicit mismatch/error guidance. Unload/delete restores the estimate. Timebase rewind recomputes from current lap; planned stops are not falsely marked serviced. Selection refreshes on focus and at bounded interval, never per telemetry frame. Loading does not modify immutable estimate history or measured rates.

### Selected strategy and compound life acceptance

- S1: Loading a matching plan replaces the compact Pit estimate with Race strategy; unloading/deleting restores it. E2E: save/load through real UI/API/SQLite, close the dialog, assert selected panel/name/stop and no automatic panel; reopen/unload and assert automatic panel returns.
- S2: Different/unknown game/car/track or Forza PI never applies the plan. E2E: change native game, car, track, and PI independently, including unavailable/zero native identities; assert automatic estimate returns and restoring an exact match restores the selected display. Expanded dialog explains mismatch. With a real plan selected in SQLite, inject a failed active-plan GET after reload: automatic estimates remain, the dialog shows the request error, and Retry against the restored real endpoint brings back the selection. An unverified/error selection must never replace the estimate.
- S3: Planner and selected display share the same tire projection. For each known compound/wheel with matching identity, compound, tire semantic version, and finite nonnegative measured wear, fresh-tire life is `(1 - thresholdPct / 100) / wearFractionPerLap`; use current game/compound threshold overrides. Project end health and warn at/below cliff/dead, independently of fuel-shortfall warnings. Positive wear yields numeric cliff/dead laps; measured zero means no wear-limited stop, not missing data; unknown compound, missing/incompatible rate/version yields unavailable, never another compound's rate. No automatic stop optimizer is introduced. E2E: controlled owned evidence in a stopped disposable runtime supplies distinct soft/hard rates, a zero-wear wheel, and missing evidence; restart and use real planner/save/load to verify numeric lives, compound changes, warnings, and unavailable states.
- S4: Selected display preserves end-lap boundary, next-stint compounds/fuel, final stint, finish, missing-lap, and rewind semantics. E2E: advance/rewind native packets around saved stop/finish laps and inspect actual selected display; at mobile width verify no horizontal overflow, keyboard entry, and the existing timeline action.

## Observable acceptance / E2E

- R1: From session analysis history, choose a prior owned stint, create multi-stint plan, edit pit laps/fuel/compound, see numerically correct predictions and evidence; manual no-history row explicitly unavailable.
- R2: Save, reload page and restart server; list/reopen/edit/delete plan with no loss; invalid order/range/source mismatch produces 400/404 without altering saved plan. Zero/null fuel/rates, no history and last-lap boundary remain distinct.
- R3: Load saved plan, navigate to real matching live dashboard and observe name/current stint/next pit + remaining laps; load persists across refresh/restart, unload removes it. Actual estimates remain independent.
- R4: Actual different game/car/track/PI or unknown identity yields mismatch warning, never applicable target; lap advancement/rewind/finish computes correct next stop/complete; deletion of loaded plan clears selection. Frozen source evidence survives source deletion and is disclosed as snapshot.
- R5: Real production UI -> authenticated routes -> SQLite -> live display passes desktop/mobile keyboard and no-overflow checks; API failure retains drafts and offers retry, empty lists explain next action.

Coordinator executes real isolated StrategyRuntime + native-source ingestion E2E, extending existing strategy suite. Setup deterministic historical laps, close source via car switch, build/save through UI, restart runtime, load via UI, return matching native car/track, advance/rewind packets, verify real live display and API state, unload/delete. Separate API negative cases validate source identity/order and deletion. Existing unit tests supplement numerical edge cases. No mocks replace production integration; report blocked/unrun scenarios rather than claiming done.

## Review corrections

- R6: A failed save followed by draft edits and Retry submits the current draft and current validation, never the failed render's captured values. Store a retry action identifier instead of a saved render callback. E2E: inject one failed save, edit name/fuel/pit laps, retry through the real API, and assert persisted edited values.
- R7: Draft editing and draft navigation are disabled while a save is pending, including New plan and saved-plan selection. This conservative lock prevents late save responses from replacing a newer draft. E2E: hold a real save request, verify controls cannot change drafts, release it, then verify editing and navigation unlock.
- R8: Switching compatible Forza history sessions preserves known matching PI; choosing source evidence derives missing PI only when compatible with other attached evidence. Different/unknown PI must not silently validate incompatible stints. E2E: create two prior owned sessions with the same car/track/PI, attach multiple stint sources, switch sessions and replace one source, then assert PI/projections/save remain valid. Cover conflicting PI rejection as a supplemental case.

## Verification

Implemented. `playwright/tests/seeded/strategy/race-plan.spec.ts` passes through real F1/FM UDP ingestion, production HTTP routes, SQLite and the browser:

- Select prior owned stint evidence, edit/save a multi-stint plan, disclose source snapshots and numerical fuel/tire warnings.
- Retain the draft on an injected failed save; reject unordered laps and incompatible source identity without mutating the saved plan.
- Reload/restart, reopen and edit, load into the matching live dashboard, then reject an incompatible live game/car.
- Advance through planned stop/final-stint/finish boundaries, rewind, unload and delete; deleting a loaded plan clears selection.
- Delete a source session through the production bulk-delete operation and preserve the plan's frozen evidence.
- Desktop/mobile sizing and keyboard navigation pass; planner captures were inspected.

Backend/shared persistence regressions: 14 passed with `bun test apps/backend/test/live-strategy/race-plan.test.ts apps/backend/test/live-strategy/stint-strategy.test.ts --timeout 60000`. Backend/client typechecks and changed-path lint pass. The test-shard inventory passes with all 402 ordinary tests assigned exactly once.

Browser runner: `playwright/stint-strategy.config.ts`; final saved-plan evidence: `playwright/test-results/race-plan-final`.

### Review-fix verification (2026-10-21)

- R6: A real-app failed POST followed by name, fuel, and pit-lap edits persists the current values through Retry.
- R7: A held real PUT disables draft fields, stint actions, New plan, saved-plan selection, and load/delete/unload actions; successful settlement unlocks editing and navigation.
- R8: Two native Forza sessions with PI 800 remain compatible across history selection. Clearing PI and reselecting matching evidence derives 800; a third session with PI 801 is excluded. The real API persists both matching stint sources and PI 800.
- The existing saved-plan lifecycle scenario passes again, alongside settings, threshold, and dialog scenarios. Backend/client typechecks and changed-path lint pass; 35 threshold/tracker/changelog tests pass.
- Initial R7/R8 test failures were ambiguous `PI` selectors also matching `Pit / finish lap`; exact-label selectors now pass. R6 and historical evidence passed in `playwright/test-results/review-fixes-final`; the four existing scenarios passed in `playwright/test-results/review-existing-final`; corrected R7/R8 passed in `playwright/test-results/review-planner-final`.

Publishing preflight: completed all 117 new messages in each of the 15 non-English catalogs, preserving existing translations and placeholders. Inlang validation/compilation and compiled interpolation pass. Shared theme checks pass (9 tests); refreshed dialog and saved-plan lifecycle scenarios pass with desktop/mobile capture inspection in `playwright/test-results/push-hook-ui-final`. The redundant boolean ternary in the existing browser fixture was removed without changing its predicate.

### Selected strategy and compound-life verification (2026-10-21)

S1–S4 are implemented and verified through four passing real-app scenarios, including the existing saved-plan and timed-plan regressions. The selected matching strategy replaces only the compact estimate display; automatic telemetry calculations/history remain independent and available in the expanded dialog. Compound-specific projections use one shared client helper, current configured thresholds, and matching measured evidence; null/default/unknown compounds never receive invented tire life. See the [UI verification](race-strategy-ui-plan.md#verification--2026-10-21) for commands, numeric cases, artifacts, and initial failed-run explanations.
