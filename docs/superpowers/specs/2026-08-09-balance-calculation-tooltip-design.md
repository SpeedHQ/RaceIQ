# Balance Calculation Tooltip

## Goal
Restore the Analyse data-panel Balance hover tooltip that explains the balance classification and shows how current signals contribute to it.

## Scope
- Modify the Balance label in `client/src/components/analyse/AnalyseDynamicsPanel.tsx`.
- Reuse current `SteerBalance` output from `steerBalanceFromSignals`/the semantic analysis path; do not change calculation logic.
- Show tooltip only when Balance is available. Preserve existing unavailable rendering.

## Content
- Explain that balance combines yaw-rate/path-curvature error with front/rear slip-angle delta.
- Explain signs: positive means understeer; negative means oversteer.
- Explain yaw gating below the lateral-acceleration threshold and why straight-line wheelspin is ignored.
- Show Slip Delta and Yaw signal rows, current values, normalized positions, threshold bands, signal reliability, and whether signals agree.
- Show the combined balance bar with oversteer, neutral, and understeer regions.

## Interaction and accessibility
- Tooltip opens on pointer hover and keyboard focus of the Balance label/info affordance.
- Trigger has an accessible label and visible focus treatment.
- Tooltip is non-interactive and does not capture pointer events.
- Keep tooltip positioned within the data-panel viewport using the existing compact panel styling.

## Non-goals
- No changes to balance formulas, thresholds, semantic frame contracts, or other metric tooltips.
- No new tooltip library or global design-system component.

## Verification
- Add/update focused component or helper coverage for available and unavailable Balance states if existing test conventions support it.
- Run client TypeScript checks and targeted formatting checks.
- Run seeded Analyse telemetry Playwright coverage and manually verify hover/focus visibility in the data panel.
