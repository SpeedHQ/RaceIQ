# Session classification timeline: integration contract

Status: planned; no implementation or verification performed for this extension. Boundary choices below are resolved from the existing lap-classification requirements and current Sessions data flow. Implementation requires approval of the linked plans; this is not architectural acceptance.

- [UI implementation plan](session-classification-timeline-ui-plan.md)
- [Backend implementation plan](session-classification-timeline-backend-plan.md)
- [Classification requirements](valid-non-pace-laps.md#evidence-and-detection-rules)
- [Existing classification contract](valid-non-pace-laps-contract.md)
- [ADR 0011](../adr/0011-valid-non-pace-laps.md)

## Scope and ownership

The expanded desktop/mobile Sessions row becomes one session timeline with two complementary lanes: **Recorded laps** and **Race events**. Recorded laps use persisted lap classification; race events retain their native qualifying/start/pit/penalty/position/finish evidence. Lanes are not a synchronized elapsed-time axis. Neither lap numbers nor category labels establish exact event timestamps or prove a pit stop occurred.

No new table, migration, endpoint, detector, backfill, classification value, or race-event persistence change. Backend owns the shared metadata projection and contract. UI owns composition, presentation, local ordering/pagination, and query invalidation. Integration owner owns E2E fixtures, execution, and evidence. Once this boundary is approved, both implementations can proceed independently; UI may use typed contract fixtures during development, never production fallbacks.

Current code: `SessionsPage.tsx` already loads `useLaps()` and groups inventory by session; both table variants already hold those rows. `RaceResultLedger.tsx` separately calls `useSessionResult()`. `StoredLapMetaRow` already contains `rawByteOffset`, but `toLapMeta()` removes it from the public representation. Expose that existing ordering evidence instead of guessing chronology from lap number, insertion time, or table sort.

## Existing HTTP operations, additive metadata

Reuse `GET /api/laps?gameId=<GameId>` through `useLaps()`, and `GET /api/sessions/:id/result?gameId=<GameId>` through `useSessionResult()`. Their existing authentication, ownership/game scoping, errors, and race-result response semantics remain authoritative. No additional request parameters or server pagination are introduced. Current inventory ordering is not a public chronology guarantee.

Extend `LapMeta` in `shared/racing/sessions/types.ts` with `rawByteOffset?: number | null`, consistent with optional capture metadata elsewhere. Current inventory/session/explicit-ID metadata responses must include the field as a nonnegative safe integer or `null`; normalize absent or malformed stored offsets to `null` without changing storage. Other older/in-flight payloads may omit it; omission has the same presentation meaning as `null`. Zero is a valid offset. Do not expose `rawFile` or a source path.

Required existing fields remain unchanged: `id`, `sessionId`, `lapNumber`, `lapTime`, `isValid`, `classification`, and `createdAt`; retain `invalidReason` and `telemetryAvailable`. Classification meanings and precedence belong to the linked classification requirements, not this extension.

Representative metadata fragment (remaining `LapMeta` fields omitted here only):

```json
{
  "id": 42,
  "sessionId": 7,
  "lapNumber": 1,
  "lapTime": 97.25,
  "classification": "caution",
  "isValid": false,
  "invalidReason": "game reported invalid",
  "rawByteOffset": 120000,
  "telemetryAvailable": true
}
```

This is an invalid caution lap, not an invalidity category or permission to discard the row. `classification: null` displays **Unclassified**, never confirmed Pace or successful migration.

## UI boundary and deterministic presentation

Introduce `SessionTimeline` in `client/src/components/sessions/`, composing the existing native `RaceResultLedger` and a lap-classification lane. Both desktop and mobile callers switch to this composition; retain `RaceResultLedger` as the single native-event renderer rather than cloning it.

Pass `sessionId`, `gameId`, `enabled`, and the existing session lap query state. Model lap state explicitly as `loading | ready | error`, with `readonly LapMeta[] | undefined`: `undefined` means no successful inventory yet, while `[]` means a known empty inventory. Cached rows remain available on refetch failure. Keep one shared inventory query; no per-session lap fetch or raw telemetry decode for rendering. Native-result state remains independent.

- Include every persisted lap in this session, including invalid, non-pace, excluded, unclassified, incomplete, and telemetry-removed rows. Do not use pace eligibility as an inventory filter.
- If every offset is usable and unique within the session, sort a copy by `rawByteOffset` ascending. Otherwise use stable lap-ID order and display **Recording order unavailable** for the lane; do not imply this fallback is physical chronology. Never key or deduplicate by lap number. Display the original lap number, including repeats/restarts.
- One item per lap: number, translated primary classification, independent validity/reason, and existing lap-time formatting. Do not synthesize secondary categories that were suppressed by primary-category precedence.
- Use ordinal, equal-width items, not duration-proportional geometry. Invalid/nonfinite/nonpositive times use the existing unavailable-time presentation, without hiding the item or producing invalid CSS geometry.
- Show at most 100 lap items per local page, with translated previous/next controls and visible range/total. Pagination changes only rendered items, not inventory or event data. Clamp the page after deletions; preserve it for metadata-only updates. No contiguous-lap grouping that hides invalidity or identity.
- Reuse existing replay navigation for available telemetry; native buttons/links support keyboard activation. Removed telemetry keeps metadata visible with a disabled inspection action and explanation. Do not collapse the expanded session when interacting with its timeline.
- Race-event sequence, provenance, values, practice-session position suppression, and missing-result handling remain unchanged. A pit lap and a native pit-stop event may both appear, under distinct lane labels; never convert one into the other or infer duration/service/fuel/positions from classification.
- A missing/loading/failed native result cannot suppress recorded laps. A failed lap query cannot suppress available native events. Fresh empty, cached-error, loading, and no-data states must be distinguishable. The existing global fail-closed auth boundary still takes precedence over cached content.

## Refresh and transitions

Use existing `lap-reprocessed` notifications for classification commits: invalidate the shared lap/session queries and let new metadata update the same expanded row in place. `classification-migration-status` remains progress, not the lap payload. On WebSocket open/reconnect, refresh laps/sessions **and** session-result queries to recover missed native-event notifications. Existing `race-result-reconciled` handling remains authoritative for race-event updates. Do not invalidate/rebuild race results merely because a lap category changes.

Preserve expansion and focus across metadata refetches, key items by lap ID, and never reset `null` to Pace while data is pending. No new socket event, mutation endpoint, fake success state, or polling loop.

## Observable acceptance

| ID | Required observation | E2E |
| --- | --- | --- |
| TL-01 | Every persisted session lap is represented exactly once across pages with its original number/category; null is Unclassified. | TL-E01, TL-E04 |
| TL-02 | Category, validity/reason, exclusion and raw-telemetry availability remain independent; non-pace inspection works when available. | TL-E01, TL-E05 |
| TL-03 | Native event values/order remain intact; categories create no race events or event facts. | TL-E02 |
| TL-04 | Source offsets determine order when complete/unique; repeats, restarts and unavailable order are handled without guessing chronology. | TL-E01, TL-E03 |
| TL-05 | Empty/loading/error/partial/cached states do not incorrectly erase the other lane or fabricate success. | TL-E02, TL-E06 |
| TL-06 | Real classification commit, native-event update and missed-event reconnect refresh the open timeline without collapse or reload. | TL-E07 |
| TL-07 | Desktop/mobile, keyboard, status text, translated long copy and bounded rendering remain usable. | TL-E04, TL-E05, TL-E08 |
| TL-08 | Existing read operations expose correct nullable ordering metadata under existing access controls; no DB content or raw bytes change from timeline reads. | TL-E01, TL-E03, TL-E05 |

## Edge handling and shared E2E strategy

Extend the existing seeded Playwright suite and owned upgrade-browser harness. Add `playwright/tests/seeded/sessions/classification-timeline.spec.ts`; extend `classification-migration.spec.ts` for the actual classification-commit path. Use isolated app/DB instances with controlled persisted metadata and native event fixtures; they test consumption, not detector correctness. The migration scenario uses the real ACC capture/parser/backfill. Never fulfill successful HTTP/WS requests with fixture responses.

For lane-specific loading/error coverage, extend only the owned test transport harness with hold/release/connection-close controls for the existing lap/result requests. Successful responses must pass through the real app and DB unchanged; auth traffic remains unaffected. This creates a real transport fault, not a fake API implementation or production fallback. Restore controls in `finally` and clean owned data/processes.

| Scenario | Setup → action → observable result / affected edges |
| --- | --- |
| TL-E01: metadata and categories | Seed capture-backed rows containing each category, null, valid/non-pace, invalid/caution, manually excluded pace, repeated/reset lap numbers, and IDs/timestamps deliberately inconsistent with unique offsets. Open the real Sessions route and expand the target session. Inspect actual lap responses and rendered items: IDs/category/validity are preserved, all rows remain, order follows offsets, best-lap/table sorting does not reorder the lane; native/other-session rows cannot leak in. Snapshot DB content/raw hashes before and after read-only navigation. Covers TL-01/02/04/08. |
| TL-E02: independent native evidence | Seed native qualifying/start/pit/penalty/position/finish facts, plus practice and no-result sessions. Expand each: all native values and practice position suppression match the existing ledger; pit/caution/grid categories without native events create none; lap lane still renders when the existing result operation reports unavailable/missing. Covers TL-03/05. |
| TL-E03: ordering boundaries | Use offset zero, null/absent offsets, negative/unsafe stored offsets, equal offsets, and repeated lap numbers. Read real metadata: safe values retained, invalid/missing values normalized to null. Open timeline: complete unique offsets sort correctly; otherwise stable ID fallback has explicit order-unavailable text and no deduplication. Covers TL-04/08. |
| TL-E04: large and changing inventory | Seed 205 laps with category/validity changes at page boundaries. Navigate all pages: 100/100/5 items, every ID exactly once, correct range/total, native events unchanged. Delete final-page rows through the actual supported mutation, then change only classification: page clamps only when required, no missing items or empty stranded page. Covers TL-01/07. |
| TL-E05: inspection and access | With own/others sessions and two games, open their legitimate routes under existing access rules. Activate a non-pace item by keyboard: existing replay route opens the correct lap ID. Telemetry-removed rows stay visible with disabled action/explanation. Unauthorized requests retain existing denial behavior; no source paths appear. Covers TL-02/07/08. |
| TL-E06: independent query states | Hold and release each lane's real request before its first success; close its upstream connection for an error. Repeat after a successful load to test cached failure. The other available lane remains visible; unavailable is not empty, cached rows keep a warning, retry/recovery restores real data. Exercise both-empty and native-only sessions. Auth failures must still use the existing global access boundary. Covers TL-05. |
| TL-E07: actual commit and reconnect | Open an expanded session against the owned upgrade DB; repair and Retry its missing ACC source through the real maintenance UI. Observe unknown/legacy category update from actual committed metadata without reload, collapsing expansion or altering lap identity. Disconnect browser transport, perform a real supported native-result reconciliation, then reconnect: lap metadata and native events refetch and match DB; focus on a surviving lap stays stable. Covers TL-06. |
| TL-E08: responsive and translated | Inspect 1440px and 390px views, including German long copy, invalid/unclassified states, loading/error text and pagination. The row/page does not overflow horizontally; lane overflow is deliberate and keyboard reachable; number/category/validity are readable without color or hover. Capture visuals and exercise focus/Enter/Tab/next/previous on actual controls. Covers TL-07. |

The integration owner must execute all eight scenarios after implementation, record pass/fail and exact evidence per TL criterion/edge, and rerun invalidated gates after fixes. Reuse unchanged valid evidence; planned/skipped/blocked cases do not close acceptance. Both implementation plans depend on this same execution record. Planning does not authorize running tests or implementing this extension now.
