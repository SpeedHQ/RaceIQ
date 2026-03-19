# Insight Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tabbed "Insights" panel to the Analyse right sidebar that computes whole-lap summary insights (suspension, tires, driving, mechanical) with clickable items that jump the cursor.

**Architecture:** New `lap-insights.ts` module contains pure detection functions. New `InsightPanel.tsx` renders categorized insights. `LapAnalyse.tsx` gets a tab switcher in the right sidebar to toggle between existing "Live" metrics and new "Insights" view.

**Tech Stack:** React, TypeScript, Tailwind CSS, existing vehicle-dynamics.ts helpers

**Spec:** `docs/superpowers/specs/2026-03-19-insight-panel-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `client/src/lib/lap-insights.ts` | Create | Pure insight detection engine — takes `TelemetryPacket[]`, returns `LapInsight[]` |
| `client/src/components/InsightPanel.tsx` | Create | Renders categorized insights with click-to-jump |
| `client/src/components/LapAnalyse.tsx` | Modify | Add tab state, wire InsightPanel, pass `setCursorIdx` |

---

### Task 1: Insight Detection Engine — Types & Event Grouping

**Files:**
- Create: `client/src/lib/lap-insights.ts`

- [ ] **Step 1: Create lap-insights.ts with types and grouping utility**

```ts
// client/src/lib/lap-insights.ts
import type { TelemetryPacket } from "@shared/types";
import { allWheelStates } from "./vehicle-dynamics";

export type InsightCategory = "suspension" | "tires" | "driving" | "mechanical";
export type InsightSeverity = "info" | "warning" | "critical";

export interface LapInsight {
  id: string;
  category: InsightCategory;
  severity: InsightSeverity;
  label: string;
  detail: string;
  frameIndices: number[]; // middle frame of each event
}

/** Group consecutive true-valued frames into events. Returns array of [startIdx, endIdx] pairs. */
function groupEvents(flags: boolean[], minFrames: number): [number, number][] {
  const events: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) {
      if (start === -1) start = i;
    } else {
      if (start !== -1 && i - start >= minFrames) {
        events.push([start, i - 1]);
      }
      start = -1;
    }
  }
  if (start !== -1 && flags.length - start >= minFrames) {
    events.push([start, flags.length - 1]);
  }
  return events;
}

function midFrame(events: [number, number][]): number[] {
  return events.map(([s, e]) => Math.round((s + e) / 2));
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && npx tsc --noEmit --project client/tsconfig.json 2>&1 | head -20`
Expected: No errors related to lap-insights.ts

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/lap-insights.ts
git commit -m "feat(insights): add types and event grouping utility"
```

---

### Task 2: Suspension Detectors

**Files:**
- Modify: `client/src/lib/lap-insights.ts`

- [ ] **Step 1: Add suspension detection functions**

Append to `lap-insights.ts` after the utility functions:

```ts
// ── Suspension Insights ─────────────────────────────────────────────

function detectSuspensionOverload(telemetry: TelemetryPacket[]): LapInsight[] {
  const wheels = ["FL", "FR", "RL", "RR"] as const;
  const fields = {
    FL: "NormSuspensionTravelFL",
    FR: "NormSuspensionTravelFR",
    RL: "NormSuspensionTravelRL",
    RR: "NormSuspensionTravelRR",
  } as const;

  const insights: LapInsight[] = [];
  for (const w of wheels) {
    const flags = telemetry.map((p) => p[fields[w]] > 0.95);
    const events = groupEvents(flags, 3);
    if (events.length > 0) {
      insights.push({
        id: `susp-overload-${w}`,
        category: "suspension",
        severity: events.length >= 3 ? "critical" : "warning",
        label: "Suspension Overload",
        detail: `${w} bottomed out ${events.length} time${events.length > 1 ? "s" : ""}`,
        frameIndices: midFrame(events),
      });
    }
  }
  return insights;
}

function detectSuspensionImbalance(telemetry: TelemetryPacket[]): LapInsight | null {
  let totalDelta = 0;
  for (const p of telemetry) {
    const left = (p.NormSuspensionTravelFL + p.NormSuspensionTravelRL) / 2;
    const right = (p.NormSuspensionTravelFR + p.NormSuspensionTravelRR) / 2;
    totalDelta += left - right;
  }
  const avgDelta = totalDelta / telemetry.length;
  if (Math.abs(avgDelta) > 0.15) {
    const side = avgDelta > 0 ? "left" : "right";
    return {
      id: "susp-imbalance",
      category: "suspension",
      severity: Math.abs(avgDelta) > 0.25 ? "critical" : "warning",
      label: "Suspension Imbalance",
      detail: `${side} side ${Math.abs(avgDelta).toFixed(0)}% stiffer on average`,
      frameIndices: [Math.round(telemetry.length / 2)],
    };
  }
  return null;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && npx tsc --noEmit --project client/tsconfig.json 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/lap-insights.ts
git commit -m "feat(insights): add suspension overload and imbalance detection"
```

---

### Task 3: Tire Detectors

**Files:**
- Modify: `client/src/lib/lap-insights.ts`

- [ ] **Step 1: Add tire detection functions**

Append to `lap-insights.ts`:

```ts
// ── Tire Insights ───────────────────────────────────────────────────

function detectTireOverheat(telemetry: TelemetryPacket[]): LapInsight[] {
  const wheels = ["FL", "FR", "RL", "RR"] as const;
  const fields = {
    FL: "TireTempFL", FR: "TireTempFR", RL: "TireTempRL", RR: "TireTempRR",
  } as const;

  const insights: LapInsight[] = [];
  for (const w of wheels) {
    const flags = telemetry.map((p) => p[fields[w]] > 250);
    const events = groupEvents(flags, 10);
    if (events.length > 0) {
      const peak = Math.max(...telemetry.map((p) => p[fields[w]]));
      insights.push({
        id: `tire-overheat-${w}`,
        category: "tires",
        severity: peak > 300 ? "critical" : "warning",
        label: "Tire Overheat",
        detail: `${w} exceeded 250°F (peak ${peak.toFixed(0)}°F)`,
        frameIndices: midFrame(events),
      });
    }
  }
  return insights;
}

function detectLockups(telemetry: TelemetryPacket[]): LapInsight[] {
  const wheels = ["FL", "FR", "RL", "RR"] as const;
  const insights: LapInsight[] = [];

  for (const w of wheels) {
    const flags = telemetry.map((p) => {
      const ws = allWheelStates(p);
      return ws[w.toLowerCase() as "fl" | "fr" | "rl" | "rr"].state === "lockup";
    });
    const events = groupEvents(flags, 5);
    if (events.length > 0) {
      insights.push({
        id: `tire-lockup-${w}`,
        category: "tires",
        severity: events.length >= 3 ? "critical" : "warning",
        label: "Wheel Lockup",
        detail: `${w} locked ${events.length} time${events.length > 1 ? "s" : ""}`,
        frameIndices: midFrame(events),
      });
    }
  }
  return insights;
}

function detectWheelspin(telemetry: TelemetryPacket[]): LapInsight[] {
  const wheels = ["FL", "FR", "RL", "RR"] as const;
  const insights: LapInsight[] = [];

  for (const w of wheels) {
    const flags = telemetry.map((p) => {
      const ws = allWheelStates(p);
      return ws[w.toLowerCase() as "fl" | "fr" | "rl" | "rr"].state === "spin";
    });
    const events = groupEvents(flags, 5);
    if (events.length > 0) {
      insights.push({
        id: `tire-spin-${w}`,
        category: "tires",
        severity: events.length >= 3 ? "critical" : "warning",
        label: "Wheelspin",
        detail: `${w} spun ${events.length} time${events.length > 1 ? "s" : ""}`,
        frameIndices: midFrame(events),
      });
    }
  }
  return insights;
}

function detectWearImbalance(telemetry: TelemetryPacket[]): LapInsight | null {
  const last = telemetry[telemetry.length - 1];
  if (!last) return null;
  const wears = [last.TireWearFL, last.TireWearFR, last.TireWearRL, last.TireWearRR];
  const labels = ["FL", "FR", "RL", "RR"];
  const maxW = Math.max(...wears);
  const minW = Math.min(...wears);
  const delta = maxW - minW;
  if (delta > 0.15) {
    const maxLabel = labels[wears.indexOf(maxW)];
    const minLabel = labels[wears.indexOf(minW)];
    return {
      id: "tire-wear-imbalance",
      category: "tires",
      severity: delta > 0.3 ? "critical" : "warning",
      label: "Wear Imbalance",
      detail: `${minLabel} most worn, ${maxLabel} least (${(delta * 100).toFixed(0)}% spread)`,
      frameIndices: [telemetry.length - 1],
    };
  }
  return null;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && npx tsc --noEmit --project client/tsconfig.json 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/lap-insights.ts
git commit -m "feat(insights): add tire overheat, lockup, wheelspin, wear detectors"
```

---

### Task 4: Driving Detectors

**Files:**
- Modify: `client/src/lib/lap-insights.ts`

- [ ] **Step 1: Add driving detection functions**

Append to `lap-insights.ts`:

```ts
// ── Driving Insights ────────────────────────────────────────────────

function detectHarshBraking(telemetry: TelemetryPacket[]): LapInsight | null {
  const flags = telemetry.map((p) => p.AccelerationZ / 9.81 < -1.2);
  const events = groupEvents(flags, 3);
  if (events.length === 0) return null;
  return {
    id: "driving-harsh-brake",
    category: "driving",
    severity: events.length >= 5 ? "critical" : events.length >= 2 ? "warning" : "info",
    label: "Harsh Braking",
    detail: `${events.length} heavy brake zone${events.length > 1 ? "s" : ""} (> 1.2g)`,
    frameIndices: midFrame(events),
  };
}

function detectRevLimiter(telemetry: TelemetryPacket[]): LapInsight | null {
  if (telemetry.length === 0) return null;
  const maxRpm = telemetry[0].EngineMaxRpm;
  if (maxRpm === 0) return null;
  const flags = telemetry.map((p) => p.CurrentEngineRpm >= maxRpm - 50);
  const events = groupEvents(flags, 10);
  if (events.length === 0) return null;
  return {
    id: "driving-rev-limiter",
    category: "driving",
    severity: events.length >= 5 ? "warning" : "info",
    label: "Rev Limiter",
    detail: `Hit limiter ${events.length} time${events.length > 1 ? "s" : ""}`,
    frameIndices: midFrame(events),
  };
}

function detectCoasting(telemetry: TelemetryPacket[]): LapInsight | null {
  const flags = telemetry.map(
    (p) => p.Accel < 5 && p.Brake < 5 && p.Speed * 2.23694 > 20,
  );
  const events = groupEvents(flags, 30);
  if (events.length === 0) return null;
  const totalFrames = events.reduce((s, [a, b]) => s + (b - a + 1), 0);
  return {
    id: "driving-coasting",
    category: "driving",
    severity: totalFrames > 120 ? "warning" : "info",
    label: "Coasting",
    detail: `${events.length} zone${events.length > 1 ? "s" : ""}, ${((totalFrames / telemetry.length) * 100).toFixed(1)}% of lap`,
    frameIndices: midFrame(events),
  };
}

function detectTrailBraking(telemetry: TelemetryPacket[]): LapInsight | null {
  // Find braking zones (consecutive frames with brake > 10)
  const brakeFlags = telemetry.map((p) => p.Brake > 10);
  const brakeZones = groupEvents(brakeFlags, 3);
  if (brakeZones.length === 0) return null;

  let trailBrakedCount = 0;
  for (const [start, end] of brakeZones) {
    for (let i = start; i <= end; i++) {
      if (Math.abs(telemetry[i].Steer) > 15) {
        trailBrakedCount++;
        break;
      }
    }
  }
  const pct = (trailBrakedCount / brakeZones.length) * 100;
  return {
    id: "driving-trail-brake",
    category: "driving",
    severity: "info",
    label: "Trail Braking",
    detail: `${trailBrakedCount}/${brakeZones.length} brake zones (${pct.toFixed(0)}%)`,
    frameIndices: midFrame(brakeZones),
  };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && npx tsc --noEmit --project client/tsconfig.json 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/lap-insights.ts
git commit -m "feat(insights): add driving detectors (braking, rev limiter, coasting, trail brake)"
```

---

### Task 5: Mechanical Detectors & Main `analyzeLap` Export

**Files:**
- Modify: `client/src/lib/lap-insights.ts`

- [ ] **Step 1: Add mechanical detectors and the main export function**

Append to `lap-insights.ts`:

```ts
// ── Mechanical Insights ─────────────────────────────────────────────

function detectFuelConsumption(telemetry: TelemetryPacket[]): LapInsight | null {
  if (telemetry.length < 2) return null;
  const startFuel = telemetry[0].Fuel;
  const endFuel = telemetry[telemetry.length - 1].Fuel;
  const used = startFuel - endFuel;
  if (used <= 0) return null; // no fuel data or gain (pit?)
  const lapsRemaining = endFuel > 0 ? endFuel / used : Infinity;
  return {
    id: "mech-fuel",
    category: "mechanical",
    severity: lapsRemaining < 3 ? "critical" : lapsRemaining < 5 ? "warning" : "info",
    label: "Fuel",
    detail: `Used ${(used * 100).toFixed(1)}% — ~${lapsRemaining === Infinity ? "∞" : lapsRemaining.toFixed(1)} laps remaining`,
    frameIndices: [telemetry.length - 1],
  };
}

function detectPeakPower(telemetry: TelemetryPacket[]): LapInsight | null {
  if (telemetry.length === 0) return null;
  let peakIdx = 0;
  let peakVal = 0;
  for (let i = 0; i < telemetry.length; i++) {
    if (telemetry[i].Power > peakVal) {
      peakVal = telemetry[i].Power;
      peakIdx = i;
    }
  }
  if (peakVal === 0) return null;
  const pkt = telemetry[peakIdx];
  const hp = peakVal / 745.7;
  return {
    id: "mech-peak-power",
    category: "mechanical",
    severity: "info",
    label: "Peak Power",
    detail: `${hp.toFixed(0)} hp @ ${pkt.CurrentEngineRpm.toFixed(0)} RPM (gear ${pkt.Gear})`,
    frameIndices: [peakIdx],
  };
}

function detectBoostAnomaly(telemetry: TelemetryPacket[]): LapInsight | null {
  const maxBoost = Math.max(...telemetry.map((p) => p.Boost));
  if (maxBoost <= 0) return null; // no boost on this car

  // Rolling peak over last 60 frames
  const flags: boolean[] = new Array(telemetry.length).fill(false);
  let rollingPeak = 0;
  for (let i = 0; i < telemetry.length; i++) {
    rollingPeak = Math.max(rollingPeak, telemetry[i].Boost);
    // Decay: recalculate peak from window
    if (i >= 60) {
      rollingPeak = 0;
      for (let j = i - 59; j <= i; j++) {
        rollingPeak = Math.max(rollingPeak, telemetry[j].Boost);
      }
    }
    if (
      telemetry[i].Accel > 240 &&
      rollingPeak > 0 &&
      telemetry[i].Boost < rollingPeak * 0.5
    ) {
      flags[i] = true;
    }
  }
  const events = groupEvents(flags, 5);
  if (events.length === 0) return null;
  return {
    id: "mech-boost-anomaly",
    category: "mechanical",
    severity: events.length >= 3 ? "critical" : "warning",
    label: "Boost Drop",
    detail: `${events.length} unexpected boost drop${events.length > 1 ? "s" : ""} at full throttle`,
    frameIndices: midFrame(events),
  };
}

// ── Main Export ──────────────────────────────────────────────────────

export function analyzeLap(telemetry: TelemetryPacket[]): LapInsight[] {
  if (telemetry.length < 10) return [];

  const insights: LapInsight[] = [];

  // Suspension
  insights.push(...detectSuspensionOverload(telemetry));
  const imbalance = detectSuspensionImbalance(telemetry);
  if (imbalance) insights.push(imbalance);

  // Tires
  insights.push(...detectTireOverheat(telemetry));
  insights.push(...detectLockups(telemetry));
  insights.push(...detectWheelspin(telemetry));
  const wearImb = detectWearImbalance(telemetry);
  if (wearImb) insights.push(wearImb);

  // Driving
  const harsh = detectHarshBraking(telemetry);
  if (harsh) insights.push(harsh);
  const rev = detectRevLimiter(telemetry);
  if (rev) insights.push(rev);
  const coast = detectCoasting(telemetry);
  if (coast) insights.push(coast);
  const trail = detectTrailBraking(telemetry);
  if (trail) insights.push(trail);

  // Mechanical
  const fuel = detectFuelConsumption(telemetry);
  if (fuel) insights.push(fuel);
  const power = detectPeakPower(telemetry);
  if (power) insights.push(power);
  const boost = detectBoostAnomaly(telemetry);
  if (boost) insights.push(boost);

  return insights;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && npx tsc --noEmit --project client/tsconfig.json 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/lap-insights.ts
git commit -m "feat(insights): add mechanical detectors and main analyzeLap export"
```

---

### Task 6: InsightPanel Component

**Files:**
- Create: `client/src/components/InsightPanel.tsx`

- [ ] **Step 1: Create the InsightPanel component**

```tsx
// client/src/components/InsightPanel.tsx
import { useState } from "react";
import type { LapInsight, InsightCategory } from "../lib/lap-insights";

const CATEGORIES: { key: InsightCategory; icon: string; label: string }[] = [
  { key: "suspension", icon: "🔧", label: "Suspension" },
  { key: "tires", icon: "🛞", label: "Tires" },
  { key: "driving", icon: "🏎️", label: "Driving" },
  { key: "mechanical", icon: "⚙️", label: "Mechanical" },
];

const SEVERITY_COLOR: Record<string, string> = {
  info: "#94a3b8",
  warning: "#fbbf24",
  critical: "#ef4444",
};

function InsightRow({
  insight,
  onJump,
}: {
  insight: LapInsight;
  onJump: (idx: number) => void;
}) {
  const [eventIdx, setEventIdx] = useState(0);
  const hasMultiple = insight.frameIndices.length > 1;

  return (
    <button
      onClick={() => onJump(insight.frameIndices[eventIdx])}
      className="w-full text-left px-2 py-1.5 rounded hover:bg-slate-800/60 transition-colors group"
    >
      <div className="flex items-start gap-1.5">
        <span
          className="mt-1 w-1.5 h-1.5 rounded-full shrink-0"
          style={{ backgroundColor: SEVERITY_COLOR[insight.severity] }}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-mono text-slate-300 group-hover:text-white">
            {insight.label}
          </div>
          <div className="text-[10px] text-slate-500">{insight.detail}</div>
        </div>
      </div>
      {hasMultiple && (
        <div className="flex items-center gap-1 mt-1 ml-3">
          <button
            onClick={(e) => {
              e.stopPropagation();
              const prev = (eventIdx - 1 + insight.frameIndices.length) % insight.frameIndices.length;
              setEventIdx(prev);
              onJump(insight.frameIndices[prev]);
            }}
            className="text-[9px] text-slate-500 hover:text-white px-1"
          >
            ‹
          </button>
          <span className="text-[9px] text-slate-600 tabular-nums">
            {eventIdx + 1}/{insight.frameIndices.length}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              const next = (eventIdx + 1) % insight.frameIndices.length;
              setEventIdx(next);
              onJump(insight.frameIndices[next]);
            }}
            className="text-[9px] text-slate-500 hover:text-white px-1"
          >
            ›
          </button>
        </div>
      )}
    </button>
  );
}

export function InsightPanel({
  insights,
  onJumpToFrame,
}: {
  insights: LapInsight[];
  onJumpToFrame: (frameIdx: number) => void;
}) {
  return (
    <div className="space-y-3">
      {CATEGORIES.map(({ key, icon, label }) => {
        const items = insights.filter((i) => i.category === key);
        return (
          <div key={key}>
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-xs">{icon}</span>
              <h4 className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">
                {label}
              </h4>
              {items.length > 0 && (
                <span className="text-[9px] bg-slate-800 text-slate-400 rounded-full px-1.5 tabular-nums">
                  {items.length}
                </span>
              )}
            </div>
            {items.length === 0 ? (
              <div className="text-[10px] text-slate-600 pl-5">
                ✓ No issues detected
              </div>
            ) : (
              <div className="space-y-0.5">
                {items.map((insight) => (
                  <InsightRow
                    key={insight.id}
                    insight={insight}
                    onJump={onJumpToFrame}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && npx tsc --noEmit --project client/tsconfig.json 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add client/src/components/InsightPanel.tsx
git commit -m "feat(insights): add InsightPanel component with category sections and event navigation"
```

---

### Task 7: Wire Into LapAnalyse — Tab Switcher & Integration

**Files:**
- Modify: `client/src/components/LapAnalyse.tsx`

This task modifies the right sidebar in `LapAnalyse.tsx` to add tab switching between "Live" and "Insights" views.

- [ ] **Step 1: Add imports at top of LapAnalyse.tsx**

After the existing imports (around line 18), add:

```ts
import { analyzeLap } from "../lib/lap-insights";
import { InsightPanel } from "./InsightPanel";
```

- [ ] **Step 2: Add state and memoized insights inside the main LapAnalyse component**

Find the line `const [cursorIdx, setCursorIdx] = useState(0);` (line 532). After it, add:

```ts
const [sidebarTab, setSidebarTab] = useState<"live" | "insights">("live");
```

Find where `telemetry` is available after fetch (inside the loaded state). Add the memoized insights computation. Look for `const currentPacket = telemetry[cursorIdx] ?? null;` and add after it:

```ts
const lapInsights = useMemo(() => analyzeLap(telemetry), [telemetry]);
```

- [ ] **Step 3: Replace right sidebar content**

Find the right panel section (line ~1259):

```tsx
{/* Right panel – full height */}
<div className="w-80 shrink-0 border-l border-slate-800 overflow-y-auto bg-slate-900/50 p-3">
    <h3 className="text-[10px] text-slate-500 uppercase tracking-wider mb-2 font-semibold">
      Metrics at Cursor
    </h3>
```

Replace the opening of the right panel div through the "Metrics at Cursor" h3 with:

```tsx
{/* Right panel – full height */}
<div className="w-80 shrink-0 border-l border-slate-800 overflow-y-auto bg-slate-900/50 flex flex-col">
    {/* Tab switcher */}
    <div className="flex border-b border-slate-800 shrink-0">
      <button
        onClick={() => setSidebarTab("live")}
        className={`flex-1 py-1.5 text-[10px] uppercase tracking-wider font-semibold transition-colors ${
          sidebarTab === "live"
            ? "text-white border-b-2 border-cyan-400"
            : "text-slate-500 hover:text-slate-300"
        }`}
      >
        Live
      </button>
      <button
        onClick={() => setSidebarTab("insights")}
        className={`flex-1 py-1.5 text-[10px] uppercase tracking-wider font-semibold transition-colors ${
          sidebarTab === "insights"
            ? "text-white border-b-2 border-cyan-400"
            : "text-slate-500 hover:text-slate-300"
        }`}
      >
        Insights
        {lapInsights.length > 0 && (
          <span className="ml-1 text-[9px] bg-slate-700 text-slate-300 rounded-full px-1.5">
            {lapInsights.length}
          </span>
        )}
      </button>
    </div>

    <div className="p-3 flex-1 overflow-y-auto">
    {sidebarTab === "live" ? (
      <>
      <h3 className="text-[10px] text-slate-500 uppercase tracking-wider mb-2 font-semibold">
        Metrics at Cursor
      </h3>
```

- [ ] **Step 4: Close the live tab and add the insights tab**

Find the closing of the right panel content — look for the closing `</div>` that ends the right sidebar (after the Wheels/Suspension section around line 1407-1408). Replace the final closing structure:

The existing code ends roughly like:
```tsx
                </div>
              </>
            )}
        </div>
```

Replace with:
```tsx
                </div>
              </>
            )}
      </>
    ) : (
      <InsightPanel insights={lapInsights} onJumpToFrame={setCursorIdx} />
    )}
    </div>
</div>
```

Make sure the outer `</div>` for the right panel is preserved.

- [ ] **Step 5: Verify it compiles**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && npx tsc --noEmit --project client/tsconfig.json 2>&1 | head -20`

- [ ] **Step 6: Run the dev server and visually verify**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && npm run dev`

Check:
1. Navigate to Analyse view, select a lap
2. Right sidebar shows "Live" and "Insights" tabs
3. "Live" tab shows existing metrics (unchanged)
4. "Insights" tab shows categorized insights
5. Clicking an insight jumps the cursor on the track map and charts

- [ ] **Step 7: Commit**

```bash
git add client/src/components/LapAnalyse.tsx
git commit -m "feat(insights): wire InsightPanel into LapAnalyse with tab switcher"
```

---

## Summary

| Task | Description | New/Modified |
|------|-------------|-------------|
| 1 | Types + event grouping utility | Create `lap-insights.ts` |
| 2 | Suspension detectors | Modify `lap-insights.ts` |
| 3 | Tire detectors | Modify `lap-insights.ts` |
| 4 | Driving detectors | Modify `lap-insights.ts` |
| 5 | Mechanical detectors + `analyzeLap` | Modify `lap-insights.ts` |
| 6 | InsightPanel component | Create `InsightPanel.tsx` |
| 7 | Wire into LapAnalyse with tabs | Modify `LapAnalyse.tsx` |
