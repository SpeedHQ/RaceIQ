# Balance Calculation Tooltip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the Analyse Balance hover/focus tooltip explaining classification, component signals, gating, and blended calculation.

**Architecture:** Keep balance math in `shared/racing/analysis/laps/physics/vehicle.ts`. Add presentation-only tooltip markup to `AnalyseDynamicsPanel`, using the existing `SteerBalance` fields returned by `steerBalanceFromSignals`. Use the existing compact inline tooltip styling rather than adding a dependency or global component.

**Tech Stack:** React, TypeScript, Tailwind utility classes, inline SVG, existing semantic telemetry frame contract, Playwright seeded Analyse tests.

## Global Constraints

- Do not alter balance formulas, thresholds, semantic frame contracts, or other metric tooltips.
- Render tooltip only when Balance is available.
- Tooltip must open on pointer hover and keyboard focus.
- Tooltip must be non-interactive and pointer-events disabled.
- Preserve existing unavailable Balance output.

---

### Task 1: Restore Balance tooltip presentation

**Files:**
- Modify: `client/src/components/analyse/AnalyseDynamicsPanel.tsx:33-78`
- Test: `test/analysis/data-panel-parity.test.ts` (only if a deterministic helper assertion is needed; no DOM snapshot test)

**Interfaces:**
- Consumes: `balance: SteerBalance` returned by `steerBalanceFromSignals(...)`; `balance.state`, `balance.balance`, `balance.uSlip`, `balance.uYaw`, `balance.frontSlipDeg`, `balance.rearSlipDeg`, `balance.yawError`, `balance.yawRatePath`, `balance.signalsAgree`, and current speed.
- Produces: Balance label with a focusable info affordance and tooltip containing signal explanation and SVG breakdown.

- [ ] **Step 1: Add tooltip trigger semantics**

Wrap the available Balance label in a `group relative` container. Add an `Info` icon with `tabIndex={0}`, an accessible `aria-label` describing Balance calculation, and `focus-visible` styling. Keep the unavailable branch as plain label plus unavailable value.

- [ ] **Step 2: Add calculation explanation**

Render a positioned, non-interactive tooltip under the Balance label with compact panel classes. Include:

```tsx
Yaw rate vs path curvature + front/rear slip-angle delta.
+ = understeer (front slip > rear) | − = oversteer (body yawing past Ay/V)
Gated by |latG| ≥ 0.25g — straight-line wheelspin ignored
```

Use `balance.frontSlipDeg`, `balance.rearSlipDeg`, `balance.yawError`, and `balance.yawRatePath` for current signal descriptions.

- [ ] **Step 3: Render signal and combined bars**

Use a compact inline SVG with three horizontal bars: Slip Δ, Yaw, and Combined. Map normalized values to the existing `[-1.0, +1.0]` display range, draw neutral/threshold bands at `±0.3`, color markers using existing balance color helpers, and show the current signal agreement state. Fade the Yaw row using `Math.min(1, balance.yawRatePath / 0.15)` so low-reliability yaw is visible.

- [ ] **Step 4: Verify unavailable behavior in code path**

Confirm the tooltip and info icon are not rendered when `resolveAnalysisTelemetry(getGame(gameId)).balance.source === "unavailable"`; the existing unavailable value remains unchanged.

- [ ] **Step 5: Run focused checks**

Run:

```bash
bunx tsc -p client/tsconfig.json --noEmit
bunx biome check client/src/components/analyse/AnalyseDynamicsPanel.tsx
bun test test/analysis/data-panel-parity.test.ts
bun run test:e2e:seeded -- telemetry.spec.ts --project=seeded-e2e
```

Expected: all commands pass; seeded telemetry suite reports 5 passed.

- [ ] **Step 6: Manually verify interaction**

Open the seeded Analyse data panel. Hover the Balance label/info icon and confirm tooltip visibility. Tab to the icon and confirm the same tooltip appears on keyboard focus. Confirm tooltip disappears on blur and does not intercept pointer input.
