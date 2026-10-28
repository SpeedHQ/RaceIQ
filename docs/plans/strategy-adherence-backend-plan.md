# Strategy adherence live producer implementation

Shared [contract](strategy-adherence-contract.md); parallel [UI plan](strategy-adherence-ui-plan.md).

## Scope and ownership

The coordinator owns `packages/telemetry-core/src/telemetry/live/semantics.ts`, `live-projector.ts`, and the focused live-semantics regression module. Subscribe to the existing `timing.lap-fraction` derivation for F1 and AC Evo, where the authoritative telemetry catalog declares it available. Feed the F1 track-length reader the actual native SESSION observation time already exposed as `f1.safetyCarStatusUpdatedAt`; both values originate in that same packet. Do not replace source time with receipt time or disable stale checks. No new endpoint, database table, authentication rule, or derivation algorithm is required. UI development remains independent through contract-conforming fixtures; final real integration is a completion dependency.

## Acceptance and edges

- B1: Native F1 live frames include a resolved fractional lap when distance and fresh track length are available, including races longer than five minutes; the real selected strategy can calculate its window. Reuse E-A1 through the native F1 helper and actual compiled application. The producer regression renews unchanged track metadata at ten minutes using its native SESSION timestamp.
- B2: Missing, invalid, or genuinely expired derivation inputs remain unavailable, never zero-filled. Extend E-A3 with native zero track-length packets, then restore the valid source and observe recovery without changing the saved plan. The producer regression also checks stale SESSION metadata and recovery. Unsupported games retain their existing schema and unknown position behavior.
- B3: AC Evo subscribes to its existing supported derivation; retain the telemetry resolver's existing native-distance and missing-input behavior. Run the complete existing derivation modules and the affected telemetry-core gates, supplemented by E-A1/B2 system integration.

## Tasks and verification

Update the supported game subscriptions and F1 source-time reader after checking exported references. Extend the existing F1 source helper to refresh SESSION packets on its accelerated native clock and accept an optional invalid track-length input. Run complete affected resolver modules, compiled application build, and the full `race-plan.spec.ts` E2E module. Record outcomes in the shared contract; planned or unexecuted scenarios are not passing evidence.

## F1 correction

Implement F1.1/F1.2 using the shared `supportsRaceRefueling` rule. `server/pit-tracker.ts` and `server/durable-strategy.ts` retain measured consumption but never emit a fuel-limited F1 pit or a refueling suggestion. `contracts/generate-race-plan.ts` uses tire limits for F1 stops; validate one initial race fuel budget instead of splitting into refueling stints. `server/race-plan-recalculation.ts` carries that initial budget through compound phases rather than restoring capacity. Existing non-F1 generation and fuel/energy constraints remain unchanged.

Extend the established feature integration modules for low fuel versus identical tires, F1 generation without fuel stops, insufficient initial budget, cumulative phase fuel, and unchanged refueling-capable game behavior. The coordinator runs these complete modules and the corrected native E-F1 scenarios after both independent implementations settle.

Executed B1/B2 native F1 integration, B3 telemetry-core checks and LMU native-source-to-browser evidence are recorded in the [shared contract outcomes](strategy-adherence-contract.md#outcomes). The LMU correction now has live pipeline proof with controlled native memory, separate from earlier recorded-file energy tests; the physical Windows mapping remains outside the exercised environment.

## LMU native-live correction

Own LMU-L1–LMU-L4 against the [shared native-live contract](strategy-adherence-contract.md#lmu-native-live-correction). Restore validated optional `lmu.lapDistancePct` in the native normalizer and shared type, regenerate the existing catalog binding, and preserve actual source timestamps and unavailable states. Owned files are the LMU normalizer/type, generated catalog outputs and the focused LMU source regression; the coordinator owns native-memory test composition and E-LMU integration. Valid zero/end-of-lap fractions resolve; missing/nonfinite/out-of-range distance and invalid length remain unknown. Run complete LMU and live-resolver modules, catalog determinism, build/types/lint and the shared compiled E-LMU application scenario. UI remains independent against the unchanged live semantic contract.
