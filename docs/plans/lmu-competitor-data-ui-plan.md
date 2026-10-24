# LMU telemetry — two-phase UI plan

[Shared contract and audited source inventory](lmu-competitor-data-contract.md) · [Backend plan](lmu-competitor-data-backend-plan.md) · [Proposed ADR](../adr/0014-lmu-competitor-data.md)

## Delivery order and ownership

**Phase 1 closes player gaps; Phase 2 adds opponent UI and companion-backed history.** Preserve established UI/other-game behavior; no broad redesign, manual player override, new transport, invented measurements or mock production fallback. Player delivery cannot depend on a grid or companion BIN.

UI owns relevant live/store/historical consumers, reused components and complete localized labels. Backend integration owner owns shared catalog/wire validators and source inventory. Finalize each phase's shared IDs/types/encoding, then implement backend/UI in parallel with contract-conforming fixtures. Final acceptance always uses actual backend integration.

Current baseline is `Snazzie/replay` at `7faddf9c4`. Reuse the implemented [`@raceiq/lap-replay` UI/host contract](../../advisor-plans/lap-replay-contract.md) and [UI ownership](../../advisor-plans/lap-replay-ui-plan.md); client route/selection composition remains outside the feature. Historical Phase 1 evidence below predates this baseline and is not fresh verification. Earlier standalone opponent-picker proposals are superseded: extend existing selection UI, not a parallel replay workspace.

Implementation authorized with controlled fixtures on 2026-10-22. Fresh Windows LMU recording/source validation follows implementation and gates final acceptance, superseding historical requirements to wait before coding. No unrun scenario is marked passed.

## Phase 1 — Player telemetry gaps

### Tasks and owned surfaces

1. Locate existing player typed transport/store/live/historical consumers and controls. Extend normal-live semantics and optional LMU supplemental context; `competitors` is absent in this phase. No grid state or opponent BIN dependency.
2. First expose separate battery charge/state of charge/virtual energy/regen with corrected units and valid-zero handling. Then consume supported separate engine/motor channels, steering feedback, detailed weather/wetness, player timing/gaps, controls/pit state and source-supported penalties/flags/services on appropriate existing surfaces. Do not display unsupported channels as measurements or combine physical concepts.
3. Present verified player/session REST setup/forecast/condition/capacity/refill/estimates with source, applicability, age and state; estimates and snapshots never look like current physics. REST failure does not suppress native player telemetry. Unverified units stay unavailable.
4. Respond to player/session/vehicle changes, no-player state, rewind/garage/freeze/disconnect and stale REST invalidation without retaining wrong-car data or guessing slot zero.
5. Use existing historical/replay/export/import paths for new player observations without a companion BIN. Preserve states/source times and explicit legacy omissions. Add/update all supported locales and player-facing capability guidance only for verified Phase 1 behavior.

### Acceptance and E2E gate

| Acceptance | Observable result | Shared scenarios |
|---|---|---|
| **U-LMU-2 → LC3** | Player energy quantities/units stay separate; zero numeric; missing/stale/invalid distinguishable | E2E-LMU-ENERGY |
| **U-LMU-3 → LC4** | REST player/session fields show correct applicability/source age/error states; no false fresh physics or suppression of native data | E2E-LMU-REST, E2E-LMU-PLAYER-LIFECYCLE |
| **U-LMU-4-P1 → LC6/LC8** | Historical/replay player values/states/times match recording without companion; legacy absent values unavailable; lifecycle clears incompatible state | E2E-LMU-PLAYER-RETENTION, E2E-LMU-PLAYER-LIFECYCLE |
| **U-LMU-5-P1 → LC7** | Non-LMU output unchanged; optional-context/JSON precision correct; every added label translated | E2E-LMU-UDP-COEXIST plus existing browser locale/non-LMU smoke |
| **U-LMU-6 → LC9** | Supported engine/motor/FFB/native weather/timing/control/race fields appear with correct units/semantics; unsupported values explicit | E2E-LMU-PLAYER-CHANNELS |

### Edge handling and validation

Zero vs missing/stale/invalid → independent state presentation (U-LMU-2/U-LMU-6). Slow/failed/unchanged REST → accurate age and retained native view (U-LMU-3). No player/slot swap/rewind/garage/freeze/reconnect → clear incompatible context, never reuse old driver values (U-LMU-4-P1). Legacy records → explicit omission, not source reconstruction (U-LMU-4-P1). Unsupported channel/unit → unavailable, not optimistic coverage (U-LMU-6).

Run player regressions through production backend/browser with controlled inputs; verify desktop/mobile/locales. Real Windows player acceptance remains required after implementation, not before Phase 2 starts. Record commands and outcomes; player scenarios do not require companion/grid fixtures.

### Implementation and controlled evidence — 2026-10-20

The existing live dashboard and historical Metrics panel reuse one localized player-data component. It shows 63 native channels and the typed 14-channel REST inventory without adding an opponent surface. Live ages use the backend receive clock; historical ages use the original frame observation clock, not the replay-request time. Incomparable or future timestamps show age unavailable.

| Criteria / scenario | Executed browser evidence |
|---|---|
| U-LMU-2, U-LMU-6; ENERGY / PLAYER-CHANNELS | Actual English desktop live route at 1440×1000 showed separate engine/motor channels and units. Controlled zero remained numeric; invalid virtual energy showed Invalid rather than zero. Rain and TC/ABS setting units resolved without conversion errors. |
| U-LMU-3; REST | The actual player panel retained native coolant at 95 °C while the REST condition snapshot showed Error/Stale. Acquisition and original observation ages remained distinct. Delayed native/HTTP independence is additionally covered by backend smoke. |
| U-LMU-4-P1; PLAYER-LIFECYCLE | No-player transition removed the retained battery value; resume restored the correct generation. Production wire smoke additionally exercised garage, pause, freeze, disconnect and vehicle swap. |
| U-LMU-4-P1; PLAYER-RETENTION | Actual captured V3 native/context frames were encoded with production sparse framing and uploaded through `/api/laps/import`: 1,678 packets, nine imported laps. The real replay route rendered 63 native and 14 supplemental channels from historical telemetry. At the selected original frame, both acquisition and observation age were 7 ms, not the later replay-request age. The selected-lap ZIP round-trip test separately verifies changing values/states and nanosecond precision. |
| U-LMU-5-P1; locale / UDP-COEXIST | All 16 locales include the added labels. German mobile live route at 390×844 had no horizontal panel overflow; German historical replay also rendered correctly. The actual Forza live surface accepted 230 real UDP packets with no LMU player panel or browser errors, then native LMU resumed. |

Additional U-LMU-3/U-LMU-4-P1 clock-edge fixtures changed only timestamp metadata in 64 captured native frames each and passed through the real import/replay endpoints. Monotonic observations and wall-clock observations one second later than their frame both rendered age unavailable instead of a false zero. Snapshot disclosures toggled with Enter; all 14 summary names were nonempty.

Headless Playwright exercised the real app/backend after the managed browser failed to recover. Fresh-load and interaction passes had no page errors. Browser captures and selected DOM/age evidence are retained locally under `.omp/evidence/lmu-phase1/` (not committed). Temporary fixture/control scaffolding was removed; no mock production fallback was added.

**Acceptance remains blocked:** actual Windows LMU player/version/mode smoke (`E2E-LMU-REAL-PLAYER`) is unavailable on this macOS workstation. Controlled UI/backend evidence does not replace that gate. Phase 2 was outside this historical Phase 1 verification scope; its current planned work follows below.

### Phase 1 review correction gate

The [shared review-correction boundary](lmu-competitor-data-contract.md#phase-1-review-corrections) adds explicit availability for new synthetic DuckDB imports, not a new UI transport or opponent surface. Existing Metrics rendering receives missing state/null for omitted channels rather than fabricated zero/false, while supplied native/imported zeros remain numeric (U-LMU-2/U-LMU-6). Actual production HTTP import/history/export/reimport passed for synthetic v4 and native v3, retaining supplemental context and original historical clocks (U-LMU-4-P1 / LC8). Production WebSocket smoke confirmed stale scoring with independently fresh physics. UI component/layout/locale sources were unchanged; prior presentation evidence is retained, not claimed as a fresh browser run. Actual Windows LMU acceptance remains unrun. Correction logs are local under `.omp/evidence/lmu-review/`.

## Phase 2 — Multiplayer opponent presentation

### Tasks and owned surfaces

1. Extend typed live/store consumers and existing surfaces with opponent snapshots keyed by generation, native ID and incarnation; honor no-player/departure/unavailable membership without index reuse. Controlled-fixture development proceeds before final real-recording acceptance.
2. Render supported driver/car/class/overall/class position, distinct timing/pit/gap semantics and only verified per-opponent channels. Preserve remote pit limitations, fuel-or-battery ambiguity and multiplayer restrictions; never borrow player values or fabricate opponent physics/gaps.
3. Consume companion-backed historical/replay context using coherent capture keys and original observation times. Missing/corrupt companion leaves player view usable with opponent unavailable; no adjacent-frame guesses. Preserve context correctly after ID reuse and lifecycle changes.
4. Update all relevant locales and multiplayer capability guidance. Use real backend companion/export/import/recovery integration, not fixture-only presentation. Rerun Phase 1 UI scenarios invalidated by shared changes.

### Acceptance and E2E gate

| Acceptance | Observable result | Shared scenarios |
|---|---|---|
| **U-LMU-1 → LC1/LC2** | Reorder/rejoin/reused IDs/no-player retain correct opponent display; supported scoring/timings/gaps accurately labeled, remote pit limitations visible | E2E-LMU-IDENTITY, E2E-LMU-COHERENCE |
| **U-LMU-2-P2 → LC2/LC3** | Opponent restrictions and fuel-or-battery meaning not mislabeled; player energy remains correct | E2E-LMU-OPPONENT-ENERGY |
| **U-LMU-4-P2 → LC5/LC6/LC8** | Companion-backed history aligns correctly, missing/corrupt data unavailable without breaking player reads, no stale-car state | E2E-LMU-RETENTION, E2E-LMU-COMPANION-FAILURE, E2E-LMU-LIFECYCLE |
| **U-LMU-5-P2 → LC7** | Verified multiplayer labels/limits translated; Phase 1 player and non-LMU behavior unchanged | E2E-LMU-UDP-COEXIST and affected Phase 1 browser regression scenarios |

### Edge handling and validation

ID reuse/no player/duplicate IDs → incarnation-aware keys and explicit unavailability (U-LMU-1). Restricted placeholders/inaccurate remote pit report → source-limited presentation, no fabricated measurements (U-LMU-1/U-LMU-2-P2). Missing/corrupt companion/legacy data → readable player view and unavailable opponents (U-LMU-4-P2). Player/opponent lifecycle changes → replace incompatible context, never cross-attribute values (U-LMU-4-P2).

Run contract scenarios through actual UI/backend multiplayer and companion integrations, including selected-lap export/reimport and failure states. `E2E-LMU-REAL-OPPONENTS` confirms source/mode coverage; reuse Phase 1 evidence only when unchanged inputs and scope justify it. Implementation and controlled outcomes are recorded below; fresh Windows acceptance remains unrun.

### Phase 2 amendment — remove saved opponents

Authoritative [removal contract](lmu-competitor-data-contract.md#optional-opponent-retention-and-explicit-removal), LC10/LC11 and shared E2E scenarios. Implement after boundary finalization using controlled fixtures; backend owns storage and UI consumes typed operations. Fresh Windows recording validation follows implementation.

**Owned scope:** existing `client/src/components/settings/StorageSection.tsx`, reused preview/confirmation controls following `SessionDownsampleDialog.tsx`, typed RPC/query hooks and `query-keys.ts`, affected historical opponent views and all supported `client/messages` locales. No redesign or automatic retention policy; the separate default-enabled capture preference is planned below.

1. Add manual “Remove saved opponent data” entry in Storage with one/multiple eligible LMU sessions selectable. Show full-session/all-laps scope, selected IDs, known companion bytes and separately identified legacy rewrites whose savings are unknown before completion. Preview/cancel is read-only; do not present byte counts as guaranteed savings.
2. Require accessible irreversible confirmation: player telemetry stays, opponent history is lost across all selected session laps, and earlier exported copies/backups remain unchanged. Show active/busy/shared/unsupported reasons from the backend without overriding eligibility. Only confirmed action invokes start.
3. Consume shared status via Hono RPC and React Query using existing maintenance polling/mount/focus conventions. Disable duplicate submission while running; support navigation/reload, per-session failures/skips, actual freed bytes and cleanup-pending outcomes. Do not infer completion from missing files or optimistic cache changes.
4. Refresh affected session/history/storage queries after settlement. Historical opponents distinguish removed, not-recorded and retained-but-missing/corrupt/incomplete states from the shared contract; player replay remains usable. Existing export/import actions use the backend's retained/removed behavior without fabricating companion data or adding mock fallbacks.
5. Translate all added labels/messages; verify keyboard confirmation/cancel and desktop/mobile layout through actual backend integration. Add focused assertions to existing Storage browser coverage, using the shared production fixtures rather than intercepted API responses. If no suitable Storage browser case exists, add one targeted case to the existing Playwright harness, not a new app/server stack.

| Acceptance | Required passing E2E evidence |
|---|---|
| **U-LMU-10 → LC11**: select one/multiple sessions, preview measured/unknown savings, cancel without mutation, confirm correct irreversible scope | E2E-LMU-STRIP, E2E-LMU-STRIP-UI |
| **U-LMU-11 → LC11/LC10**: reload/navigation restores backend status; busy/skip/error/cleanup-pending and actual savings displayed without false success | E2E-LMU-STRIP-RECOVERY, E2E-LMU-STRIP-REFERENCES, E2E-LMU-STRIP-UI |
| **U-LMU-12 → LC11/LC5/LC7**: real replay and imported stripped exports show intentional absence, preserve player rendering; accessible translated desktop/mobile controls | E2E-LMU-STRIP-ROUNDTRIP, E2E-LMU-STRIP-UI |

Edge solutions and setup/action/assertions are authoritative in the shared scenario table: notably legacy rewrite failures retain originals, shared/active sources cannot be forced, missing/corrupt does not mean removed, and post-commit unlink failure is pending cleanup. Backend integration owns shared execution/evidence; UI owns browser assertions in that pass. Completion requires passing real integration evidence for every row plus affected existing regressions and root `bun run typecheck`; fixtures, unrun Windows acceptance and isolated component checks are not completion proof.

### Phase 2 amendment — opponent selection in existing comparison UI

Users explicitly choose recorded opponent laps using existing UI. The [comparison boundary](lmu-competitor-data-contract.md#opponent-lap-selection-and-comparison) owns data semantics and the [replay contract](../../advisor-plans/lap-replay-contract.md) owns shared workspace/host boundaries. UI/backend proceed in parallel after schema agreement; implementation is authorized now, with real-recording acceptance afterward.

**Owned scope:** existing client `LapComparison`, `ComparisonSelectors`, `ComparisonLapSelect` and appropriate chart/overview/map consumers; typed RPC hooks, `client/src/lib/game-routes.ts`, compare route and `client/src/features/lap-replay-host.tsx`; `packages/lap-replay/{contracts,ui}` for typed opponent sources and shared Replay/Spectate adaptation; supported locale messages. No new standalone picker layout or copied Spectate tree. Add only minimal opponent-specific labels/availability inside existing selectors.

**UI direction:** retain incumbent theme/type/spacing, lap A/B colors and selector interactions. Extend the existing B/reference controls with “My laps” / “Opponents,” driver/car/class search and recorded-lap choices; reuse existing preview/overview controls for lap/sector times, warnings and available channels. No split roster/table redesign. Reuse `SpectateWorkspace`, `SpectateView`, controller/preparation and panel components through public `@raceiq/lap-replay` exports; preserve panel persistence, scene mode, camera/focus and single/paired behavior.

1. Keep selected player lap A fixed. Add explicit reference source choice “My laps” / “Opponents” and “Choose opponent lap” action; retain current player-to-player flow unchanged. Load candidates only for the selected LMU player's session/track, and clearly label that scope. No auto-selection of fastest/first opponent lap.
2. Extend existing reference selection controls: search driver/car, filter class, select a driver incarnation, then choose one recorded lap with lap time, coverage/validity and available-channel labels. Reuse current overview/preview for sector and delta detail plus explicit “Compare lap”/Cancel behavior. Duplicate names show car/ID/incarnation context. Warn but allow partial/invalid/unknown laps with comparable evidence; disable no-evidence rows with a reason. Cancel preserves the committed reference.
3. Use typed opponent sources, not fake `LapMeta`/numeric lap B IDs. Extend `ReplayHost` and feature contracts so `SpectateSession` can fetch the opponent semantic interval and feed existing preparation/controller, while player callers retain their real IDs. Show timing-only comparison in the existing overview; show source-proven scoring kinematics at their original quality/cadence and reuse shared Spectate when position/clock coverage permits. Missing inputs/pose/elapsed time never become zeros, racing line or continuous delta. No generic telemetry-input promise. Opponent AI/Insights that require ordinary saved player laps remain unsupported, never invoked with invented IDs.
4. Implement contract URL/search validation, history navigation and revision-aware query keys; ignore late incompatible responses. Removal/opt-out/missing/corrupt data clear unavailable opponent content without breaking player replay. Existing ZIP export supplies the optional opponent reference/revision when exporting a selected comparison. Preserve single-lap replay and player-to-player comparison.
5. Extend client-owned `playwright/tests/seeded/compare/{base-flow,interactions,channels,chart-zoom}.spec.ts` for selectors/charts, and feature-owned `packages/lap-replay/test/e2e/{analyse,compare}` for shared workspace, real recorded A/B poses, unavailable fields and panel/controller regressions. Reuse feature E2E ownership/registration; no duplicate relocated specs. Execute shared COMPARE scenarios with real backend, including full-interval export/import and stripping; verify keyboard, desktop/mobile/locales. Update user guidance/release notes only when shipped.

| Acceptance | Required passing shared E2E scenarios |
|---|---|
| **U-LMU-13 → LC13/LC12**: existing driver/class/lap selection extended, exact manual reference, preview/confirm/cancel and persistent player baseline; no parallel UI | COMPARE-SELECT, COMPARE-UI |
| **U-LMU-14 → LC13/LC12/LC2**: honest timing-only/trace presentation, warnings/disabled reasons and no fabricated channels/line/delta | COMPARE-COVERAGE, COMPARE-UI |
| **U-LMU-15 → LC13/LC1/LC6/LC10**: exact URL/identity or explicit unavailable state; removal clears stale content, shared Replay/Spectate and player-only playback unchanged | COMPARE-IDENTITY, COMPARE-RETENTION, COMPARE-REPLAY |

Use full `E2E-LMU-` names and setup/action/expected edge outcomes from the shared contract. UI owns browser assertions; backend integration owns final cross-layer execution/evidence. Real multiplayer selection/availability, all mapped scenarios, existing player/other-game comparison regressions and applicable root/package gates are completion dependencies; fixtures alone and unexecuted scenarios are not evidence.

### Phase 2 amendment — default-enabled recording setting

Authoritative [recording preference](lmu-competitor-data-contract.md#recording-preference--enabled-by-default), LC14 and `E2E-LMU-RECORDING-POLICY`. Own the existing Settings recording/storage controls, client settings typing/hooks, all locale labels and existing `playwright/tests/seeded/settings/{storage,persistence}.spec.ts` coverage.

1. Add “Record opponent data (LMU)” using existing settings switch/save behavior. Default checked, including absent older settings; never initialize a missing field to false. Explain: live opponents still work when off; saves apply to the next recording session; old recordings remain until explicitly removed. Show saved preference without falsely claiming the active session changed policy.
2. Save only the boolean through existing partial settings API, preserve unrelated preferences, display persistence/validation errors and retain the previous confirmed value on failure. Link to existing saved-data removal action for older recordings, not automatic deletion.
3. Distinguish not-recorded from removed/corrupt/missing in current replay/compare selectors. Existing retained imports remain selectable even when future live recording is opted out; re-enabling cannot restore unrecorded laps.

**U-LMU-16 → LC14/LC13/LC7:** default on, successful persisted off/on, next-session effect, failure feedback, live/player continuity, not-recorded comparison state and keyboard/mobile/locales all pass the shared recording-policy E2E through real Settings, native recorder and history/export/import. Backend integration owns joint execution/evidence; do not replace with intercepted settings responses.

## Phase 2 implementation and controlled verification — 2026-10-22

Implemented the existing LMU live panel, Storage removal controls, default-enabled
recording preference, explicit driver/class/incarnation/lap reference selection,
preview/confirmation/cancel, revision-aware URLs, unavailable states, selected
comparison export, and typed opponent playback through the existing shared
Replay/Spectate workspace. Player lap A remains a real saved lap; opponent
identities never become numeric player lap IDs. Scoring speed/position and
clock coverage govern playback; absent remote inputs remain unavailable.

The browser surface is the actual Vite client and backend on ports 4135/3135
with isolated `.omp/evidence/lmu-finish/test-data`, native controlled captures
from `@raceiq/game-lmu/test-support/opponents`, real import/export/storage
operations, and the real shared scene/controller. Opponent/settings responses
are not intercepted in the new acceptance flows. The pre-existing Storage
empty/error/cache-refresh regression cases retain their controlled API responses.

| Acceptance and shared scenario | Executed scope |
|---|---|
| U-LMU-10/11/12; LC10/11; STRIP-UI / STRIP-ROUNDTRIP | Actual preview/cancel and multi-session irreversible confirmation; status/reload, actual savings, removed opponent state, readable player replay/export and stripped ZIP reimport. Empty/error rendering and timed cache-refresh regressions also exercised. Backend fault/recovery/reference evidence remains in the backend plan, not claimed as every browser failure state. |
| U-LMU-13/14/15; LC12/13; COMPARE-SELECT / IDENTITY / RETENTION / UI / REPLAY | Recorded native import while future recording is off, exact manual lap selection, partial/unknown labels, preview/cancel, committed URL/reload/back-forward, stale revision, selected ZIP full-interval roundtrip, real A/B racing lines and advancing shared playback, post-removal unavailability and player replay. Desktop/mobile keyboard flows exercise the production integration; no opponent request is routed through player-only alignment. |
| U-LMU-16; LC14; RECORDING-POLICY | Existing recording controls default on and persist off/on through the actual settings API on desktop/mobile. Native next-session policy, live/player continuity and no companion artifacts when off use the joint native/ingress evidence in the backend plan. |
| U-LMU-1/2-P2/4-P2 | Incarnation-aware live rendering and explicit freshness/availability/source limitations are implemented and typechecked. Fresh live multiplayer UI/source population remains part of Windows acceptance, not established by recorded fixture playback. |

Additional checks: client comparison-search/WebSocket suites passed 8 tests
(24 assertions); root typecheck/lint passed 37 tasks each; shared replay
UI/server/contracts boundaries passed; 428 ordinary tests are registered
exactly once. All 16 locale catalogs contain the required 2,933 keys.

Permanent browser specs are registered in the existing serialized import
project to isolate settings mutations:
`packages/game-lmu/test/e2e/browser/compare/lmu-opponents.spec.ts`,
`packages/game-lmu/test/e2e/browser/settings/lmu-opponent-removal.spec.ts`, and
`packages/game-lmu/test/e2e/browser/settings/lmu-recording-policy.spec.ts`.
The temporary local verification configuration is not a production fallback.

Final browser outcomes and inspected screenshots are recorded in
`.omp/evidence/lmu-finish/verification.json`. Backend/native logs are listed
in the linked backend plan. Controlled source geometry is not a fresh
multiplayer capture. `E2E-LMU-REAL-PLAYER`, `E2E-LMU-REAL-OPPONENTS`, the full
other-game comparison regression suite, and unexercised browser fault variants
remain unverified; no count above marks those scenarios passed.


### Final browser result

`bunx playwright test --config=playwright/lmu-opponents.local.config.ts --workers=1`
passed **7/7 cases in 300.25 seconds**, with retries disabled. This final run
includes English desktop (1440×1000), English mobile and German mobile (390×844),
real recording-preference persistence, retained and stripped archive reimports,
and no collected browser errors in either comparison case. German selection uses the authoritative
persisted Settings language and restores it afterward.

Inspected loaded screenshots in `.omp/evidence/lmu-finish/`:
`opponent-comparison-desktop.png`, `opponent-comparison-mobile.png`, and
`opponent-comparison-mobile-de.png`. Captures wait for the actual shared scene
to report ready; the scenario also asserts both recorded racing lines and
advancing B playback. No document-width overflow was observed in those cases.
Full result: `playwright-final.log`. The temporary local configuration has
been removed and the owned client/backend verification services stopped;
the permanent specs remain registered in the normal serialized import suite.


## Individual opponent sessions amendment — 2026-10-22

Authoritative [shared boundary, OS1–OS4 and OS-E1–E4](lmu-competitor-data-contract.md#recording-backed-individual-opponent-sessions--2026-10-22). Backend proceeds independently after this boundary; UI may use conforming fixtures, never production fallbacks.

Owned files: `packages/sessions-page/{contracts,ui}`, `client/src/features/sessions-page-host.tsx`, existing typed opponent query hooks, supported locale messages and affected feature manifests/host fixtures. Add lazy opponent records inside expanded LMU sessions on desktop/mobile; each identity owns its lap list. Provide explicit player-lap selection and existing Compare navigation with exact opponent ID/revision. Reuse shared controls, formatting and warning translations; preserve selection, export/delete semantics for real player records.

Acceptance: U-OS1 maps OS2/OS3 to individually labeled identity/lap records and correct comparison selection (OS-E2/OS-E3); U-OS2 maps OS4 to honest partial/unknown/disabled/removed/loading/error/no-anchor states, no non-LMU queries and preserved existing player UI (OS-E3/OS-E4). Duplicate names show vehicle/incarnation identity; no source or no anchor disables comparison, never substitutes another driver. Source revision conflicts keep existing reload behavior.

Reuse seeded `packages/game-lmu/test/e2e/browser/compare/lmu-opponents.spec.ts` and production backend fixture import for OS-E3/OS-E4; add real-recording scenario rather than replacing controlled edge cases. Integration owner runs desktop/mobile browser scenarios and actual comparison/replay, plus focused affected checks, after backend/UI merge. Record outcomes here; unexecuted scenarios are not completion evidence.

OS-E3/OS-E4 refinement: actual recorded counter resets must not leave Compare's shared replay in an error panel. Verify source-backed semantic endpoint, visible shared opponent replay, and absence of source-read error; retain partial-gap warnings and do not imply continuous playback across sampled gaps. Boundary handling follows the shared contract's real-fixture refinement.

### Individual-record UI verification

U-OS1/U-OS2 completed against the [shared executed OS-E1–OS-E4 evidence](lmu-competitor-data-contract.md#executed-individual-record-verification). Full-grid browser case renders all 15 real identities separately. Real-recording desktop/mobile cases exercise explicit player selection, exact opponent comparison, source-backed semantic replay, ready shared scene and reload. Original controlled desktop/mobile keyboard/export/removal cases remain present and passed. Manual browser upload/expanded-record/timing-comparison inspection and generated desktop/mobile screenshots supplement those application E2Es. Both Sessions TypeScript projects, 15 owned unit tests, feature boundaries and all locale keys passed; broader verification limits are recorded once in the shared evidence.

### Package ownership amendment

No UI behavior or API shape changes. LMU browser suites belong to nested
`@raceiq/game-lmu-tests` workspace at `packages/game-lmu/test/e2e/browser/`;
generic catalogue/storage cases stay with their feature owners. UI scope:
relocate specs/CommonJS metadata, use canonical declared browser/SDK helpers,
and update project discovery and TypeScript inputs. Existing single-worker
`seeded-imports` project discovers both locations without fake production data.
UI/backend work proceeds independently against the unchanged shared boundary.
PKG1/PKG3/PKG5–PKG7 and shared PKG-E6/PKG-E7 integration scenarios, edge handling
and executed browser evidence remain in the
[contract ownership section](./lmu-competitor-data-contract.md#package-owned-lmu-tests-complete-seed-and-live-ingress-proof).


### Replay repair verification — 2026-10-23

UI follow-up maps to CR4–CR5 in the
[shared repair boundary and executed evidence](./lmu-competitor-data-contract.md#capture-publication-and-native-session-repair--2026-10-23).
Owned changes: solid A/B overview trajectories and solid fallback circuit
outlines; physical track-edge dashes and disconnected telemetry runs remain.
Actual Sessions and native WebGPU replay use production data and APIs. Restored
Bahrain Outer and preserved Bahrain Paddock resolve calibrated boundaries.
The shared section records source-conservation proof, screenshots/scene
observations and cold-scan latency limits; no new UI/backend wire contract.

