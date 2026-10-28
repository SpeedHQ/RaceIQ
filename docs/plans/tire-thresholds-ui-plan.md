# Tire threshold UI implementation

Contract: [shared boundary and acceptance](tire-thresholds-contract.md). Parallel implementation with [backend](tire-thresholds-backend-plan.md).

Owner: UI worker. Files: client/src/components/settings/GamesSection.tsx and focused new child if useful; client/src/stores/telemetry.ts; client/src/components/telemetry/PitEstimate.tsx; relevant localization messages and seeded settings E2E test. Coordinator owns F1LiveDashboard.tsx width change (already adds col-span-2).

1. Add per-game/per-compound remaining-health cliff/dead controls within Games settings, preserving game visibility. Select known compound presets and allow native custom compound names; unknown-source games expose default/unknown without inventing detected tire types. Save/reset via existing hooks; retain unsaved edits and show failure/pending state. T1/T3/T4.
2. Display truthful effective per-wheel thresholds, including mixed compounds and zero dead. Preserve existing pit estimate behavior and layout outside requested changes. T2/T4.
3. Add focused real-API Playwright scenario reusing seeded settings conventions: edit game/compound, save, reload, verify isolation, reset, invalid input and 0% dead. T1/T3/T4. Coordinator runs tests and actual surface inspection after settlement.
4. Add the shared pit estimate expand button and responsive accessible strategy-timeline dialog following the supplied prototype, populated from real trusted live strategy and existing evidence/history. D1/D2. Dialog worker owns PitEstimate.tsx and new dialog files; settings worker owns GamesSection and DisplaySettings. Separate message-key namespaces avoid shared-file conflicts.

Dialog edge handling: unknown lap/rates produce unavailable content rather than invented markers; zero and coincident limits remain readable; stale history cannot restore invalid projections; mixed per-wheel thresholds are labeled independently. Use existing Dialog focus, Escape and scroll behavior. E2E opens from the real F1 dashboard, checks readings/proportional marker positions, evidence/history, keyboard focus return and desktop/mobile overflow per shared D1/D2/W1.

Edges/handling: cannot save dead >= cliff or outside 0–100; empty values remain editable drafts, not silently persisted zero; reset removes only selected entry; save failure retains edits and alert; switching game/compound must not leak edits or values; no concurrent map overwrite from pending saves.

E2E: follow shared T1–T4 and W1 scenarios. Desktop/mobile actual F1 surface must prove pit row width equals left-column inner width with no overflow. Backend fixtures may aid UI development, but production API integration is required. No broad redesign or fake runtime fallback.

## Outcome

Implemented and verified against the [contract verification record](tire-thresholds-contract.md#verification). Settings controls, expanded real-data timeline, per-wheel labels, F1 column width, desktop/mobile behavior and keyboard lifecycle pass. Settings E2E now lives in `playwright/tests/seeded/strategy/settings-ui.spec.ts` and owns an isolated application runtime.

Review corrections T5/T6 are verified: settings saves all four native Kunos presets through the real API without aliases or custom-key migration. Existing settings, threshold, and dialog scenarios pass; see the [review-fix verification](tire-thresholds-contract.md#review-fix-verification-2026-10-21).
