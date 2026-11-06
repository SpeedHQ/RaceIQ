---
name: raceiq-ams2-replay-estimated-dynamics
description: "Implement and verify disclosed AMS2 Replay Slip Angle, canonical Balance status, Grip Ask, Traction, and Slip Ratio in existing telemetry displays."
---

# AMS2 Replay estimated dynamics

- Preserve existing table labels, rows, units, colors, and status meanings. Never replace Balance classification with sideslip degrees or create parallel UI.
- Balance uses existing Neutral/Understeer/Oversteer classification via `resolveBalance` / `steerBalanceFromSignals`, actual speed, lateral acceleration and yaw rate, plus finite per-wheel estimated angles where available. Signed vehicle sideslip is not Balance.
- AMS2 provides `tires.wheel-rotation-speed` in rad/s. Reuse `resolveWheelStates`, `resolveGripDemand`, `wheelDynamicsFrame`, `frictionCircleUtil`, and `tireState` rather than new dynamics algorithms. Keep Grip Ask percentages and Traction GRIP/SLIP/SLIDE/SPIN/LOCK/IDLE statuses.
- The existing Data panel Ratio row displays the same longitudinal slip ratios used internally by Grip Ask/Traction, multiplied by 100 with `%`. User authorized this display. No native AMS2 slip-ratio channel is needed; preserve null if required inputs are missing.
- Ratio has a yellow Info icon and tooltip: calculate wheel speed from recorded rotation times tire radius; ratio is (wheelSpeed − vehicleSpeed)/max(wheelSpeed,vehicleSpeed,0.1). Disclose inferred radius from the two slowest wheels and the existing 0.33 m low-speed/rotation fallback; estimate is not direct measurement.
- AMS2 does not provide tire slip angle. Estimate from recorded position/yaw history, steering, and geometry. All estimated Angle values need yellow Info icon and base disclosure; add proxy caveat only for approximate geometry. Exact geometry still requires disclosure.
- Fractional replay times must pair previous sample with enclosing right-hand sample; exact times use current→next. Never coerce null angles to zero in regression assertions.
- Synthetic angles need matching local `ok` states when resolvers inspect `frame.states`; do not mutate native recordings. Missing/invalid signals and unavailable history stay unavailable, not fake neutral or zero. Honor speed guards, gaps and run boundaries.
- Relevant paths: `packages/lap-replay/ui/spectate-replay.ts`, `SpectateDataPanel.tsx`, `SpectateInputs.tsx`, `client/src/components/analyse/AnalyseDynamicsPanel.tsx`, `AnalyseDataPanel.tsx`, and replay contracts.
- Build browser before compiled E2E. Run targeted `AMS2 reduced-rate Polo replay` scenario for table/dashboard statuses, Ratio percentages and disclosure. Reuse non-AMS2 Balance regression; run replay unit tests when estimator changes and changelog test when release notes change. Fixture E2E does not prove user's separate review URL was updated.
