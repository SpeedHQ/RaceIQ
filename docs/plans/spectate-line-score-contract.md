# Spectate line score contract

Implementation: [UI plan](spectate-line-score-ui-plan.md), [backend plan](spectate-line-score-backend-plan.md).

## Boundary

`GET /api/laps/compare-line-spread?gameId=acc&lapIds=1,2` returns the existing compact `LineSpreadTrace` response shape used by `/api/laps/review-line-spread`, or JSON `null` if either lap lacks usable position telemetry. `gameId` is a required registered game ID; `lapIds` contains exactly two distinct positive integer IDs. IDs may span sessions, but must share game and track. Invalid query, missing laps, or mismatched game/track returns HTTP 400 with `{ error: string }`. Existing local-app authentication remains unchanged. No pagination; request ordering preserved. No database writes.

For a valid result, `consistencyScore: number` is the integer 0–100 score from the shared `computeLineSpreadTrace`; `overallSpreadM: number` is mean spread in metres; `lapCount: number` is 2. Compare, Session Analysis, experiment evidence, and experiment outcome metrics use this function. Signed nearest-polyline offsets preserve opposite sides of the mean line, avoiding cancellation. Two laps retain their full separation; larger pools use p10–p90 width. The existing 5-metre full-scale mapping remains shared. No surface-specific scoring formulas.

## Acceptance and integration verification

- S1: Compare → Spectate displays a compact top-right Line similarity score for the current pair, matching the authoritative calculation. E2E: open a stored same-track pair, enter Spectate, compare displayed score to real endpoint response.
- S2: Pair changes use new results, never previous-pair values. E2E: navigate to another pair and verify request IDs and display.
- S3: Missing telemetry and request errors show an unavailable value, not 0 or 100. E2E: use controlled incomplete stored telemetry; separately force transport failure and observe unavailable state.
- S4: Cross-session same-track pairs work; malformed IDs and mismatched tracks/games are rejected. E2E: invoke real app endpoint with stored compatible and incompatible lap IDs; assert JSON/status.
- S5: Desktop and narrow layouts keep widget inside scene without blocking playback controls. E2E: inspect actual Spectate surface at desktop and mobile widths, including telemetry panel toggled.
- S6: Parallel lines separated by 2m measure 2m and score 60, not 100; swapping laps preserves score. Regression tests cover these boundaries, identical lines, longitudinal desynchronization, and multi-lap signed width. Real E2E: F1 laps 11/10 must show the corrected endpoint result rather than the reported 99%.
- S7: Experiment outcomes use the same computation as Compare and Session Analysis. Run experiment metric tests plus real Session Review endpoint for the same pair and verify score equality.

Verification owner: main agent; existing runnable app and browser automation, plus focused route tests and repository typecheck. Fixtures may control failure paths but must not replace successful real UI/backend integration.
