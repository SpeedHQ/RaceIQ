# Analyse Dynamics Metric Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove lateral slip, Grip Ask, and suspension from the compact Analyse summary so they appear only under the Dynamics section.

**Architecture:** Keep `MetricsPanel` responsible for primary cursor metrics. Keep existing `AnalyseDynamicsPanel`, `AnalyseTireWheelsPanel`, and `AnalyseSuspensionPanel` responsible for grouped dynamics details. Change presentation only; no telemetry or resolver changes.

**Tech Stack:** React, TypeScript, Bun tests, Playwright seeded Analyse fixtures.

## Global Constraints

- Change only Analyse right-panel presentation.
- Do not change telemetry IDs, resolver behavior, API contracts, or metric calculations.
- Preserve existing Dynamics subsection order: G-Force, Traction/temperature/surface, Grip Ask, Slip, Wheels, Suspension.
- No new abstraction or shared layout component.

---

### Task 1: Remove duplicated summary metrics

**Files:**
- Modify: `client/src/components/analyse/AnalyseMetricsPanel.tsx:31-52`
- Test: `client/test/telemetry-capabilities-ui.test.ts`

**Interfaces:**
- Consumes existing `SemanticAnalysisFrame`, `GameId`, and telemetry capability contracts.
- Produces the same `MetricsPanel` API with only primary cursor metrics rendered.

- [ ] **Step 1: Add focused failing assertions**

Extend the existing static UI contract test for Analyse metrics to assert its rendered markup does not contain `Lateral slip`, `Grip Ask`, or the suspension summary label, while retaining `Speed`, `Throttle`, and `Fuel`.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
bun test ./client/test/telemetry-capabilities-ui.test.ts
```

Expected: the new absence assertions fail against current `MetricsPanel` markup.

- [ ] **Step 3: Remove only duplicated rows and dead calculations**

In `AnalyseMetricsPanel.tsx`, remove the `suspension`, `suspensionDisplay`, `lateralSlip`, and `combinedSlip` calculations when no longer used. Remove the three JSX rows for lateral slip, Grip Ask, and suspension. Preserve all other rows and capability guards.

- [ ] **Step 4: Run the focused test and verify pass**

Run:

```bash
bun test ./client/test/telemetry-capabilities-ui.test.ts
```

Expected: all assertions pass, including retained primary metrics and absent duplicate rows.

- [ ] **Step 5: Commit the presentation change**

```bash
git add client/src/components/analyse/AnalyseMetricsPanel.tsx client/test/telemetry-capabilities-ui.test.ts
git commit -m "fix: group analyse metrics under dynamics"
```

### Task 2: Verify Dynamics grouping remains intact

**Files:**
- Inspect: `client/src/components/analyse/AnalyseDataPanel.tsx`
- Inspect: `client/src/components/analyse/AnalyseDynamicsPanel.tsx`
- Test: `client/test/telemetry-capabilities-ui.test.ts`

**Interfaces:**
- Consumes the unchanged Dynamics panel components.
- Produces a focused UI contract proving grouped labels remain available below the Dynamics heading.

- [ ] **Step 1: Add grouped-label assertions**

Extend the same UI contract test to assert `AnalyseDataPanel` composition includes the Dynamics heading and the existing Dynamics-owned labels: `Grip Ask`, `Slip`, and `Suspension`.

- [ ] **Step 2: Run focused UI tests**

Run:

```bash
bun test ./client/test/telemetry-capabilities-ui.test.ts
```

Expected: pass with summary absence and Dynamics presence assertions.

- [ ] **Step 3: Commit test coverage**

```bash
git add client/test/telemetry-capabilities-ui.test.ts
git commit -m "test: enforce analyse dynamics grouping"
```

### Task 3: Verify build and browser behavior

**Files:**
- No source changes expected unless focused checks expose a regression.

- [ ] **Step 1: Run client build**

```bash
bun run build
```

Expected: Vite and TypeScript build pass.

- [ ] **Step 2: Run seeded Analyse browser smoke**

```bash
PW_SERVER_SET=seeded bunx playwright test tests/seeded/analyse/telemetry.spec.ts --project=seeded-e2e --max-failures=1
```

Expected: all seeded Analyse tests pass. Inspect the rendered Data panel and confirm compact summary no longer contains the three moved metrics while Dynamics still contains them.

- [ ] **Step 3: Commit any verified final adjustment**

```bash
git status --short
```

If no adjustment is required, leave source unchanged. If a focused adjustment is required, commit it with a message describing the concrete regression.
