# Task 10 report

- Commit: `c94b0ee8` (`feat(task10): migrate combo and tune dashboards`)
- Combo routes now consume `telemetryView`, with semantic speed/gear/RPM/lap/tire values and `LivePitData` strategy data. Legacy packet props remain optional for story fixtures only.
- `ComboDash2` and combo routes use semantic track identity.
- `ExperimentWorkspace` uses `LivePitData.fuelPerLap`; `NewF1ExperimentModal` resolves live car/track from semantic identity.
- Removed unavailable packet/rawPacket store selectors from `LiveTestDashboard`; trace remains bounded and compile-safe.
- Verification: `bunx tsc -p client/tsconfig.json --noEmit --pretty false` passed.
- Full client build reached Vite bundle successfully; repository has unrelated pre-existing server/client raw-route TypeScript errors outside this change.
