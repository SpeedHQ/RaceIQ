# Spectate line score UI

[Shared contract](spectate-line-score-contract.md); [backend plan](spectate-line-score-backend-plan.md).

Own Spectate widget/view and `client/src/hooks/laps.ts`, with labels in every supported message locale. Fetch comparison endpoint only for active Spectate pair via typed Hono RPC. Cache by game and both lap IDs. Render compact theme-token card top-right of scene, percentage and mean spread. Use existing severity colors. Do not subscribe to replay frames for a lap-wide score.

Acceptance: S1–S3, S5, S6, S7 in shared contract. Loading, null and errors show unavailable value; pair changes must not reuse prior data. Panel open/closed and mobile remain contained. All scores come from the shared backend computation, with no client-specific formula. Contract fixtures may supplement integration verification.

Verification: main agent exercises actual Compare → Spectate using real endpoint, switches pair, tests error/null states, and inspects desktop/mobile with panel toggles per contract. Verify F1 laps 11/10 render the corrected shared result and compare Session Review endpoint output. Compile translations and run root typecheck after edits. Record executed outcomes and any limitations in delivery.
