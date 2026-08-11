# Analyse workspace migration

Migrated workspace leaf wiring in `AnalyseDataPanel`, `AnalyseTopSection`, `AnalyseVizPanel`, and `AnalyseTrackPanel` away from packet-shaped props. Workspace now accepts semantic telemetry frames and current semantic frame; map, segment list, steering, metrics, dynamics, tire, suspension, F1 ERS, visual, and chart-facing wiring use semantic frame contracts. Unavailable behavior remains frame-value driven.

Parent callsite changes required in `LapAnalyse.tsx`:
- Replace `currentPacket` / `currentDisplayPacket` props passed to `AnalyseTopSection` with `currentFrame={displayTelemetry[cursorIdx] ?? null}`.
- Keep `telemetry` and `displayTelemetry` as `SemanticAnalysisFrame[]`.
- Update `displayTelemetryRef` type to `RefObject<SemanticAnalysisFrame[]>`.
- Replace `currentPacket` / `currentDisplayPacket` passed to `AnalyseDataPanel` with `currentFrame={displayTelemetry[cursorIdx] ?? null}`.
- Ensure `AnalyseVizPanel` receives `currentFrame`, semantic `displayTelemetry`, and semantic ref through the top-section props.

Verification: client TypeScript was not run in this worker because sibling semantic visual signatures were concurrently landing; parent should run `pnpm exec tsc --noEmit -p client/tsconfig.json` after integration.