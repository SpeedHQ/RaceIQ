# Per-game tire thresholds

Implementation: [UI](tire-thresholds-ui-plan.md), [backend](tire-thresholds-backend-plan.md). Integration owner: coordinator. Decisions below are agreed from existing remaining-health and settings contracts; no unresolved cross-boundary decisions.

## Boundary

Extend existing authenticated `GET /api/settings` and `PUT /api/settings` with `tireThresholdOverrides: Record<GameId, Record<string, { cliffPct: number; deadPct: number }>>` (outer game keys optional). Percentages are remaining health, finite numbers with `0 <= deadPct < cliffPct <= 100`. Each compound entry contains both required values. Missing field defaults to `{}`. PUT replaces the supplied map, preserving other settings. Empty map resets all overrides; deleting one entry restores that compound's defaults. Invalid values or unknown game IDs return existing HTTP 400 settings error without saving.

Example: `{ "tireThresholdOverrides": { "f1-2025": { "soft": { "cliffPct": 45, "deadPct": 15 } } } }`.

Shared authority: new `shared/racing/live/tire-thresholds.ts` exports `TireThresholdOverrides`, `TireThresholds` and game compound options/resolution utilities as needed. Backend owns this module; UI can use contract-conforming local constants until exports exist, but must integrate shared exports before completion. Exact shared helper interfaces must be communicated before use. Existing adapter yellow threshold * 100 is default cliff; default dead remains 20. Reserved compound key `default` applies only where source compound is unknown; known unmatched compounds use adapter defaults, never another compound's override. Use existing source-native normalized compound strings, including independent LMU front/rear compounds; do not guess Forza compounds absent from telemetry. UI offers a Default / unknown tire type for such games and custom compound names for simulator-specific types.

Resolve thresholds independently per wheel. Apply to PitTracker curve/fallback estimates and DurableStrategyTracker live/history projections and newly stored pit predictions. No per-frame filesystem reads. Saving settings applies to subsequent telemetry without restart, including compound/game switches. Preserve existing unavailable-data semantics and immutable old estimates. Existing scalar LivePitData cliffPct/deadPct remain representative defaults when wheels differ; add optional per-wheel threshold tuples for truthful mixed-compound labels and tooltips. All affected clients display effective values without hiding valid 0% dead.

Shared helper API: `getPacketTireCompound(packet, wheel): string`, `getTireThresholds(overrides, gameId, compound): TireThresholds`, and `getTireCompoundOptions(gameId): readonly string[]` live in the new shared module. `LivePitData.tireThresholds?: [TireThresholds, TireThresholds, TireThresholds, TireThresholds]` carries effective FL/FR/RL/RR values.

## Acceptance / E2E scenarios

- T1: Settings UI saves cliff and dead for selected game/compound; actual GET returns values after page reload and server reload. Change one game/compound, assert unrelated entries and settings unchanged.
- T2: Real telemetry ingestion with deterministic wear/rates uses matching game/compound overrides; switching compound/game falls back correctly. Exercise live publication and durable projection, including mixed LMU front/rear. Observe per-wheel laps to cliff/dead and pit limiter.
- T3: Clearing an entry restores adapter defaults; zero dead is valid; nonfinite, out-of-range, dead >= cliff and unknown game values produce 400 with persisted map unchanged. UI prevents invalid saves and reports save failure, retaining edits.
- T4: Unknown compounds use only `default`; unavailable wear/rates remain unavailable. Test missing settings field on existing installs and live settings update without session restart.
- W1: F1 dashboard pit estimate spans entire left telemetry column on desktop and available width on mobile, without horizontal overflow; weather/damage/tires retain two-column layout.
- D1: Every compact pit estimate exposes a button opening a large accessible dialog based on [the supplied timeline prototype](../../design-prototypes/pit-estimator/02-strategy-timeline.html). Render current real fuel/stint/tire data, proportional future lap horizon, per-wheel readings, expandable evidence and existing projection history. No sample telemetry or embedded local HTML.
- D2: Missing or stale projections remain unavailable, zero laps/zero dead remain visible, mixed-compound thresholds stay truthful, and coincident marker labels remain readable. Keyboard open/Escape/focus return and desktop/mobile sizing pass without horizontal overflow.

Dialog E2E: ingest controlled F1 live telemetry, open from compact estimate, assert visible values and marker positions against actual published pit state, expand evidence/history, close with Escape and assert focus returns. Repeat on mobile and with unavailable/zero/coincident limits, then verify W1 on the same live dashboard. Reuse current seeded browser harness and source-backed ingestion helpers.

Reuse existing Playwright seeded settings suite and live telemetry fixture/ingestion helpers. Coordinator runs real UI/API/telemetry integration and typechecks after both implementations settle; tests must not mock the production API boundary. Backend targeted tests supplement, not replace, application smoke. Blocked/unexecuted scenarios are not completion evidence.

## Review corrections

- T5: ACC/AC Evo preset values use source-native `dry_compound` / `wet_compound` IDs. Selecting a preset and saving must affect that native compound's live thresholds; existing arbitrary custom names remain intact. Validate preset-to-resolver/tracker behavior, including dry/wet isolation.
- T6: Live publication applies the durable strategy projection after the current PitTracker projection. A new matching stint must use compatible previous-session evidence and publish `pit.strategy`; limiter-change snapshots must remain enabled. Rerun the existing source-backed historical-evidence E2E, including source deletion and revision invalidation.

## Verification

Implemented. Backend and client typechecks pass after locale generation; changed-path lint passes.

- Shared/tracker regressions: 24 passed, including mixed LMU axles, unknown compounds, zero-dead thresholds, and native ACC/AC Evo dry/wet projections.
- `playwright/tests/seeded/strategy/tire-thresholds.spec.ts`: passed against real FM/F1 UDP ingestion, settings HTTP persistence/restart, live edits, durable predictions, default reset and soft-to-medium compound changes.
- `playwright/tests/seeded/strategy/settings-ui.spec.ts`: passed real UI save/reload/isolation/reset, invalid-value prevention and injected-save-failure draft retention. This isolated runtime replaces the seeded settings harness, whose server failed readiness.
- `playwright/tests/seeded/strategy/dialog.spec.ts`: passed source-backed F1 replay, desktop/mobile width parity, evidence/history disclosure, Escape/focus restoration and no page overflow. Desktop/mobile captures were inspected.
- Native LMU replay was not exercised; mixed front/rear resolution is covered by the shared/tracker regression, not claimed as native LMU E2E.

Browser runner: `playwright/stint-strategy.config.ts`. Passing evidence is retained under `playwright/test-results/compound-override-final`, `pit-ui-verified` and `pit-acceptance-final`.

### Review-fix verification (2026-10-21)

- T5: The settings browser scenario saves all four ACC/AC Evo dry/wet presets through the real HTTP API using native compound IDs. The shared/tracker regression verifies their independent cliff, dead, and limiting-lap predictions. Native ACC/AC Evo shared-memory capture was not exercised on macOS.
- T6: The existing persisted prior-session evidence browser scenario passes after restoring durable application before live publication, including source deletion and history-revision invalidation.
- Existing settings, threshold/restart, dialog, and saved-plan browser scenarios all pass. Backend/client typechecks and changed-path lint pass; the combined threshold/tracker/changelog run has 35 passing tests.
- Browser evidence: `playwright/test-results/review-fixes-final` contains the passing historical scenario; `playwright/test-results/review-existing-final` contains the four passing existing scenarios. Those mixed initial runs also contain superseded planner selector failures; corrected planner scenarios pass in `playwright/test-results/review-planner-final`.

Publishing preflight: all 15 translated catalogs have the full 2,906-key set and matching placeholders without changing existing translations. Inlang validation/compilation and runtime interpolation pass. Shared theme-token checks pass (9 tests); refreshed dialog and saved-plan browser scenarios pass after replacing raw text styles with shared tokens. Desktop/mobile captures were inspected in `playwright/test-results/push-hook-ui-final`. Initial hook failure evidence is retained at `playwright/test-results/publish-hooks/commit-first.log`.
