# Race strategy builder and live loading

Contract: [shared race strategy boundary](race-strategy-contract.md), paired [backend plan](race-strategy-backend-plan.md).

Owner: UI worker. Own new client/src/hooks/race-plans.ts, new components/telemetry/RaceStrategyPlanner.tsx and LiveRaceStrategy.tsx, session-analysis entry in components/tunes/review/StrategyStints.tsx, race_plan_* localization messages and focused strategy E2E. Coordinator owns final integration into PitEstimate.tsx / PitEstimateDialog.tsx after current dialog worker settles, using your exported component API. Do not concurrently edit dialog files.

Tasks: (1) History/session/stint selector using existing useSessions/useStrategyStints, limit evidence choices to exact owned game/car/track/PI compatible sources. Offline analysis entry always available. (2) Editable named race length, notes, ordered planned stints/pit laps, starting fuel and compounds; history snapshots/counts and numerical fuel/fresh-tire health prediction with unavailable/zero/threshold warnings. (3) Typed real API save/open/edit/delete/load/unload and retained drafts on errors; initial local fixtures allowed only during development, never production fallback. (4) Compact loaded-plan widget with exact live identity applicability and current lap semantics; expose planner button and selected-plan summary. (5) Coordinator integrates same planner within expanded pit dialog without nested modal collisions.

Edge handling from shared contract applies: no history -> explicit manual mode/unavailable projections, source switch updates compound/unit/context not leaked drafts, tank fractions displayed as percent but stored fractions, invalid endLap/fuel disables save with actionable validation, delete loaded clears display, source deleted snapshot still disclosed, mismatch never shown as applicable, rewind recomputes and finish has no next pit. R1–R5.

E2E coordinator owns execution. Reuse StrategyRuntime/native-source and existing strategy suite; build plan from prior real session via analysis entry, save/reopen/restart/load to matching live source, then exercise mismatch/advance/rewind/finish/unload/delete and mobile keyboard/no-overflow. Add focused deterministic cases as needed, do not run tests/build/lint/formatters mid-flight. Component/mocked checks never replace real integration.

## Outcome

Implemented in session analysis and the expanded pit-estimate dialog, with a compact live loaded-plan panel. History-backed planning, failed-save retention, restart/edit/load, mismatch and lap-boundary behavior pass real integration checks; see [contract verification](race-strategy-contract.md#verification).

Review corrections [R6–R8](race-strategy-contract.md#review-corrections) are implemented and verified: current-draft retry, pending-save control locking, and compatible Forza PI preservation/derivation. Real-app failure injection, held requests, matching/conflicting history, and the existing saved-plan lifecycle pass; see the [review-fix verification](race-strategy-contract.md#review-fix-verification-2026-10-21).
