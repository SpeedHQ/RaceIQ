# Durable stint strategy — UI implementation plan

Status: implemented and verified. Integrates against the [shared contract](stint-strategy-contract.md); parallel counterpart: [backend plan](stint-strategy-backend-plan.md).

## Goal and ownership

Show durable pit-estimate history, explain prior-session fuel/wear evidence in live strategy, and add session stint averages with side-by-side comparison. Preserve existing dashboard layout, units conventions, and per-game capability distinctions; no general redesign.

UI owns:
- `client/src/components/telemetry/PitEstimate.tsx`, existing `PitWindow` integration, and shared live dashboard consumers across games.
- Session analysis route `client/src/routes/$gameid/sessions/$sessionId/analyse.tsx` → `client/src/components/tunes/review/AnalyseRoute.tsx` → `TrackCarAnalyseReviewPage.tsx` and its existing overview composition. Add scoped stint components there, not to unrelated home recap cards.
- Query hooks alongside existing hooks, Hono RPC calls through `client/src/lib/rpc.ts`, relevant telemetry store/notification handling and unit formatting.
- New user-facing strings in every supported `client/messages/` locale and normal Paraglide generation.
- Browser assertions and desktop/mobile visual evidence in the focused seeded Playwright strategy spec.

Integration owner publishes shared DTOs first. UI may develop using typed contract-conforming fixtures while backend proceeds; fixtures are development-only, never a production fallback. Backend owns storage, metric math, eligibility, source attribution, and API behavior. UI must not recompute stint averages from packet arrays or persist authoritative records in browser storage.

Immutable history consumes the estimate record's frozen game/track/car/PI/compound context, not today's corrected session identity. U1/U7/U9 and E4/E7/E8 verify that advisory evidence refreshes without rewriting saved observations.

## Acceptance mapping

| UI ID | Observable acceptance | Contract / E2E |
|---|---|---|
| U1 | Live shows current strategy plus paginated driver estimate history; view switch/reload/reconnect restores committed records consistently across clients | C1; E1,E7 |
| U2 | Prior evidence is explicitly labeled with per-metric rate/unit, session/stint/lap counts, last observation and evidence links; current-stint takeover updates labels independently | C4,C5; E3,E4 |
| U3 | Session overview table and chart show identical persisted per-stint values, four-wheel/compound availability, counts, lap time, measured fuel use/coverage, and boundary/quality state | C2,C6; E2,E5,E6 |
| U4 | Selecting exactly two stints displays side-by-side metrics and relevant context; missing or incompatible values remain explicit | C3; E2,E9 |
| U5 | Clear applies only to chosen driver's estimate history, preserves stint evidence, and synchronizes clients; loading/empty/errors/degraded persistence are distinguishable | C1,C7; E7,E8,E9 |
| U6 | Actual app integration is accessible, localized, readable on desktop/mobile and proven with backend E2E scenarios, not mock-only screenshots | C8; E1–E9 |

Review-correction acceptance: **U7** renders typed compatibility context and suppresses only the numerical differences disallowed by C6a, explaining unknowns and mismatches (E4/E9); **U8** preserves durable server ordering through epoch resets and resets filtered/all-driver pages after clear-generation invalidation (C7a; E7); **U9** refreshes B's advisory evidence in both mounted browsers when source session A changes, rejects stale revisions without navigation/reconnect, and keeps historical estimate snapshots immutable (C7b; E7/E8). U6's joint verification also covers U7–U9.

## Implementation tasks

1. **Shared client data access.** Add typed RPC hooks for stints, estimate pages, history clear, and target-stint baseline. Query keys include game/session/driver, target `stintId` for baselines, and cursor/filter for history; reset pagination/selection on identity change. Hydrate from server on mount and reconnect. Use `strategy-updated` for session data and `strategy-history-updated` to invalidate every baseline in the affected game/driver namespace, including other sessions. Track the highest observed history revision; discard older responses/live historical values and show provisional current rates or the shared refresh-pending state until fresh data arrives. Reject late responses for an old identity; do not merge another session's data into live strategy.
2. **Historical evidence in live UI.** Extend existing `PitEstimate` rather than add another independent strategy card. Suggested localized wording: “Previous sessions indicate 2.4 L/lap fuel use and 0.8 percentage points/lap front-left tire wear,” with exact contributing counts/context available. Render individual metric sources because fuel can be current-stint while tires remain historical. For same-session prior-stint evidence say “Earlier stints,” not “Previous sessions”; mixed evidence says “Previous sessions and earlier stints.” No history means an explicit gathering-data state; adapter-disabled or unsupported wear is unavailable, not zero.
3. **Recent estimate history.** Add compact expandable history under the current strategy with timestamp, pit-in-laps, projected session pit time when available, limiter, and factual tire/fuel suggestions. Distinguish projected pit timing from service duration. Paginate older entries; do not load the entire ledger on every telemetry frame. Keep historical entries immutable in the display, rather than replacing their saved source with today's baseline.
4. **Session overview stint analysis.** Add a “Stint averages” section in the existing session overview, fetched by session identity. Reuse incumbent table/chart primitives. Table includes stint/lap range, status, boundary confidence, compounds if known, eligible counts, fuel/lap, per-wheel wear/lap, measured fuel used and coverage, and average lap seconds. Chart uses these same server summaries, with fuel and wear on separate labeled scales; never interpolate missing wheel values or plot unlike units as one series. Expose exclusions without overwhelming the primary table.
5. **Side-by-side selection.** Provide accessible row checkboxes and a two-stint comparison panel. Zero selections: no comparison; one: prompt for another; two: show comparison; third selection is disabled with explanation until one is removed. Compare existing summaries rather than call a second aggregation endpoint. Keep comparison scoped to selected session; source-session links allow reviewing historical baseline evidence. Display incompatible compound/configuration context and suppress misleading numerical differences for incompatible units/metrics.
   - Consume required `compatibility` fields rather than infer setup/semantic equivalence. Apply the shared comparison rules per metric; show setup key/PI, semantic-version availability, compounds, and explanatory conditions. Equal unknown setup keys are explicitly uncertain, not confirmed identical setups. Do not suppress valid fuel or other-wheel differences solely because one wheel has an incompatible compound.
6. **Clear and failure UX.** Clear uses explicit confirmation identifying session/driver and explaining that stint averages remain retained. Apply results only after server success; preserve visible records on failed clear with actionable error. Cursor invalidation after clear resets pages/refetches. Storage degradation remains visible even while live telemetry continues. Empty history, unsupported metric, provisional rate, loading, and API failure have distinct states.
   - On `strategy-estimates-cleared`, reset the affected session's filtered and all-driver cursors, then refetch. Do not invalidate reusable evidence or modify saved snapshots. E7 verifies both mounted clients update without reconnect.
7. **Localize and verify.** Add all locale messages, pluralization, timestamps, and percentage-point versus litre formatting through existing conventions. Reuse semantic colors with text labels; keyboard-accessible controls and table alternatives for charts. Execute joint E2E and visual evidence after real backend integration; coordinate one changelog update for the coherent feature.

Implementation integrates the shared `PitEstimate` section into both Driver and Pit Crew modes. `/live` is a layout with an `Outlet`; its index preserves the Driver dashboard and `/live/pit` renders Pit Crew, including saved history when no telemetry is available. History-namespace events refresh persisted stint/history views and the session picker in addition to advisory baselines. Per-metric last-observed timestamps use only that metric's evidence; comparisons require matching game/car/track/driver before metric-specific compatibility checks.

## Edge cases and expected handling

- Fuel from current stint while tire evidence is historical → separate labels/counts; never one global “session” badge. At thresholds two/three update the affected metric only. U2; E3.
- No prior sessions but earlier compatible stints in this session → “Earlier stints”; no references at all → gathering data. U2; E3/E4.
- Valid zero, missing one wheel, snapshot-only wear, fraction fuel, unknown compound → exact units and unavailable reason; no zero substitution or false litres. U2/U3; E2/E4/E5.
- Partial/interrupted stint, inferred boundary, incomplete fuel coverage → explicit status/quality labels; eligible denominator remains visible. U3; E5/E6.
- Different compound/units/semantic version/setup, unknown setup/version, required PI missing, or missing comparison metric → show typed contexts and the shared per-metric exclusion reason instead of misleading differences; conditions are explanatory. Selection transitions remain accessible. U4/U7; E4/E9.
- Rapid session/game/driver navigation, reconnect and delayed requests → identity-scoped queries; no previous-driver flash or stale selection. U1/U5; E1/E5/E7.
- History inserted while paging across epochs, another client clears history with queued writes, new epoch timestamps reset, failed delete, restart with cached values → retain server ordering, reset affected filtered/all-driver cursors, and show only server-authoritative results. U1/U5/U8; E1/E7/E8.
- Source session A is deleted, identity/ownership-corrected, or rebuilt while B remains mounted in two clients → history-namespace event invalidates B without navigation/reconnect; reject delayed old revisions, retain independent current-stint sources, and leave saved estimate snapshots unchanged. U2/U9; E7/E8.
- Mobile widths, long translations, large counts and screen-reader navigation → responsive layout, deliberate overflow for dense tables, chart alternatives and non-color-only provenance. U6; E9.

## End-to-end execution and evidence

The shared contract defines E1–E9 setup, actions, and required observable results. UI owns browser assertions for all those scenarios; backend supplies production-input fixtures, restart/fault controls and hand-computed expected aggregates. Reuse the seeded actual-app Playwright harness, proposed `playwright/tests/seeded/strategy/stint-strategy.spec.ts`, with the backend plan's exact invocation. No mocked HTTP interception in the final integration proof. Typed fixtures only supplement development of loading/error/display states.

Capture the live strategy/history and session overview/comparison on desktop and mobile in one pass, using the same owned server and browser context where valid. Assert exact rate values, units, sample counts, source labels, query errors, selection transitions, clear semantics, evidence navigation, and two-client convergence. Observe screenshots for truncation/overflow and missing/inaccurate source labels; DOM checks alone do not establish visual correctness. E2 compares API/table/chart values against known source deltas, not merely against one another.

## Implementation and verification results

U1–U9 are implemented against the production HTTP/WebSocket boundary. The [backend verification results](stint-strategy-backend-plan.md#implementation-and-verification-results) record the exact integration commands and final source checks. Thirteen unique scenarios have passing evidence across the full and corrected targeted runs; the permanent crash/restart scenario also verifies cold Pit Crew history after SIGKILL.

Verified browser behavior includes pagination beyond 25 estimates, two-client clear/cursor reset, saved-history hydration without telemetry, stale-baseline response rejection, independent historical/current provenance, metric-specific comparison exclusions, preserved measured sides when a difference is unavailable, zero/one/two selection states, and deliberate focusable horizontal overflow on mobile.

Visual review used actual Playwright-produced screenshots:
- [Desktop table and charts](../../playwright/test-results/stint-strategy/stint-strategy-E1-E2-E6-E7-85c4f-ry-across-clear-and-restart-seeded-e2e/stint-table-desktop.png).
- [Mobile table](../../playwright/test-results/stint-strategy/stint-strategy-E1-E2-E6-E7-85c4f-ry-across-clear-and-restart-seeded-e2e/stint-table-mobile.png) and [comparison](../../playwright/test-results/stint-strategy/stint-strategy-E1-E2-E6-E7-85c4f-ry-across-clear-and-restart-seeded-e2e/stint-comparison-mobile.png).
- [Live historical provenance and saved estimates](../../playwright/test-results/stint-strategy/stint-strategy-E3-E4-E7-pe-5849f--when-its-source-is-deleted-seeded-e2e/historical-evidence-desktop.png).
- [Compound/missing-measurement comparison](../../playwright/test-results/stint-strategy/fuel-units-E4-E9-different-54273-ress-only-wheel-differences-seeded-e2e/compound-comparison.png).

The failed managed-browser selector capture was not counted as evidence; the independent Playwright captures above were inspected. No desktop control was used.

Paraglide compilation passed. Message-key validation passed all 16 locales, 2789 keys each; placeholder parity passed. Targeted client lint, Playwright types, and the required root typecheck passed after their relevant changes. `CHANGELOG.md` documents the coherent strategy feature and the listener-only port cleanup fix.

## PR #487 correctness corrections

UI implements A5 in the [shared correction contract](stint-strategy-contract.md#pr-487-correction-acceptance): reconcile removed or game-corrected history selections against successful refreshed session data, preserve valid manual/current-session selections during loading or errors, and reset stale pagination on fallback. Only the incumbent `StrategyHistory` behavior changes; no redesign or DTO change.

The final actual-app suite passed **18/18 scenarios**, including the A5 multi-client regression: select historical session A, page its estimates, delete A through another client's production endpoint, then observe a valid remaining selection and estimates without reload or stale pagination. The current HTTP identity operation cannot change a session's game, so no game-mutation endpoint test was invented. [Execution evidence](../../playwright/test-results/strategy-review-final-e2e.log).

Final Playwright-produced [live history](../../playwright/test-results/stint-strategy-review-final/stint-strategy-E3-E4-E7-pe-5849f--when-its-source-is-deleted-seeded-e2e/historical-evidence-desktop.png) and [mobile comparison](../../playwright/test-results/stint-strategy-review-final/stint-strategy-E1-E2-E6-E7-85c4f-ry-across-clear-and-restart-seeded-e2e/stint-comparison-mobile.png) captures were inspected. Root client/typecheck and Playwright fixture types passed on the final source.
