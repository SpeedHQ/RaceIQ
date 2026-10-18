# Session classification timeline: UI implementation plan

Status: planned only; not implemented or tested.

Boundary: [shared contract, TL acceptance and E2E scenarios](session-classification-timeline-contract.md). Counterpart: [backend plan](session-classification-timeline-backend-plan.md). Decision: [ADR 0011](../adr/0011-valid-non-pace-laps.md). Related scope: [classification UI plan](valid-non-pace-laps-ui-plan.md).

## Goal and design direction

Help a driver reviewing an expanded Sessions row understand what happened during recorded laps, without confusing lap representativeness with validity or native race events. Preserve RaceIQ's existing compact, flat, theme-token-driven presentation. This is a localized Operate-mode extension, not a Sessions redesign, new elapsed-time chart, or replacement race-result model.

Use one **Session timeline** panel with **Recorded laps** and **Race events** lanes. Lap items identify the stored lap, category and validity; native events retain their richer evidence. Each lane has independent data/loading/error presentation. Use text and existing semantic styling, not color alone. Preserve native event content and the surrounding lap table, selection, exports, best calculations, and session toolbar.

## Ownership and files

- New `client/src/components/sessions/SessionTimeline.tsx` and a narrowly scoped lap-lane/model module if needed; no generic timeline framework.
- `SessionDesktopTable.tsx`, `SessionMobileList.tsx`, `SessionsPage.tsx` in the same directory: composition and forwarding existing query state.
- `client/src/components/race-results/RaceResultLedger.tsx`: preserve native event builder/rendering; distinguish its section as Race events inside the composition. Do not duplicate the native renderer.
- `client/src/hooks/useWebSocket.ts`: complete existing reconnect query invalidation; retain normal classification/native-event notification contracts.
- `client/messages/*.json`: add category labels and timeline states in all 12 supported locales. Current classification-migration strings are not lap-category labels.
- Existing `client/test/race-result-ledger.test.ts`, a focused new lap-lane behavior suite, and the targeted seeded Playwright scenarios in the shared contract.

Backend/shared-type edits belong to the backend owner. UI may develop against the agreed `LapMeta` extension and typed fixtures in parallel; production must use actual query data, not fixture fallback.

## Implementation tasks

1. Add composition to both expanded table variants. Reuse `lapsBySession` and the page's existing `useLaps()` request, forwarding whether data is initially unavailable, ready, or failed with cached data. Do not introduce per-session inventory requests. Render lap content regardless of native result support, including practice/MoTeC/unknown sessions. References TL-01/05/08; TL-E01/02/06.
2. Implement the contract's immutable ordering and local pagination. Keep every lap ID; preserve repeated numbers. Source-offset order is available only for a complete unique set; otherwise show the explicit unavailable-order state and stable fallback. Timeline order must not follow table time/sector/name sorting. Cap rendered items at 100 per page, preserve page on metadata updates, clamp after deletions, and label visible range/total. References TL-01/04/07; TL-E01/03/04.
3. Add primary category labels, including Unclassified for null/omitted legacy values, and independent validity/reason text. Keep experiment exclusion and removed-telemetry state distinct from category. Use existing time formatting/unavailable treatment for bad timing; never size segments by lap time. Do not restore first-lap heuristics or filter by pace eligibility. References TL-01/02; TL-E01/03/05.
4. Reuse existing session/lap replay navigation and telemetry-availability rules for inspection. Use semantic controls, stable ID keys, visible keyboard focus, and descriptive accessible labels. Avoid row-click propagation that collapses the session. A non-pace/invalid lap remains inspectable; unavailable telemetry retains a disabled action and explanation. References TL-02/07; TL-E05/08.
5. Keep native event sequence/details/practice suppression unchanged and do not manufacture pit stops, caution events or grid positions from category. Give native-only, lap-only and both-empty sessions accurate presentation. Failed or held requests affect only their own lane; stale cached metadata gets a warning instead of disappearing or implying freshness. Existing fail-closed auth remains authoritative. References TL-03/05; TL-E02/06.
6. Verify existing classification-commit invalidations update the lap lane from REST metadata. Add session-result invalidation on socket open/reconnect to recover missed native updates; preserve `race-result-reconciled` handling. Do not rebuild native results on every category update. Keep expansion and surviving focus stable. References TL-06; TL-E07.
7. Add translated copy in all locales and bounded responsive layout using incumbent typography/theme roles. Keep horizontal lane scrolling inside the row, with accessible pagination; no whole-page overflow or new decorative palette. Preserve desktop/mobile semantic parity. References TL-07; TL-E04/08.

## Acceptance, edge handling and verification

This plan adopts TL-01 through TL-08 and the exact handling/E2E definitions in the [shared contract](session-classification-timeline-contract.md#observable-acceptance); do not copy or redefine API/category rules here. Unknown categories remain visibly unclassified, missing offsets remain uncertain, invalid laps remain present, native-result failure does not hide lap data, and query errors do not bypass authentication.

Integration owner runs TL-E01–08 through the real application and backend after both implementations are integrated. UI completion depends on that production integration evidence, not component fixtures. Extend the existing seeded suite rather than adding a second runner:

```sh
cd playwright
E2E_SERVER_MODE=dev PW_SERVER_SET=seeded bunx playwright test --project=seeded-e2e tests/seeded/sessions/classification-timeline.spec.ts tests/seeded/sessions/classification-migration.spec.ts
bunx tsc --project tsconfig.json --noEmit
```

Supplement with targeted pure tests for consumer-visible ordering, null/validity independence, page boundaries and immutable input behavior, plus the existing native-ledger regression suite. Do not add source-text/wiring snapshots. Run root `bun run typecheck` and `bun run lint` after integration. At verification time, run the required Impeccable detector once on changed UI targets; batch actual desktop/mobile/long-copy visual and keyboard inspection, fix observed defects together, then confirm changed paths. No Storybook startup or UI implementation is part of this planning request.

Record exact commands, fixtures, outcomes and screenshots by TL ID after implementation; no tests for this extension have run. Update maintained docs/changelog once after real behavior is verified. Do not mark the extension complete until shared edge cases have passing E2E evidence or explicit unresolved blockers are reported.
