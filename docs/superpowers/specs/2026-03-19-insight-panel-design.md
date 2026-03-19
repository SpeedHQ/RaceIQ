# Insight Panel — Lap Summary Analysis

## Overview

Add a **Lap Insights** tab to the right sidebar in the Analyse view. It computes whole-lap summary insights across 4 categories (suspension, tires, driving, mechanical) and displays them as clickable items that jump the cursor to the relevant telemetry frame.

## Architecture

### Tab System

The right sidebar (`w-80`) gets two tabs at the top:
- **Live** — existing MetricsPanel + Dynamics + Wheels (current cursor-based content)
- **Insights** — new lap summary panel

Tab state is local `useState`. Both tabs share the same scrollable container.

### Insight Engine (`client/src/lib/lap-insights.ts`)

A pure function that takes `TelemetryPacket[]` and returns categorized insights:

```ts
interface LapInsight {
  id: string;
  category: "suspension" | "tires" | "driving" | "mechanical";
  severity: "info" | "warning" | "critical";
  label: string;        // e.g. "Suspension Overload"
  detail: string;       // e.g. "FL bottomed out 3 times"
  frameIndices: number[]; // telemetry indices where this occurred
}

function analyzeLap(telemetry: TelemetryPacket[]): LapInsight[];
```

Wrapped in `useMemo` keyed on `telemetry` reference — computed once per lap load.

### Detection Rules

**Suspension**
- **Overload**: `NormSuspensionTravel > 0.95` sustained for 3+ frames on any wheel. Group consecutive frames into events.
- **Imbalance**: Per-frame left bias = `(FL + RL) / 2 - (FR + RR) / 2`. Average absolute value across lap > 0.15 = imbalance. Report which side is stiffer.

**Tires**
- **Overheat**: Any tire temp > 250°F sustained for 10+ frames. Report peak temp and wheel.
- **Lockup**: `wheelState === "lockup"` for 5+ consecutive frames (using existing `allWheelStates`).
- **Wheelspin**: `wheelState === "spin"` for 5+ consecutive frames.
- **Wear imbalance**: Max wear delta between any two wheels > 0.15 at lap end.

**Driving**
- **Harsh braking**: Longitudinal G < -1.2g for 3+ frames. Group into events.
- **Rev limiter**: RPM within 50 of `EngineMaxRpm` for 10+ frames. Count distinct events.
- **Coasting**: Neither throttle (< 5/255) nor brake (< 5/255) for 30+ frames at speed > 20mph.
- **Trail braking**: A "braking zone" = consecutive frames where brake > 10/255. A zone "uses trail braking" if any frame within it also has steer > 15/127. Report count of trail-braked zones / total braking zones as a percentage.

**Mechanical**
- **Fuel consumption**: Total fuel used (`telemetry[0].Fuel - telemetry[last].Fuel`), rate per lap. Projected laps = remaining / used (assumes constant burn, no refueling).
- **Peak power**: Frame with highest Power value, and what RPM/gear it occurred at.
- **Boost anomaly**: If car has boost (max boost > 0 across lap), track rolling peak over last 60 frames. Flag frames where boost < 50% of rolling peak while throttle > 240/255. Group into events.

### Event Grouping

Consecutive frames matching a condition are grouped into a single "event." Each event stores its start/end frame indices. The `frameIndices` array on each insight points to the middle frame of each event (best representative point for cursor jump).

### InsightPanel Component

```
InsightPanel({ insights, onJumpToFrame })
```

- Groups insights by category
- Each category is a section with a header icon + count badge
- Each insight row shows: severity dot (green/yellow/red) + label + detail
- Click on an insight calls `onJumpToFrame(frameIndices[0])` to jump cursor
- If multiple events, show a small "1/3 >" navigator to cycle through them
- Empty state: green checkmark + "No issues detected" per category

### Cursor Jump Integration

`LapAnalyse` already manages `cursorIdx` state. The insight click handler simply calls `setCursorIdx(frameIndex)`, which already updates the track map, charts, and metrics panel.

### Segment Awareness

Where segments data is available, insights reference segment names: "Suspension overload in Turn 5" rather than just frame numbers.

## Visual Design

Matches existing sidebar style:
- `text-[10px]` uppercase tracking-wider headers per category
- `text-[11px]` font-mono for insight rows
- Severity colors: info = `#94a3b8` (slate), warning = `#fbbf24` (amber), critical = `#ef4444` (red)
- Category icons as emoji: suspension = spring, tires = wheel, driving = steering, mechanical = wrench
- Tab buttons: small pill-style toggles matching the dark theme

## File Changes

| File | Change |
|------|--------|
| `client/src/lib/lap-insights.ts` | **New** — insight detection engine |
| `client/src/components/InsightPanel.tsx` | **New** — insight display component |
| `client/src/components/LapAnalyse.tsx` | Add tab state, wire InsightPanel into right sidebar |

## Non-Goals

- No persistence of insights (computed fresh each lap load)
- No chart overlay/highlighting of insight regions (future enhancement)
- No custom threshold configuration (hardcoded for now)
