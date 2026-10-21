# LMU telemetry — two-phase UI plan

[Shared contract and audited source inventory](lmu-competitor-data-contract.md) · [Backend plan](lmu-competitor-data-backend-plan.md) · [Proposed ADR](../adr/0014-lmu-competitor-data.md)

## Delivery order and ownership

**Phase 1 closes player gaps; Phase 2 adds opponent UI and companion-backed history.** Preserve established UI/other-game behavior; no broad redesign, manual player override, new transport, invented measurements or mock production fallback. Player delivery cannot depend on a grid or companion BIN.

UI owns relevant live/store/historical consumers, reused components and complete localized labels. Backend integration owner owns shared catalog/wire validators and source inventory. Finalize each phase's shared IDs/types/encoding, then implement backend/UI in parallel with contract-conforming fixtures. Final acceptance always uses actual backend integration.

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

Run these scenarios through existing production backend and live/historical browser surfaces with controlled inputs; verify affected desktop/mobile states and relevant locales. `E2E-LMU-REAL-PLAYER` is required for actual source-backed player coverage before Phase 2 starts. Record fixtures, commands and visible outcomes; backend source/environment limits remain blockers. Player criteria do not require multiplayer fixtures, grid UI or companion files.

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

**Acceptance remains blocked:** actual Windows LMU player/version/mode smoke (`E2E-LMU-REAL-PLAYER`) is unavailable on this macOS workstation. Controlled UI/backend evidence does not replace that gate. Phase 2 remains out of scope.

### Phase 1 review correction gate

The [shared review-correction boundary](lmu-competitor-data-contract.md#phase-1-review-corrections) adds explicit availability for new synthetic DuckDB imports, not a new UI transport or opponent surface. Existing Metrics rendering receives missing state/null for omitted channels rather than fabricated zero/false, while supplied native/imported zeros remain numeric (U-LMU-2/U-LMU-6). Actual production HTTP import/history/export/reimport passed for synthetic v4 and native v3, retaining supplemental context and original historical clocks (U-LMU-4-P1 / LC8). Production WebSocket smoke confirmed stale scoring with independently fresh physics. UI component/layout/locale sources were unchanged; prior presentation evidence is retained, not claimed as a fresh browser run. Actual Windows LMU acceptance remains unrun. Correction logs are local under `.omp/evidence/lmu-review/`.

## Phase 2 — Multiplayer opponent presentation

### Tasks and owned surfaces

1. After Phase 1 acceptance, extend typed live/store consumers and appropriate existing surfaces with opponent snapshots. Key by session generation, `mID` and incarnation; honor no-player state, departures and explicit unavailable membership rather than array-index reuse.
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

Run contract scenarios through actual UI/backend multiplayer and companion integrations, including selected-lap export/reimport and failure states. `E2E-LMU-REAL-OPPONENTS` confirms source/mode coverage; reuse Phase 1 evidence only when unchanged inputs and scope justify it. Record commands, visible outcomes and environment limits. Phase 2 implementation and validation remain unexecuted; Phase 1 evidence and its remaining acceptance blocker are recorded above.
