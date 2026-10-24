# LMU opponent cold-load UI plan

Status: implementation changes are present, but acceptance remains incomplete. E7/E9 have not passed; shared results and source blocker are recorded in the [contract](lmu-opponent-cold-load-contract.md#execution-evidence--2026-10-24).

Shared boundary: [contract](lmu-opponent-cold-load-contract.md). Acceptance OP1–OP9, exact readiness values, endpoints, errors, polling, and shared E1–E9 definitions live there. Backend implementation: [backend plan](lmu-opponent-cold-load-backend-plan.md).

## Ownership and parallel work

UI owner owns `client/src/hooks/opponents.ts`, `client/src/components/comparison/LapComparison.tsx`, affected sessions-page opponent picker consumers, and opponent replay loading/error presentation in `packages/lap-replay/ui/SpectateSession.tsx`. Inspect existing host contracts and package boundaries before changing shared consumers. Update existing localization sources and affected browser scenarios using repository conventions.

Also own queued/processing opening presentation in `packages/sessions-page/ui/SessionLapTable.tsx`, session-row/expansion/navigation components located through existing handlers, relevant host adapters/contracts, and session/lap detail route guards. Consume backend-owned processing DTOs rather than calculating readiness from row age, spinner state, or one catalog request per row.

Backend integration owner owns shared opponent DTOs/error exports and publishes the contract-conforming fixtures first. After that shared prerequisite, UI work can proceed against fixtures while backend work proceeds independently. Fixtures are development/test inputs only; production always calls existing real endpoints. Do not wait for worker implementation to build state presentation. Final integrated E2E execution remains backend integration owner's responsibility with UI support.

## Implementation tasks

### U1 — Catalog states and eligibility (OP4, OP6)

Consume required `indexState` independently of native `opponentAvailability`. Distinguish waiting-finalization, queued, building, ready, failed, and not-required exactly as contracted. Keep native removed/not-recorded/missing/corrupt messages accurate. A ready catalog with no opponents gets the existing genuine empty result; queued/building never masquerades as empty or unavailable native data.

Disable selection/comparison/replay until ready; preserve normal player-versus-player behavior. Show clear preparation text without a fake percentage or pretending preparation is instant. Waiting-finalization explains that indexing starts after recording ends. Use current localization/accessibility patterns; status changes should be visible without stealing focus.

Launch-seeded laps use the same readiness states and real routes; there is no seed-only fallback or client-triggered preparation. Completed eligible seed preparation should already be ready on first visit. If recording deferred launch preparation, show queued/preparing state rather than an empty catalog or a false ready indicator (OP7, E8).

Launch preparation may explicitly finish with pending admission, as defined by the shared private lifecycle boundary. The UI still consumes the same queued status and never interprets seed-process exit as opponent readiness; E8/E9 cover this transition.

### U2 — Bounded polling and lifecycle updates (OP5, OP6)

Poll catalog every two seconds only for queued/building while the relevant surface is mounted and visible. Stop on terminal state, hidden surface, navigation, or unmount. Reuse existing query/lifecycle infrastructure; recording finalization invalidates waiting-finalization status. No active-recording polling, new job-start route, client-side session scan, or browser-started index build.

A failed state exposes error and status refresh, not an implicit processing retry. Refresh only reads backend state. Avoid duplicate timers between shared consumers and ensure obsolete request results cannot overwrite a new player-lap/source selection.

### U3 — Comparison/replay transitions (OP2–OP4, OP6)

Handle `OPPONENT_INDEX_NOT_READY` and `OPPONENT_INDEX_FAILED` using existing typed query errors. Refresh catalog state on readiness errors. Preserve source-changed/removal/unavailable precedence and clear opponent references tied to an old source revision. Never render stale traces or start playback from a previous selection while preparation or invalidation is active.

Keep existing comparison request shapes, range limits, replay decoder, and full-cadence consumer model. Once ready, selection calls actual comparison/replay routes and renders real results. No fabricated timing values, sampled playback, fake fallback, or unrelated player replay rewrite.

The contract's [private index boundary](lmu-opponent-cold-load-contract.md#private-index-boundary-version-1) shards stored observations by identity without changing HTTP payloads. E2/E3 must prove that selected loading still renders the same full-cadence samples and context through the existing decoder.

### U4 — Focused UI verification (OP2, OP4, OP6)

Extend existing LMU comparison/browser scenarios for every readiness state and transition. Contract fixtures can test isolated rendering but cannot prove production integration or performance. Share selectors and helpers with current browser suite instead of creating a second harness.

### U5 — Disable queued/processing session and lap opening (OP8, OP9)

Keep affected sessions/laps visible with a spinner and the contracted queued or processing label. Gate session expansion/detail navigation and lap detail/replay/comparison across mouse, keyboard, context menus, and route loaders. Set accessible busy/disabled semantics; do not rely on opacity or pointer-event CSS alone. Keep ready neighbors and unrelated actions available. Required metadata fetches show a loading shell, never optimistic ready content.

Use authoritative processing metadata for both queued and running work, including seed/import/rebuild and shared-source dependencies. Direct/bookmarked routes render status shells before requesting heavy data. Handle pending/failure backend responses without stale content. Failed preparation stops the spinner and shows error with applicable existing recovery/status-refresh behavior; no endless busy state. On ready, remove spinner and re-enable opening without full reload or automatic navigation.

Use existing lifecycle/query invalidation plus shared visible pending polling, not timers or catalog calls per row. Stop polling on terminal state/unmount/navigation; queued work deferred by recording stays visibly queued without starting indexing. Preserve live-recording access outside this post-processing scope. Extend existing sessions-page navigation and comparison/browser scenarios for E9.

Track lap management consumes `TrackLap.processing` directly from its all-laps response, rather than joining the limited global lap list. E9 covers older history outside the latest 200 laps, blocked neighbors, and unchanged non-opening actions.

Chat opening links consume processing from their existing linked-lap summaries. One shared visible pending chat-list query restores ready links without reload; missing/deleted references do not spin forever. E9 covers older links outside the global lap-list limit.

## Acceptance and edge handling

- OP6: Correct waiting/preparing/failed/native-unavailable/ready-empty/ready-populated presentation and accessible disabled actions. E1/E5/E7 cover real transitions.
- OP6/OP5: Hidden/unmounted surfaces and terminal states stop polling; active recording does not poll or trigger indexing. E1/E7 cover navigation, visibility, lifecycle invalidation, and a second recording delaying preparation.
- OP4/OP6: Readiness errors, source revision changes, removal, and stale network responses cannot retain an incompatible selection or stale trace. E4/E6/E7 cover invalidation and recovery.
- OP2/OP3: Ready selected comparison/replay retains exact values and native cadence and meets shared real-browser target. E2/E3 cover selected interval and actual rendered/playable surface; UI does not redefine backend performance criteria.
- OP7/OP6: Fresh launch seed, repeat launch, and repaired existing-seed publication appear correctly on first visit without requesting a native scan. E8 verifies real launch -> seed -> publication -> browser selection, including recording-deferred preparation.
- OP8/OP9: Both queued and running sessions/laps block every opening path with accessible spinners and accurate labels; direct links show status shells; failure stops spinning; ready restores access; unrelated rows remain usable. E9 proves real backend/UI behavior.

## Verification and completion dependency

Support backend integration owner executing shared E1–E9 against the real backend. In E7, drive actual recording/finalization and controlled worker states rather than intercepting production endpoints; verify pending text, selection availability, request cadence, polling cessation, stale-selection clearing, and ready playback/comparison. E8 additionally exercises the actual launch seed path and first seeded opponent selection after backend restart. E9 exercises session and lap row opening gates plus direct-link shells for queued/running/failure/ready states. Use deterministic backend barriers/test clocks for race setup where existing harness permits.

In E2, measure from user action through network, JSON/production decoding, preparation, and visible comparison/playable replay readiness. Repeat after backend restart separately for catalog/comparison/replay; report preparation delay separately, not as hidden work. Observe actual scene/instruments and timing deltas, not just successful HTTP status. Backend owner supplies source/block-read evidence and matched own-lap timing.

Run affected UI/replay compiler gates and existing browser scenarios after integration. Record scenario IDs, outcomes, timing evidence, and any unavailable environment or target failure. No completion claim from fixtures, isolated component checks, planned/skipped E2E, or successful warm cache alone. No implementation is authorized by creating these planning artifacts.
