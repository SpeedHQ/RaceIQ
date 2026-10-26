# 3 to Improve — shared feature contract

Status: accepted for implementation on 2026-10-26. The user selected own-session coaching, approved the Overview placement, and requested implementation and a pull request. Changes to this boundary must update both plans before dependent work continues.

Implementation: [UI plan](3-to-improve-ui-plan.md), [backend plan](3-to-improve-backend-plan.md). Decision: [ADR 0016](../adr/0016-3-to-improve.md).

## Product behavior

Give a driver up to three short, actionable practice priorities for one recorded session. Each priority answers: **where**, **what happened**, **what to try next**, and **what evidence supports it**. Show the section near the top of the session Analyse Overview, before detailed telemetry. It summarizes the whole eligible session, not the current comparison-lap selection; label that scope explicitly.

Example card, illustrative rather than a claim about recorded data:

> **1. Smooth the throttle — Turn 4**  
> Abrupt throttle reversals appeared here on 3 laps.  
> **Next run:** Feed in throttle progressively while unwinding steering.  
> **Show evidence** · Lap 6

Three is a maximum, not a quota. One or two qualifying findings produce one or two cards. Zero findings must not imply perfect driving. Advice is a practice suggestion supported by an observed symptom, not a proven cause or guaranteed improvement.

Non-goals: AI/provider integration, external or historical reference laps, setup changes, automatic drills/experiments, live coaching, session-list redesign, new telemetry detectors, leaderboards, saved completion tracking, and predicted seconds saved. Existing analysis and replay remain available unchanged.

## Existing authorities and ownership

- Extend `packages/session-analyse/` through its existing `/ui`, `/server`, `/contracts` entries. Do not create another package or compatibility path. Follow [feature package architecture](../architecture/feature-packages.md).
- Preserve [session Analyse contracts](../../advisor-plans/session-analyse-contract.md), including both session URLs, comparison selection and processing guards. Current code is authoritative where the historical extraction report differs.
- Reuse `LapInsight` and `LapDetectorCoverage` in `packages/analysis-core/src/racing/analysis/laps/insights/types.ts`, detector computation, source-frame restoration and version checks in `server/lap-analysis/metrics-store.ts`, and existing capture/track-location readers. Do not parse English `detail` text into data.
- Preserve native/derived/unavailable distinctions under [telemetry semantics](../reference/semantics.md). An absent detector result is not proof that its inputs were available or driving was correct. No new semantic mapping or general intelligence platform is required.
- UI integrates through `ui/SessionAnalysePage.tsx`, `ui/SessionReviewDashboard.tsx`, `ui/host.tsx` or its actual current host file, `ui/queries.ts`, and `client/src/features/session-analyse-host.tsx`. Check actual filenames before edits.
- Backend adds the operation to the existing feature route factory and uses authoritative backend-core session/lap readers. The integration owner owns shared DTOs, host/composition changes, fixtures, and final E2E execution. Separate UI/backend owners may work in parallel after contract approval.

## Evidence and selection algorithm

1. Read all laps belonging to the requested game/session, not the fastest-five review endpoint and not user-selected comparison IDs. Metadata-eligible laps are valid pace laps with finite positive times and are not experiment-excluded. Use existing classification predicates; preserve the meaning of excluded/out/in/invalid laps. Count metadata-ineligible laps separately. Apply the processing guards below to the session and metadata-eligible laps before analysis; only ready laps with readable recorded telemetry are analyzed.
2. Use current-version persisted detector results; reuse existing recomputation for stale results. Process each eligible capture at most once per request, sequentially, reusing existing loaders/caches. Do not send full-session telemetry to the browser or add persisted summary tables.
3. Initial actionable allowlist is deliberately limited to these existing findings. All other findings remain in the existing analysis, but cannot become coaching cards without extending this contract and its verification.

| Finding ID | Coaching family | One proposed action |
| --- | --- | --- |
| `driving-brake-drag` | `brake-drag` | Check that the brake is fully released when accelerating. |
| `driving-downshift-over-rev` | `downshift` | Delay the next downshift until engine speed has fallen. |
| `driving-early-throttle` | `throttle` | Feed in throttle progressively while unwinding steering. |
| `driving-binary-throttle` | `throttle` | Feed in throttle progressively while unwinding steering. |
| `driving-throttle-micro-lifts` | `throttle` | Feed in throttle progressively while unwinding steering. |
| `driving-steering-sawing` | `steering` | Aim for one smooth steering input instead of repeated corrections. |
| `driving-understeer-scrub` | `front-scrub` | Try a slightly lower entry speed to reduce front scrub. |

Do not promote ABS/TC activity, coasting, low exit throttle, or corner speed reduction alone into claims of incorrect driving. They lack sufficient causal context. Never prescribe a numeric braking marker, throttle percentage, or speed target without a measured reference.

4. Resolve each source `frameIndices` entry against the original capture, never an aligned/downsampled index. Keep only finite, in-range indices with a trustworthy normalized lap-distance fraction in `[0,1]`, using existing distance/alignment helpers. No location from sample index divided by sample count or elapsed time. Fraction `1` belongs to the final bucket, not the start. A representative event frame supports a point location, not an event-duration claim.
5. Group points into 50 fixed lap-distance buckets: `min(49, floor(fraction * 50))`. Within each bucket, merge finding IDs in the same coaching family and deduplicate identical `(lapId, sourceFrameIndex)` points. This intentionally coarse grouping can split nearby events across a boundary; do not claim it detects a uniquely named corner or continuous event. Count distinct supporting laps and deduplicated evidence points, not independent faults or measured duration.
6. Rank candidates by supporting-lap count descending, evidence-point count descending, then family string ascending and bucket number ascending. Do not rank by estimated time loss or use lap-wide severity as local severity. Greedily select at most three, skipping already selected families or buckets. Thus three related throttle detectors or three findings at one location cannot fill all cards. IDs are `${family}:${bucket}` and are stable for unchanged evidence.
7. For each selected candidate, choose the representative point by lowest lap number, then lap ID, then source frame index. Label `repeated` when at least two distinct laps support it; otherwise `single-lap`. A single-lap observation is allowed but never described as repeatable. Resolve a corner label only from authoritative curated geometry containing that point; otherwise display rounded lap-distance percentage. Never invent a turn name or substitute a sector label from equal thirds.
8. Withhold all candidates lacking trustworthy location. Missing/unsupported telemetry and absent actions must remain distinguishable from an error. No estimates of saved time or sums of `timeLossS` appear in this feature.

## HTTP integration boundary

Add `GET /api/sessions/:sessionId/3-to-improve` to the feature's existing Hono route composition. Required `X-Game-Id: GameId` selects game scope; no game query parameter, request body, lap selection, pagination, or mutation. Session ID is a positive safe integer. Use typed Hono RPC through the host; retain application auth/origin/CSRF behavior and do not weaken middleware. Look up the session within the current application's authorized scope before reading its laps.

All response fields below are required unless marked nullable. IDs are positive safe integers; counts are nonnegative integers; fractions are finite numbers in `[0,1]`. `GameId` and `ProcessingMetadata` retain their existing shared definitions rather than copied unions.

```ts
type CoachingFamily = "brake-drag" | "downshift" | "throttle" | "steering" | "front-scrub";
type ThreeToImproveResponse = {
  sessionId: number;
  gameId: GameId;
  state: "ready" | "insufficient-data" | "no-actionable-findings";
  eligibleLapCount: number;
  analyzedLapCount: number;
  excludedLapCount: number;
  unlocatedEvidenceCount: number;
  items: Array<{
    id: string; // family:bucket
    family: CoachingFamily;
    evidenceLevel: "single-lap" | "repeated";
    supportingLapCount: number;
    evidencePointCount: number;
    location: { fraction: number; cornerName: string | null };
    representative: { lapId: number; lapNumber: number; sourceFrameIndex: number };
  }>; // 0..3, ranked order
};
```

`eligibleLapCount` counts metadata-eligible laps before capture usability checks. `analyzedLapCount` counts those successfully analyzed with usable capture; `excludedLapCount` counts metadata-ineligible laps. `unlocatedEvidenceCount` counts allowlisted source evidence points discarded for invalid/missing location. Counts refer to one request's session snapshot, not current comparison selection. An empty ready response is invalid: `ready` requires 1–3 items. No items with no usable capture, or all actionable evidence unlocatable, means `insufficient-data`; otherwise no qualifying allowlisted evidence means `no-actionable-findings`. A legitimately unsupported game can therefore show no actionable findings, never “nothing to improve.” Display analyzed/eligible scope and the location limitation when applicable.

Example request: `GET /api/sessions/42/3-to-improve` with `X-Game-Id: acc`. Example item: `{"id":"throttle:12","family":"throttle","evidenceLevel":"repeated","supportingLapCount":3,"evidencePointCount":4,"location":{"fraction":0.245,"cornerName":null},"representative":{"lapId":106,"lapNumber":6,"sourceFrameIndex":820}}`. User copy comes from localized family templates, not server-authored English.

Errors: malformed ID or missing/invalid game header → 400 validation error; unknown, unauthorized or wrong-game session → existing inaccessible-resource behavior without exposing another scope's data (404 where current app uses 404); session queued/processing → 409 with existing `RECORDING_PROCESSING` envelope; failed processing → 422 with existing `RECORDING_PROCESSING_FAILED` envelope. Do not return a partial coaching result while the session is processing. An eligible lap still processing also blocks with 409; a failed lap blocks with 422 rather than appearing clean. Missing capture is insufficient data; unexpected decoder/storage/computation failures use existing application error handling, never a successful empty response.

No durable summary cache. Reuse version-aware per-lap caches. UI query identity includes game and session, refetches on mount, and invalidates on session processing completion, lap inclusion/exclusion changes and session removal through existing query invalidation conventions. Refetch must replace, not merge, ranked items. If source data disappears between summary and evidence navigation, show existing missing/processing/error UI without substitution.

## Evidence interaction

`Show evidence` opens an in-place, dismissible detail panel in the session Overview; no new replay URL contract. The panel shows the representative lap, localized action, exact observed point, and surrounding recorded speed/brake/throttle/steering traces using existing charts. Resolve source-frame location on the server before downsampling; never reuse source indices as chart indices. Load detail only on activation. A marker corresponds to the returned fraction, including the final bucket. Do not add optional replay controls for this feature.

Use `GET /api/sessions/:sessionId/3-to-improve/evidence` with the same required game header and required query fields `lapId` (positive safe integer) and `sourceFrameIndex` (nonnegative safe integer). The pair must still be a representative of a currently selected priority for this session; otherwise return 409 `{ "code": "COACHING_EVIDENCE_CHANGED", "error": "Session evidence changed. Refresh the insights." }`. Revalidate ownership before revealing whether evidence exists. Missing lap/capture returns the existing missing-resource response; processing/failure/auth/validation behavior matches the summary operation.

Return `{ sessionId, gameId, representative, fraction, aligned }`, with the representative shape above, a finite normalized fraction, and `aligned: EncodedAlignedLapSet` from `packages/analysis-core/src/racing/laps/alignment/types.ts`. Use existing encoding/decoding and alignment services, not JSON serialization of typed arrays. Include only the representative lap. Window is `[max(0, fraction - 0.02), min(1, fraction + 0.02)]`, converted through the real nominal track span; retain existing trace units and unavailable-channel behavior. Request alignment step `max(0.1, windowLengthMeters / 599)` to bound detail to approximately 600 samples; do not claim a missing signal is zero. The marker need not coincide with a resampled point. Insufficient span/location returns the changed-evidence response rather than fabricated geometry. UI displays a refresh action for changed evidence and never substitutes the new representative silently.

Use the shared Button for activation/navigation; keep focus restoration, keyboard dismissal, accessible names, unit formatting, and all supported translations. Detail errors affect the panel only; closing it restores the session and comparison selection unchanged. Do not add raw fetch or a production fixture fallback.

## Observable acceptance criteria

- **TI-1:** A real ready session Overview shows 0–3 ranked, distinct priorities with location, observed-pattern copy, one practice action and an evidence control. Scope explicitly covers the eligible session, independent of comparison selection.
- **TI-2:** Every card derives from allowlisted current-version detector evidence in that game/session. Counts, point mapping, ranking, family/location deduplication and single-lap/repeated wording follow this contract deterministically.
- **TI-3:** Evidence activation shows the exact representative lap and recorded point with readable surrounding traces. Closing restores focus and selection; missing/deleted/failed evidence never opens a different lap.
- **TI-4:** Zero/one/two findings, absent location, unsupported telemetry, empty/ineligible sessions, processing and failures produce the specified honest states without fabricated cards or gain claims.
- **TI-5:** Real HTTP enforces validation, scope, processing guards and failure propagation. Source/analysis changes invalidate results; separate games/sessions never share cached cards.
- **TI-6:** Both existing session URLs work; comparison, replay and shared experiment/single-lap consumers retain behavior. Desktop/mobile/keyboard/localized UI remains usable. No new browser server imports, full-session telemetry download, AI call, schema migration or summary persistence.

## Edge cases and shared E2E strategy

Extend the existing compiled-app `@raceiq/session-analyse` Playwright project, not a new mocked application. Reuse its isolated DATA_DIR/ports, real persistence, recording import/seed helpers and browser-error collection. Add controlled source recordings whose known signals produce selected findings; expected outputs must be independently computed/asserted from those signals, not from production ranking code. Seed raw telemetry plus metadata through existing isolated fixture conventions; do not inject completed coaching JSON or intercept the new endpoint. Fixtures should cover distinct games and unavailable channels without modifying user data.

| Scenario | Setup → action → observable outcome and handling | Criteria |
| --- | --- | --- |
| TI-E1 Priorities | Import session with four qualifying families, repeated evidence and duplicate throttle signals → open each existing session URL → exact top three in specified order; one family/bucket each; change comparison selection → same whole-session cards. | TI-1/2/6 |
| TI-E2 Small sets | Separate zero-, one-, two-finding sessions plus single eligible lap → open Overview → exact number of cards, honest empty wording, single-lap badge without repeat claim; no placeholders. | TI-1/2/4 |
| TI-E3 Location | Controlled early/final fractions, bucket-boundary points, invalid source indices, absent distance, curated and uncurated geometry → load and inspect evidence → correct bin and label; final fraction stays at end; invalid/unlocated points withheld and limitations visible. | TI-2/3/4 |
| TI-E4 Evidence | Open each priority in a real recording → inspect marker and trace values against known source samples, dismiss by keyboard → correct lap/location, focus restored and URL/selection unchanged; delete recording in isolated fixture then activate → missing/error state, never another lap. | TI-3/5/6 |
| TI-E5 Eligibility | Include invalid, non-pace, excluded, missing-capture and unsupported-channel laps → open Overview → no excluded evidence, exact counts, insufficient/no-findings distinction. Change exclusion via existing application path → refetch and updated priorities. | TI-2/4/5 |
| TI-E6 Lifecycle | Controlled queued → processing → ready session, then failed session/lap → use actual processing flow or existing deterministic fixture controls → 409/422 and UI status match; ready transition refetches; no stale cards while pending/failed. | TI-4/5 |
| TI-E7 API isolation | Through actual application HTTP request context, request malformed/unsafe ID, missing/invalid header, wrong game, nonexistent/inaccessible session and changed session → correct status/envelope, no cross-scope data; same valid request twice yields identical item order. Inject storage failure at existing test fault boundary, not a fake successful endpoint → error propagates. | TI-2/4/5 |
| TI-E8 UI/regression | Real integrated feature at desktop and narrow mobile widths, keyboard-only detail navigation, supported locale/unit switch → readable actions/traces, no overflow or inaccessible controls; existing group-review/replay and shared consumer E2Es remain passing; browser requests contain compact summary and on-demand detail only. | TI-1/3/6 |
| TI-E9 Freshness | Start from stale persisted detector version with known raw recording → open feature → authoritative recomputation and fresh cards; reload, switch game/session, then delete session → no stale/cross-scope cards or error-hidden empty success. | TI-2/5/6 |

The integration owner runs TI-E1–E9 after both implementations, plus existing affected session/replay consumers, feature boundary/type/lint gates and root `bun run typecheck`. UI fixtures and unit tests supplement these scenarios, never replace real integration. Record exact commands, scenario outcomes, screenshots for UI, and failures/blockers in a separate implementation verification report. Do not claim implementation complete until every criterion and edge case has passing evidence. Planning-only status: no application, tests, browser or build executed for this proposal.
