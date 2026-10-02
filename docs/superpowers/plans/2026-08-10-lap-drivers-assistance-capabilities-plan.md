# Lap-Level DRS/ERS Capability Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect DRS and ERS support across an Analyse lap and render only supported data sections.

**Architecture:** A pure helper scans `SemanticAnalysisFrame[]` and returns independent `{ hasDrs, hasErs }` flags. DRS support requires an explicit valid `aero.drs-available` value or an observed active state; a lone `aero.drs-active: false` is not capability evidence. ERS support requires a valid ERS value. `LapAnalyse` derives those flags from the loaded lap frames and passes them through `AnalyseDataPanel` to `AnalyseF1ErsPanel`; the panel no longer infers support from only the cursor frame.

**Tech Stack:** React 19, TypeScript, Bun test, React server-side static markup, existing semantic telemetry frame types.

## Global Constraints

- Detect capabilities from the complete selected lap, not only `currentFrame`.
- Treat DRS as supported when any valid frame exposes `aero.drs-available`, or when `aero.drs-active` is observed as `true`/`1`.
- Do not treat `aero.drs-active: false`/`0` alone as support; AC Evo publishes that state for cars without DRS.
- DRS and ERS capabilities are independent.
- Omit unsupported sections entirely.
- Do not render placeholder dashes for missing unsupported data.
- Keep current-frame values as the source for displayed DRS/ERS values.
- Do not add game-specific capability flags; AC Evo support can vary by car/lap.

---

### Task 1: Add pure lap capability detection

**Files:**
- Create: `client/src/components/analyse/analyse-capabilities.ts`
- Test: `client/test/analyse-capabilities.test.ts`

**Interfaces:**
- Consumes: `SemanticAnalysisFrame[]` from `./track-map/types`.
- Produces: `detectLapCapabilities(frames): { hasDrs: boolean; hasErs: boolean }`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { detectLapCapabilities } from "../src/components/analyse/analyse-capabilities";

const frame = (values: Record<string, unknown>) => ({ values, states: {}, freshness: {} });

describe("detectLapCapabilities", () => {
  test("detects explicit DRS availability and ERS anywhere in an F1-shaped lap", () => {
    expect(detectLapCapabilities([
      frame({ "aero.drs-available": false }),
      frame({ "fuel.ers-store-energy": 2_000_000 }),
    ])).toEqual({ hasDrs: true, hasErs: true });
  });

  test("does not infer AC Evo DRS support from an inactive state", () => {
    expect(detectLapCapabilities([frame({ "aero.drs-active": false })])).toEqual({ hasDrs: false, hasErs: false });
  });

  test("detects neither for a Forza-shaped lap", () => {
    expect(detectLapCapabilities([frame({ "motion.speed": 40 })])).toEqual({ hasDrs: false, hasErs: false });
  });

  test("detects DRS and ERS independently", () => {
    expect(detectLapCapabilities([frame({ "aero.drs-active": true })])).toEqual({ hasDrs: true, hasErs: false });
    expect(detectLapCapabilities([frame({ "fuel.ers-deployed": 100 })])).toEqual({ hasDrs: false, hasErs: true });
  });

  test("ignores invalid values", () => {
    expect(detectLapCapabilities([frame({ "aero.drs-available": null, "aero.drs-active": 0, "fuel.ers-store-energy": Number.NaN })])).toEqual({ hasDrs: false, hasErs: false });
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `bun test ./test/analyse-capabilities.test.ts` from `client`.
Expected: FAIL because `analyse-capabilities.ts` and `detectLapCapabilities` do not exist.

- [ ] **Step 3: Implement minimal detector**

Treat an `aero.drs-available` boolean or `0`/`1` as explicit capability evidence. Treat `aero.drs-active` as evidence only when it is `true`/`1`; inactive `false`/`0` alone must not enable DRS. Implement finite-number validation for ERS fields. Ignore values whose resolution state is explicitly non-`ok`; return early once each capability is found, while still returning false for empty input.

- [ ] **Step 4: Run focused tests**

Run: `bun test ./test/analyse-capabilities.test.ts` from `client`.
Expected: all capability tests pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/analyse/analyse-capabilities.ts client/test/analyse-capabilities.test.ts
git commit -m "test: detect lap DRS and ERS capabilities"
```

### Task 2: Wire lap capabilities into Analyse rendering

**Files:**
- Modify: `client/src/components/analyse/LapAnalyse.tsx`
- Modify: `client/src/components/analyse/AnalyseDataPanel.tsx`
- Modify: `client/src/components/analyse/AnalyseF1ErsPanel.tsx`
- Test: `client/test/telemetry-capabilities-ui.test.ts`

**Interfaces:**
- Consumes: `detectLapCapabilities(semanticFrames)` from Task 1.
- Produces: `AnalyseDataPanel` receives `{ hasDrs, hasErs }`; `AnalyseF1ErsPanel` renders only sections whose flags are true.

- [ ] **Step 1: Add failing UI assertions**

Extend the existing telemetry capability UI test. Assert that a panel with both flags produces `analyse_drs_ers`, `DRS`, and `ERS`; DRS-only output excludes ERS; ERS-only output excludes DRS; and both false returns empty markup. Also render `AnalyseDataPanel` with `gameId="ac-evo"` and DRS-only capabilities so the test exercises the real mount path rather than only the leaf panel.

- [ ] **Step 2: Run focused UI test and verify failure**

Run: `bun test ./test/telemetry-capabilities-ui.test.ts` from `client`.
Expected: new assertions fail because the panel still infers both capabilities from only `frame` and has no lap capability props.

- [ ] **Step 3: Wire flags from lap frames**

In `LapAnalyse`, derive `const lapCapabilities = useMemo(() => detectLapCapabilities(semanticFrames), [semanticFrames]);` and include it in `dataPanelProps`. Add the corresponding prop to `AnalyseDataPanel`, remove the existing `getGame(gameId).telemetry.ers` mount gate, and mount/pass `AnalyseF1ErsPanel` whenever `hasDrs || hasErs`.

- [ ] **Step 4: Render independent sections without placeholders**

Update `AnalyseF1ErsPanel` to accept `hasDrs` and `hasErs`. Keep existing current-frame extraction for values. Render DRS markup only when `hasDrs`; render ERS markup only when `hasErs`; return `null` when both are false. Remove current-frame capability inference and avoid placeholder text for omitted sections.

- [ ] **Step 5: Run focused tests**

Run: `bun test ./test/analyse-capabilities.test.ts ./test/telemetry-capabilities-ui.test.ts` from `client`.
Expected: all new and existing focused tests pass.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/analyse/LapAnalyse.tsx client/src/components/analyse/AnalyseDataPanel.tsx client/src/components/analyse/AnalyseF1ErsPanel.tsx client/test/telemetry-capabilities-ui.test.ts
git commit -m "feat: show lap-supported DRS and ERS data"
```

### Task 3: Verify Analyse behavior

**Files:**
- Test: `client/test/analyse-capabilities.test.ts`
- Test: `client/test/telemetry-capabilities-ui.test.ts`

**Interfaces:**
- Consumes: completed lap-wide capability detector and panel wiring.
- Produces: verified behavior for F1, Forza, DRS-only, ERS-only, and invalid telemetry.

- [ ] **Step 1: Run focused test suite**

Run: `bun test ./test/analyse-capabilities.test.ts ./test/telemetry-capabilities-ui.test.ts` from `client`.
Expected: PASS.

- [ ] **Step 2: Run client typecheck/build smoke test**

Run: `bun run build` from `client`.
Expected: Vite build and TypeScript project build complete successfully.

- [ ] **Step 3: Inspect final diff**

Run: `git diff --check HEAD~2..HEAD` and confirm both capability-detection and Analyse-wiring commits contain only the planned source and test changes.
Expected: no whitespace errors and no unrelated files.
