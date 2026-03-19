# Settings Modal, Speed/Distance Units, Body Attitude Widget — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert settings to a modal overlay, add speed/distance unit preference, and add yaw/roll/pitch widget to the analyse page.

**Architecture:** Three independent changes: (1) CSS overlay in __root.tsx, (2) speed unit following the temperature pattern (server stores, client converts), (3) extract BodyAttitude component and add to LapAnalyse. All share the DisplaySettings rename.

**Tech Stack:** TypeScript, Bun, Hono, React 19, TailwindCSS, bun:test

**Spec:** `docs/superpowers/specs/2026-03-19-settings-modal-speed-units-design.md`

---

### Task 1: Settings Modal Overlay

**Files:**
- Modify: `client/src/routes/__root.tsx`

- [ ] **Step 1: Replace the push-down settings with a modal overlay**

In `client/src/routes/__root.tsx`, find the current settings rendering (around lines 63-69):

```tsx
{showSettings && (
  <div className="p-4 border-b border-slate-800 bg-slate-950">
    <div className="max-w-md">
      <Settings />
    </div>
  </div>
)}
```

Replace with a fixed-position modal overlay:

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

- [ ] **Step 2: Verify it compiles**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry/client && npx vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add client/src/routes/__root.tsx
git commit -m "feat: render Settings as modal overlay instead of push-down"
```

---

### Task 2: Speed/Distance Conversion Utility

**Files:**
- Create: `client/src/lib/speed.ts`
- Create: `test/speed.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/speed.test.ts
import { describe, test, expect } from "bun:test";
import { convertSpeed, convertDistance, speedLabel, distanceLabel } from "../client/src/lib/speed";

describe("speed conversion", () => {
  test("convertSpeed m/s to mph", () => {
    expect(convertSpeed(1, "mph")).toBeCloseTo(2.23694, 3);
    expect(convertSpeed(10, "mph")).toBeCloseTo(22.3694, 2);
    expect(convertSpeed(0, "mph")).toBe(0);
  });

  test("convertSpeed m/s to km/h", () => {
    expect(convertSpeed(1, "kmh")).toBeCloseTo(3.6, 3);
    expect(convertSpeed(10, "kmh")).toBeCloseTo(36, 2);
  });

  test("convertDistance meters to miles", () => {
    expect(convertDistance(1609.34, "mph")).toBeCloseTo(1, 3);
    expect(convertDistance(0, "mph")).toBe(0);
  });

  test("convertDistance meters to km", () => {
    expect(convertDistance(1000, "kmh")).toBeCloseTo(1, 3);
    expect(convertDistance(5000, "kmh")).toBeCloseTo(5, 3);
  });

  test("speedLabel returns correct label", () => {
    expect(speedLabel("mph")).toBe("mph");
    expect(speedLabel("kmh")).toBe("km/h");
  });

  test("distanceLabel returns correct label", () => {
    expect(distanceLabel("mph")).toBe("mi");
    expect(distanceLabel("kmh")).toBe("km");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && bun test test/speed.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement speed utilities**

```typescript
// client/src/lib/speed.ts
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && bun test test/speed.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/speed.ts test/speed.test.ts
git commit -m "feat: add speed/distance conversion utilities"
```

---

### Task 3: Extend Server Settings with speedUnit

**Files:**
- Modify: `server/settings.ts`
- Modify: `server/routes.ts`

- [ ] **Step 1: Add speedUnit to AppSettings**

In `server/settings.ts`, add `speedUnit` to the interface:

```typescript
export interface AppSettings {
  udpPort: number;
  temperatureUnit: "F" | "C";
  speedUnit: "mph" | "kmh";
  tireTemperatureThresholds: {
    cold: number;
    warm: number;
    hot: number;
  };
}
```

Add to DEFAULTS:
```typescript
speedUnit: "mph",
```

Add to `loadSettings()` return in the try block:
```typescript
speedUnit: parsed.speedUnit ?? DEFAULTS.speedUnit,
```

- [ ] **Step 2: Add speedUnit validation to PUT handler in routes.ts**

In `server/routes.ts`, in the PUT handler's whitelist merge, add:
```typescript
speedUnit: body.speedUnit ?? current.speedUnit,
```

Add validation after the temperatureUnit check:
```typescript
if (merged.speedUnit !== "mph" && merged.speedUnit !== "kmh") {
  return c.json({ error: "speedUnit must be 'mph' or 'kmh'" }, 400);
}
```

- [ ] **Step 3: Run existing settings tests**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && bun test test/settings.test.ts`
Expected: All pass (new field defaults correctly via `??`)

- [ ] **Step 4: Commit**

```bash
git add server/settings.ts server/routes.ts
git commit -m "feat: add speedUnit to AppSettings"
```

---

### Task 4: Rename TempSettings → DisplaySettings, Add speedUnit

**Files:**
- Modify: `client/src/context/telemetry.tsx`
- Modify: `client/src/components/Settings.tsx` (update import)
- Modify: `client/src/components/LiveTelemetry.tsx` (update import)

- [ ] **Step 1: Update telemetry.tsx**

In `client/src/context/telemetry.tsx`:

Rename `TempSettings` to `DisplaySettings` everywhere in the file. Add `speedUnit`:

```typescript
export interface DisplaySettings {
  temperatureUnit: "F" | "C";
  speedUnit: "mph" | "kmh";
  tireTemperatureThresholds: {
    cold: number;
    warm: number;
    hot: number;
  };
}
```

Update `DEFAULT_TEMP_SETTINGS` → `DEFAULT_DISPLAY_SETTINGS`:
```typescript
const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  temperatureUnit: "F",
  speedUnit: "mph",
  tireTemperatureThresholds: { cold: 150, warm: 220, hot: 280 },
};
```

Update context value type to use `displaySettings` instead of `tempSettings`:
```typescript
interface TelemetryContextValue {
  connected: boolean;
  packet: TelemetryPacket | null;
  packetsPerSec: number;
  displaySettings: DisplaySettings;
  refetchSettings: () => Promise<void>;
}
```

Update default context value, `useTempSettings` → `useDisplaySettings`, and the state/fetch logic to include `speedUnit`:

```typescript
export function useDisplaySettings() {
  const [displaySettings, setDisplaySettings] = useState<DisplaySettings>(DEFAULT_DISPLAY_SETTINGS);

  const refetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      const data = await res.json();
      setDisplaySettings({
        temperatureUnit: data.temperatureUnit ?? "F",
        speedUnit: data.speedUnit ?? "mph",
        tireTemperatureThresholds: data.tireTemperatureThresholds ?? DEFAULT_DISPLAY_SETTINGS.tireTemperatureThresholds,
      });
    } catch {}
  }, []);

  return { displaySettings, refetchSettings };
}
```

- [ ] **Step 2: Update __root.tsx**

Change import from `useTempSettings` to `useDisplaySettings`. Update the hook call:
```typescript
const { displaySettings, refetchSettings } = useDisplaySettings();
```

Update the Provider value:
```typescript
<TelemetryContext.Provider value={{ ...ws, displaySettings, refetchSettings }}>
```

- [ ] **Step 3: Update Settings.tsx**

Replace `tempSettings` references with `displaySettings`:
```typescript
const { displaySettings, refetchSettings } = useTelemetry();
const [tempUnit, setTempUnit] = useState<"F" | "C">(displaySettings.temperatureUnit);
const [thresholds, setThresholds] = useState(displaySettings.tireTemperatureThresholds);
```

Update the useEffect:
```typescript
const displaySettingsJson = JSON.stringify(displaySettings);
useEffect(() => {
  const unit = displaySettings.temperatureUnit;
  const raw = displaySettings.tireTemperatureThresholds;
  setTempUnit(unit);
  setThresholds(unit === "C" ? {
    cold: convertTemp(raw.cold, "C"),
    warm: convertTemp(raw.warm, "C"),
    hot: convertTemp(raw.hot, "C"),
  } : raw);
}, [displaySettingsJson]);
```

- [ ] **Step 4: Update LiveTelemetry.tsx**

Find where `tempSettings` is used (from `useTelemetry()`) and rename to `displaySettings`. The destructuring should change from:
```typescript
const { tempSettings } = useTelemetry();
```
to:
```typescript
const { displaySettings } = useTelemetry();
```

Update all `tempSettings.temperatureUnit` → `displaySettings.temperatureUnit` and `tempSettings.tireTemperatureThresholds` → `displaySettings.tireTemperatureThresholds`.

- [ ] **Step 5: Verify it compiles**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry/client && npx vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add client/src/context/telemetry.tsx client/src/routes/__root.tsx client/src/components/Settings.tsx client/src/components/LiveTelemetry.tsx
git commit -m "refactor: rename TempSettings to DisplaySettings, add speedUnit"
```

---

### Task 5: Add Speed Unit Toggle to Settings UI

**Files:**
- Modify: `client/src/components/Settings.tsx`

- [ ] **Step 1: Add speed unit state**

After the existing temperature state declarations, add:
```typescript
const [speedUnit, setSpeedUnit] = useState<"mph" | "kmh">(displaySettings.speedUnit);
```

Update the useEffect to also sync speedUnit:
```typescript
setSpeedUnit(displaySettings.speedUnit);
```
(Add this line inside the existing displaySettingsJson useEffect.)

- [ ] **Step 2: Update handleTempSave to also send speedUnit**

In the `handleTempSave` function, update the JSON body to include speedUnit:
```typescript
body: JSON.stringify({
  temperatureUnit: tempUnit,
  speedUnit: speedUnit,
  tireTemperatureThresholds: thresholdsInF,
}),
```

- [ ] **Step 3: Add speed unit card to the JSX**

After the Temperature Card's closing `</Card>`, add:

```tsx
<Card className="bg-slate-900 border-slate-800 mt-4">
  <CardHeader>
    <CardTitle className="text-white">Speed & Distance</CardTitle>
    <CardDescription>
      Set the display units for speed and distance.
    </CardDescription>
  </CardHeader>
  <CardContent>
    <div className="flex items-center gap-2">
      <Label className="text-slate-400 mr-2">Unit</Label>
      <Button
        size="sm"
        variant={speedUnit === "mph" ? "default" : "outline"}
        onClick={() => setSpeedUnit("mph")}
      >
        mph / mi
      </Button>
      <Button
        size="sm"
        variant={speedUnit === "kmh" ? "default" : "outline"}
        onClick={() => setSpeedUnit("kmh")}
      >
        km/h / km
      </Button>
    </div>
    <p className="text-xs text-slate-500 mt-2">
      Changes are saved with the Apply button above.
    </p>
  </CardContent>
</Card>
```

- [ ] **Step 4: Update handleTempReset to also reset speed unit**

```typescript
function handleTempReset() {
  setThresholds({ cold: 150, warm: 220, hot: 280 });
  setTempUnit("F");
  setSpeedUnit("mph");
}
```

- [ ] **Step 5: Verify it compiles**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry/client && npx vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add client/src/components/Settings.tsx
git commit -m "feat: add speed/distance unit toggle to Settings"
```

---

### Task 6: Use Speed Units in LiveTelemetry

**Files:**
- Modify: `client/src/components/LiveTelemetry.tsx`

- [ ] **Step 1: Add import for speed utilities**

```typescript
import { convertSpeed, convertDistance, speedLabel, distanceLabel } from "../lib/speed";
```

- [ ] **Step 2: Find and replace hardcoded speed conversions**

Search for `* 2.237` or `* 2.23694` or similar mph conversion factors in LiveTelemetry.tsx. These are places where raw m/s velocity is converted to mph.

Replace the pattern. For example, if you find:
```typescript
const speed = Math.sqrt(vx*vx + vy*vy + vz*vz) * 2.237;
```
Change to:
```typescript
const rawMs = Math.sqrt(vx*vx + vy*vy + vz*vz);
const speed = convertSpeed(rawMs, displaySettings.speedUnit);
```

Also update the unit label from hardcoded `"mph"` to `speedLabel(displaySettings.speedUnit)`.

- [ ] **Step 3: Find and replace hardcoded distance conversions**

Search for `/ 1609.34` or `1609` in the file. Replace with `convertDistance(meters, displaySettings.speedUnit)` and update labels from `"mi"` to `distanceLabel(displaySettings.speedUnit)`.

- [ ] **Step 4: Verify it compiles**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry/client && npx vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add client/src/components/LiveTelemetry.tsx
git commit -m "feat: use speed/distance unit settings in LiveTelemetry"
```

---

### Task 7: Extract BodyAttitude Component

**Files:**
- Create: `client/src/components/BodyAttitude.tsx`
- Modify: `client/src/components/LiveTelemetry.tsx`

- [ ] **Step 1: Create BodyAttitude.tsx**

Extract the `BodyAttitude` function from `client/src/components/LiveTelemetry.tsx` (lines 872-935) into a new file:

```typescript
// client/src/components/BodyAttitude.tsx
import type { TelemetryPacket } from "@shared/types";

const toDeg = 180 / Math.PI;

/**
 * BodyAttitude — Three SVG mini-views showing car orientation:
 * 1. Rear view: car body rotates with roll angle (weight transfer in corners)
 * 2. Side view: car body rotates with pitch angle (braking/acceleration dive)
 * 3. Compass: arrow rotates with yaw heading
 */
export function BodyAttitude({ packet }: { packet: TelemetryPacket }) {
  const roll = packet.Roll * toDeg;
  const pitch = packet.Pitch * toDeg;
  const yaw = packet.Yaw * toDeg;
  const clampRoll = Math.max(-25, Math.min(25, roll));
  const clampPitch = Math.max(-15, Math.min(15, pitch));

  return (
    <div className="flex items-center gap-3">
      {/* Rear view — shows roll */}
      <div className="flex flex-col items-center">
        <svg viewBox="0 0 70 50" width={70} height={50}>
          <line x1={5} y1={25} x2={65} y2={25} stroke="rgba(100,116,139,0.15)" strokeWidth={0.5} />
          <g transform={`rotate(${clampRoll}, 35, 30)`}>
            <rect x={15} y={22} width={40} height={14} rx={3} fill="none" stroke="rgba(34,211,238,0.5)" strokeWidth={1.5} />
            <path d="M22 22 L25 14 L45 14 L48 22" fill="none" stroke="rgba(34,211,238,0.5)" strokeWidth={1.5} />
            <rect x={11} y={32} width={8} height={5} rx={1.5} fill="rgba(34,211,238,0.3)" stroke="rgba(34,211,238,0.5)" strokeWidth={1} />
            <rect x={51} y={32} width={8} height={5} rx={1.5} fill="rgba(34,211,238,0.3)" stroke="rgba(34,211,238,0.5)" strokeWidth={1} />
          </g>
          <text x={35} y={48} textAnchor="middle" fill="#64748b" fontSize={7} fontFamily="monospace">Roll {roll.toFixed(1)}°</text>
        </svg>
      </div>

      {/* Side view — shows pitch */}
      <div className="flex flex-col items-center">
        <svg viewBox="0 0 70 50" width={70} height={50}>
          <line x1={5} y1={25} x2={65} y2={25} stroke="rgba(100,116,139,0.15)" strokeWidth={0.5} />
          <g transform={`rotate(${-clampPitch}, 35, 28)`}>
            <rect x={10} y={20} width={50} height={12} rx={3} fill="none" stroke="rgba(251,191,36,0.5)" strokeWidth={1.5} />
            <path d="M42 20 L48 12 L55 12 L55 20" fill="none" stroke="rgba(251,191,36,0.5)" strokeWidth={1.5} />
            <circle cx={20} cy={34} r={4} fill="rgba(251,191,36,0.3)" stroke="rgba(251,191,36,0.5)" strokeWidth={1} />
            <circle cx={50} cy={34} r={4} fill="rgba(251,191,36,0.3)" stroke="rgba(251,191,36,0.5)" strokeWidth={1} />
          </g>
          <text x={35} y={48} textAnchor="middle" fill="#64748b" fontSize={7} fontFamily="monospace">Pitch {pitch.toFixed(1)}°</text>
        </svg>
      </div>

      {/* Yaw compass */}
      <div className="flex flex-col items-center">
        <svg viewBox="0 0 40 50" width={40} height={50}>
          <circle cx={20} cy={22} r={14} fill="none" stroke="rgba(100,116,139,0.2)" strokeWidth={0.8} />
          <g transform={`rotate(${yaw}, 20, 22)`}>
            <line x1={20} y1={22} x2={20} y2={10} stroke="rgba(52,211,153,0.7)" strokeWidth={1.5} />
            <polygon points="20,8 17,13 23,13" fill="rgba(52,211,153,0.7)" />
          </g>
          <text x={20} y={48} textAnchor="middle" fill="#64748b" fontSize={7} fontFamily="monospace">Yaw {yaw.toFixed(0)}°</text>
        </svg>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update LiveTelemetry.tsx to import instead of define**

Remove the `BodyAttitude` function definition (lines ~865-935) from LiveTelemetry.tsx. Add import at top:
```typescript
import { BodyAttitude } from "./BodyAttitude";
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry/client && npx vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add client/src/components/BodyAttitude.tsx client/src/components/LiveTelemetry.tsx
git commit -m "refactor: extract BodyAttitude to shared component"
```

---

### Task 8: Add BodyAttitude to Analyse Track Map

**Files:**
- Modify: `client/src/components/LapAnalyse.tsx`

- [ ] **Step 1: Add import**

```typescript
import { BodyAttitude } from "./BodyAttitude";
```

- [ ] **Step 2: Add overlay to track map container**

In `LapAnalyse.tsx`, find the track map container div (around line 1070):
```tsx
<div className="border-r border-slate-800 bg-slate-950 p-2 relative" style={{ height: 420 }}>
```

After the `AnalyseTrackMap` component and the map controls overlay, but before the closing `</div>` of the track map container, add:

```tsx
{/* Bottom-right: body attitude overlay */}
{currentPacket && (
  <div className="absolute bottom-2 right-2 bg-slate-950/80 rounded p-1">
    <BodyAttitude packet={currentPacket} />
  </div>
)}
```

Note: `currentPacket` is already defined at line 885 as `telemetry[cursorIdx] ?? null`.

- [ ] **Step 3: Verify it compiles**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry/client && npx vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add client/src/components/LapAnalyse.tsx
git commit -m "feat: add body attitude (yaw/roll/pitch) to analyse track map"
```

---

### Task 9: Final Integration Verification

- [ ] **Step 1: Run all tests**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && bun test`
Expected: All tests pass (temperature + speed + settings + parser)

- [ ] **Step 2: Run full build**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry/client && npx vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Manual smoke test checklist**

- [ ] Settings opens as a modal overlay, not push-down
- [ ] Clicking backdrop closes the modal
- [ ] Speed/Distance toggle appears in Settings
- [ ] Switching to km/h updates live speed display
- [ ] Distance shows in km when km/h is selected
- [ ] Body attitude widget appears bottom-right of analyse track map
- [ ] Widget animates with playback cursor
