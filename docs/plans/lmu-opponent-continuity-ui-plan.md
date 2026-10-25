# LMU opponent continuity UI plan

Contract: [Shared continuity contract](lmu-opponent-continuity-contract.md). Companion plan: [Backend](lmu-opponent-continuity-backend-plan.md). Contract decisions are agreed; UI work can proceed against existing DTOs independently. Main orchestrator owns final shared E1–E4 verification.

## Scope and ownership

UI worker owns replay preparation/controller/scene presentation and appropriate replay tests. Existing Sessions entry worker owns route, opponent metadata/status surface and browser Sessions regression until its deliverable is complete; then transfer that scope explicitly. No backend changes, sample fabrication, new player-only fallback, or comparison alignment work.

## Tasks and observable acceptance

1. Complete Sessions Replay and Compare buttons with router navigation and the existing replay route query branch, preserving the exact opponent reference and discriminated metadata. Do not render anchors for these in-app actions. Fetch only opponent catalog/semantic data, never anchor-player telemetry. Reuse single-replay scene, panels and localization. Acceptance: OC5 and OC7; shared E3 verifies button roles and resulting routes on desktop/mobile.
2. Make standalone opponent playback source-aware: ordinary adjacent native scoring updates at 200 ms must not make the car/telemetry disappear solely because player telemetry uses a 101 ms gap threshold. Keep recorded sample timestamps/values intact; any display interpolation is visual and must not turn missing sequences or long gaps into source data. Preserve ordinary player behavior. Acceptance: OC3, OC5–OC6; E3 and E4.
3. Show a visible recorded opponent path by default on standalone replay, with sparse estimate connectors visually distinguished. Do not fabricate a full circuit or bridge invalid positions/long gaps. Partial/unknown full-lap timing stays unknown; controls use recorded interval duration. Acceptance: OC5–OC6; E3 and E4.
4. Verify stale/removed/corrupt/missing/failed/pending references, malformed query pairs and non-LMU refusal through actual route. Keep AI/player statistics off opponent replay; unsupported controls remain unavailable. Acceptance: OC5 and OC7; E2–E4.
5. Extend existing real-recording Sessions browser suite and source-cadence regression tests. Assert ready car and native numerical telemetry, visible path, playback advancement, exact sample scrub, reload and own-player replay on desktop/mobile. Tests must not substitute fixed screenshots or mocked query echoes for production integration. Acceptance: OC5–OC7; E3 and E4.
6. Flatten opponent render poses and all native/projected/estimated opponent path variants to the track plane in standalone replay and comparison. Keep raw semantic elevation and player rendering unchanged. Test exact samples, interpolation, scrub and oblique views against shared E5. Acceptance: OC3 and OC8. This is a visual correction only; it requires neither reseeding nor a native recording rewrite.

## Edge-case implementation obligations

Use the shared edge table: expected 200 ms cadence is not automatically loss; missing sequences, incompatible clocks, non-finite positions and long gaps must remain explicit. Single-sample or timing-only intervals cannot invent motion. Query identity must never fall back to the selected player lap. Backend-rebuilt IDs are selected from the fresh catalog; obsolete deep links fail explicitly.
The repository navigation rule is recorded in `.github/copilot-instructions.md`. Existing unrelated navigation controls are outside this repair; all changed in-app navigation controls must follow the rule.

## Verification

Main executes shared E3–E5 through real Sessions → Replay and actual renderer, on desktop/mobile, plus existing replay unit tests, relevant browser suite and repository typecheck. Shared E1–E2 backend evidence is also required for OC1/OC4 integration. Source-aware rendering and height changes invalidate earlier affected playback/visual evidence.

## Outcomes

Replay/runtime and changelog checks passed: 41 tests, 244 assertions, including exact/interpolated opponent render height, unchanged native elevation values and unchanged player height. After the final schematic-height correction, replay package lint and both package typechecks passed, and all 30 replay/runtime tests passed again. Sessions package lint and UI/server typechecks passed after button navigation changed.

E3b real full-source browser evidence passed for Sessions selection, exact identity, native numerical pose/speed, 30-second playback advancement, native-sample scrub, partial/unknown timing, reload, visible estimated path, mobile layout without horizontal overflow, schematic marker and zoomed car model. A valid native pose now remains visible when projected lane geometry is absent; actual missing source poses remain unavailable. Evidence: [browser results](../../.omp/evidence/opponent-antonio-browser.json), [mobile marker](../../.omp/evidence/opponent-antonio-mobile.webp), [zoomed car](../../.omp/evidence/opponent-antonio-mobile-car.webp).

E3a and comparison-side E5 passed on desktop and mobile: `E2E_SERVER_MODE=dev PW_SERVER_SET=seeded bunx playwright test --config=playwright/playwright.config.ts --project=seeded-imports --grep 'OS-E3' --workers=1 --retries=0` completed with 3 passed (setup plus both real-source scenarios). Assertions cover Sessions button navigation, own-player replay, exact native opponent pose/speed, explicit sampled gaps and recovery, playback, scrub, reload, stale reference rejection, visible estimated paths, preserved nonzero/changing native elevation, and actual opponent car/path world height zero in standalone and comparison. Evidence: [passing real-source browser log](../../.omp/evidence/opponent-real-source-browser.log).

E4 passed with the same final height implementation: `OS-E4 renders native 200 ms opponent cadence and preserves real source gaps` completed against actual native import, indexing, HTTP and browser renderer. The fixture captures player data at 20 Hz while opponent scoring updates at 5 Hz; normal playback stays visible, actual car/path geometry stays at world `y = 0`, and a genuine missing-source interval remains unavailable. Evidence: [cadence browser log](../../.omp/evidence/opponent-cadence-browser.log). That combined log includes earlier E3 failures; the dedicated passing E3 run supersedes them. Only E3 test interaction order/readiness bounds changed afterward; E4 inputs and implementation remained unchanged.

E5 full-source visual supplement passed on desktop/mobile: native API elevation remains `23.701963424682617`, while actual rendered opponent car and path geometry use world `y = 0`. Oblique native and schematic views were inspected, including native-sample scrub, with no browser errors. No reseed or reimport occurred. Evidence: [height results](../../.omp/evidence/opponent-flat-height.json), [desktop](../../.omp/evidence/opponent-flat-desktop-oblique.webp), [mobile](../../.omp/evidence/opponent-flat-mobile-oblique.webp), [schematic](../../.omp/evidence/opponent-flat-mobile-schematic.webp). The passing E3 scenarios also verify comparison-side E5.

Sessions Replay and Compare are shared buttons using router navigation. Actual production-source smoke verified both button roles, zero anchors in the opponent lap row, exact route/search references, and unchanged `performance.timeOrigin` through both transitions. Rule added in `.github/copilot-instructions.md`. Evidence: [navigation results](../../.omp/evidence/opponent-navigation-buttons.json).

Repository typecheck ran and remains blocked by the existing roundtrip-test TS2345 documented in the backend plan. Comparison alignment remains outside the user's prioritized standalone replay repair.
