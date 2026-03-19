# Settings Modal + Speed/Distance Units

**Date**: 2026-03-19
**Status**: Draft

## Overview

Three changes: (1) render Settings as a modal overlay instead of pushing down page content, (2) add speed/distance unit preference (mph/mi vs km/h/km) following the same pattern as temperature units, (3) add car body attitude (yaw/roll/pitch) visualization to the analyse page track map.

## 1. Settings Modal

### Current Behavior

In `__root.tsx`, clicking "Settings" toggles `showSettings` state. When true, a `<div>` with `<Settings />` is rendered between the nav bar and page content, pushing everything down.

### New Behavior

Settings renders as a modal overlay: semi-transparent backdrop + centered card. Content behind stays in place. Click backdrop or a close button to dismiss.

Implementation: pure CSS overlay in `__root.tsx` — no new component or shadcn dialog needed. The `<Settings />` component internals don't change.

```tsx
{showSettings && (
  <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 bg-black/60"
       onClick={() => setShowSettings(false)}>
    <div className="max-w-md w-full max-h-[80vh] overflow-y-auto"
         onClick={(e) => e.stopPropagation()}>
      <Settings />
    </div>
  </div>
)}
```

## 2. Speed & Distance Units

### Data Model

Server stores `speedUnit: "mph" | "kmh"` in `settings.json`. Default: `"mph"`. Distance unit derives from speed unit — no separate setting:
- `mph` → distances in miles
- `kmh` → distances in km

### settings.json

```json
{
  "udpPort": 5300,
  "temperatureUnit": "F",
  "speedUnit": "mph",
  "tireTemperatureThresholds": { "cold": 150, "warm": 220, "hot": 280 }
}
```

### Server Changes

#### `server/settings.ts`

Add `speedUnit` to `AppSettings` interface and defaults:
```typescript
export interface AppSettings {
  udpPort: number;
  temperatureUnit: "F" | "C";
  speedUnit: "mph" | "kmh";
  tireTemperatureThresholds: { cold: number; warm: number; hot: number };
}
```

Default: `speedUnit: "mph"`.

`loadSettings()` extracts with fallback: `parsed.speedUnit ?? DEFAULTS.speedUnit`.

#### `server/routes.ts`

PUT handler validates: `merged.speedUnit !== "mph" && merged.speedUnit !== "kmh"` → 400 error.

### Client Changes

#### `client/src/lib/speed.ts` (new file)

```typescript
// Raw Forza data: velocity in m/s, distance in meters
export function convertSpeed(ms: number, unit: "mph" | "kmh"): number {
  return unit === "kmh" ? ms * 3.6 : ms * 2.23694;
}

export function convertDistance(meters: number, unit: "mph" | "kmh"): number {
  return unit === "kmh" ? meters / 1000 : meters / 1609.34;
}

export function speedLabel(unit: "mph" | "kmh"): string {
  return unit === "kmh" ? "km/h" : "mph";
}

export function distanceLabel(unit: "mph" | "kmh"): string {
  return unit === "kmh" ? "km" : "mi";
}
```

#### `client/src/context/telemetry.tsx`

Rename `TempSettings` → `DisplaySettings`. Add `speedUnit`:
```typescript
export interface DisplaySettings {
  temperatureUnit: "F" | "C";
  speedUnit: "mph" | "kmh";
  tireTemperatureThresholds: { cold: number; warm: number; hot: number };
}
```

Update context value, default, and `useTempSettings` (rename to `useDisplaySettings`).

#### `client/src/components/Settings.tsx`

Add a Speed/Distance section with a toggle: **mph / mi** | **km/h / km**. Save sends `speedUnit` to server alongside other settings. No thresholds needed — just a unit toggle.

#### `client/src/components/LiveTelemetry.tsx`

Find all speed and distance displays. Currently speed is calculated as `Math.sqrt(vx² + vy² + vz²) * 2.237` (hardcoded mph conversion). Replace with `convertSpeed(rawMs, settings.speedUnit)`. Distance displays use `/ 1609.34` — replace with `convertDistance()`. Update unit labels.

## 3. Body Attitude Widget in Analyse

### Current State

`LiveTelemetry.tsx` has a `BodyAttitude` component (lines 872-935) that renders three SVG mini-views: rear (roll), side (pitch), and compass (yaw). It takes a `TelemetryPacket` prop. This component is currently defined locally in LiveTelemetry.tsx.

### Change

Extract `BodyAttitude` to a shared component `client/src/components/BodyAttitude.tsx` so both LiveTelemetry and LapAnalyse can use it.

In LapAnalyse, the track map container (line 1070) is a `relative` div at 420px height. Add the `BodyAttitude` widget as an `absolute`-positioned overlay at the bottom-right of the track map, using `currentPacket` (which already exists at line 885 — `telemetry[cursorIdx]`).

```tsx
{/* Bottom-right: body attitude overlay */}
{currentPacket && (
  <div className="absolute bottom-2 right-2 bg-slate-950/80 rounded p-1">
    <BodyAttitude packet={currentPacket} />
  </div>
)}
```

The widget animates automatically as the playback cursor advances through the lap — no extra work needed since `currentPacket` updates with `cursorIdx`.

### Extraction

Move `BodyAttitude` from `LiveTelemetry.tsx` to `client/src/components/BodyAttitude.tsx`. Import it in both files. No logic changes — just a file move.

## Files Modified

| File | Change |
|------|--------|
| `server/settings.ts` | Add `speedUnit` to AppSettings interface, defaults, loadSettings |
| `server/routes.ts` | Validate speedUnit in PUT handler |
| `client/src/routes/__root.tsx` | Replace push-down settings with modal overlay |
| `client/src/lib/speed.ts` | New: `convertSpeed`, `convertDistance`, `speedLabel`, `distanceLabel` |
| `client/src/context/telemetry.tsx` | Rename TempSettings → DisplaySettings, add speedUnit |
| `client/src/components/Settings.tsx` | Add speed unit toggle |
| `client/src/components/LiveTelemetry.tsx` | Use speedUnit for speed/distance display and labels; remove BodyAttitude (now imported) |
| `client/src/components/BodyAttitude.tsx` | New: extracted shared BodyAttitude component (roll/pitch/yaw SVGs) |
| `client/src/components/LapAnalyse.tsx` | Add BodyAttitude overlay at bottom-right of track map |
| `test/speed.test.ts` | New: tests for speed/distance conversion utilities |

## Edge Cases

- **First run / missing speedUnit**: Server defaults to `"mph"`
- **Existing settings.json**: `loadSettings()` falls back to default via `??`
- **Lap export**: `server/routes.ts` generateExport currently hardcodes mph — out of scope for now (server-side, no access to client display prefs)
