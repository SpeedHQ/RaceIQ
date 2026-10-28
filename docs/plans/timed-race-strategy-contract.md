# Timed race strategy contract

Plans: [UI](timed-race-strategy-ui-plan.md), [backend](timed-race-strategy-backend-plan.md). Existing identity, evidence, authentication, CRUD errors, ordering, and save-lock contracts remain authoritative in [race strategies](race-strategy-contract.md). Coordinator owns this contract and integration verification. Decisions below are resolved from the user's choice to save timed strategies and to enter either laps or race time.

## Boundary

Extend existing `RacePlanInput`/`RacePlan` JSON with `raceLength?: RacePlanLength`, where `RacePlanLength = { mode: "laps" } | { mode: "time"; durationSeconds: number; averageLapSeconds: number }`. Omission is accepted only as the existing lap-based representation; normalize stored/read responses to `{mode:"laps"}`. No new endpoints or database columns: existing JSON payload persists the new object. Existing plans remain readable without rewriting unrelated history.

Time values must be finite and strictly positive. Duration is at most 604800 seconds; average lap time at most 86400 seconds. `totalLaps` in time mode must equal `ceil(durationSeconds / averageLapSeconds)` and remain within the existing 1–10000 limit. Export `estimateRaceLaps(durationSeconds, averageLapSeconds): number | null` from the shared race-plan module; return null for invalid inputs or out-of-range results. Existing ordered-stop/final-stint validation remains unchanged. Server rejects inconsistent timed inputs with the existing 400 INVALID_RACE_PLAN response and never mutates a saved plan on rejection.

Example added field for a 30-minute race at 90 seconds/lap: `"raceLength":{"mode":"time","durationSeconds":1800,"averageLapSeconds":90}`, with `totalLaps:20` and final stint `endLap:20`. A 1801-second race estimates 21 laps. These are estimates, excluding service time and simulator-specific extra-lap rules, not guaranteed finish laps.

## UI and calculations

Choose Laps or Race time in the existing strategy planner inside the dialog and session analysis. Laps preserves current behavior. Time mode accepts duration in minutes and shows the estimated lap count and lap-time basis. Prefer the first attached compatible evidence stint with positive `averageLapSeconds` and `paceLaps`; otherwise use an average of valid pace laps from the matching current live session. An explicitly editable positive lap-time field permits planning without recorded pace; do not silently invent a default. Save the chosen lap-time snapshot, not an unstable live reference; reopening a timed plan restores its saved basis until the user changes it.

Changing duration/pace updates total laps and the final stint end only. Retain earlier pit stops; out-of-range stops remain visibly invalid and block saving rather than being dropped or reordered. Missing/invalid duration or pace shows unavailable estimates and blocks timed saves. Switching to lap mode removes timed requirements without changing manual lap semantics. New/load/save-pending/error behavior follows the existing contract.

For each selected stint, required fuel equals its compatible measured fuel rate times planned laps, using existing fuel units and evidence eligibility checks. At each pit stop, fuel to add equals `max(0, nextStintRequiredFuel - previousStintEndFuel)` when both values are known and previous end fuel is nonnegative. Unknown rates/start fuel or an unreachable stop yields unavailable refuel advice; existing insufficient-fuel warning remains visible. Zero consumption and zero refuel are valid, distinct from unavailable. No invented tank capacity, reserve, refueling permission, or service duration. Starting fuel remains total fuel aboard, not fuel added.

## Acceptance and E2E scenarios

- T1: Mode choice, measured-pace initialization, duration conversion, explicit lap-time basis, and lap-mode parity. E1: ingest known native historical laps with existing StrategyRuntime; open real planner, attach prior owned stint, choose time, enter 30 minutes, assert estimated laps from recorded pace; change pace to 90 seconds and assert 20 laps; use 30.01 minutes and assert 21; switch back to laps and edit total laps.
- T2: Save/reopen/restart retains mode, duration, pace, stops, and predictions; old lap plans still load. E2: save E1 through authenticated production API/SQLite, restart runtime, reopen through UI, inspect actual API response and inputs; create an old-shape lap plan through API and confirm it opens in laps mode.
- T3: Per-stint fuel required and per-stop fuel to add use measured compatible rates and carried fuel, including zero/unavailable. E3: use E1's measured rate, two known ordered stints, and known starting fuel; assert exact required fuel and carry-adjusted refill. Set first starting fuel unknown, then insufficient, and assert unavailable refill plus existing shortfall warning; preserve valid zero refill. Verify both liters and tank-fraction units with deterministic API-owned evidence where supported by existing native fixtures.
- T4: Invalid data never silently changes or saves stops; rejected requests preserve saved data. E4: enter zero/blank pace, nonpositive duration, oversized lap estimate, and earlier stop beyond shortened finish; assert blocked UI save and retained stop. Send inconsistent duration/laps, invalid values, or unordered stops to real API; assert 400 and unchanged saved plan. Test exact-boundary and partial-lap rounding, zero/null rates, mode switches, and save-pending locks.
- T5: Real dialog entry, fixed header, desktop/mobile no overflow, accessible labeled controls. E5: open real live strategy dialog, expand planner, exercise mode controls using keyboard at desktop and 390px widths; verify real persistence rather than mocked production fallbacks.

Coordinator extends and executes `playwright/tests/seeded/strategy/race-plan.spec.ts` with `playwright/stint-strategy.config.ts` and its existing isolated native ingestion/runtime. Unit and backend integration tests supplement E1–E5, never replace the browser/API/SQLite path. Record passing, failing, blocked, and unexecuted outcomes in both plans before claiming completion.

## Integration outcome — 2026-10-21

E1–E5 passed in `T1-T5 saves a timed race, derives fuel at selected stops, and retains invalid draft edits`, including real native ingestion, UI/API/SQLite persistence, backend restart, liters and tank fractions, zero/null fuel, unknown starting fuel, unreachable stops, invalid duration/pace/lap bounds, rejected unordered updates, legacy plans, and mobile keyboard/header behavior. Evidence: [timed acceptance artifacts](../../playwright/test-results/timed-strategy-acceptance/).

Existing R1–R8 lifecycle, identity, retry, save-lock, and Forza compatibility scenarios passed in four additional tests: [lifecycle artifacts](../../playwright/test-results/timed-strategy-lifecycle/). Both implementation plans record supporting checks and the capture-worker timeout limitation from the full backend run.
