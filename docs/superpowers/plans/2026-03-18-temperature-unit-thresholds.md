# Temperature Unit & Threshold Configuration — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to select °F/°C for temperature display and edit tire temperature color thresholds, with server-side persistence and client-side conversion.

**Architecture:** Server stores unit preference and thresholds (always in °F) in `settings.json`. Client fetches settings, converts temperatures for display, and converts user input back to °F before saving. Existing `GET/PUT /api/settings` endpoints are reused with fixes.

**Tech Stack:** TypeScript, Bun, Hono (server), React 19, TailwindCSS, shadcn/ui (client), bun:test

**Spec:** `docs/superpowers/specs/2026-03-18-temperature-unit-thresholds-design.md`

---

### Task 1: Temperature Conversion Utility

**Files:**
- Create: `client/src/lib/temperature.ts`
- Create: `test/temperature.test.ts`

- [ ] **Step 1: Write failing tests for conversion functions**

```typescript
// test/temperature.test.ts
import { describe, test, expect } from "bun:test";
import { fahrenheitToCelsius, celsiusToFahrenheit, convertTemp } from "../client/src/lib/temperature";

describe("temperature conversion", () => {
  test("fahrenheitToCelsius converts known values", () => {
    expect(fahrenheitToCelsius(32)).toBeCloseTo(0);
    expect(fahrenheitToCelsius(212)).toBeCloseTo(100);
    expect(fahrenheitToCelsius(150)).toBeCloseTo(65.556, 2);
    expect(fahrenheitToCelsius(280)).toBeCloseTo(137.778, 2);
  });

  test("celsiusToFahrenheit converts known values", () => {
    expect(celsiusToFahrenheit(0)).toBeCloseTo(32);
    expect(celsiusToFahrenheit(100)).toBeCloseTo(212);
    expect(celsiusToFahrenheit(65.556)).toBeCloseTo(150, 0);
  });

  test("convertTemp returns fahrenheit when unit is F", () => {
    expect(convertTemp(150, "F")).toBe(150);
    expect(convertTemp(220, "F")).toBe(220);
  });

  test("convertTemp converts to celsius when unit is C", () => {
    expect(convertTemp(150, "C")).toBeCloseTo(65.556, 2);
    expect(convertTemp(220, "C")).toBeCloseTo(104.444, 2);
  });

  test("round-trip conversion preserves value", () => {
    const original = 200;
    const celsius = fahrenheitToCelsius(original);
    const backToF = celsiusToFahrenheit(celsius);
    expect(backToF).toBeCloseTo(original, 5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && bun test test/temperature.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement conversion functions**

```typescript
// client/src/lib/temperature.ts
export function fahrenheitToCelsius(f: number): number {
  return (f - 32) * 5 / 9;
}

export function celsiusToFahrenheit(c: number): number {
  return (c * 9 / 5) + 32;
}

export function convertTemp(f: number, unit: "F" | "C"): number {
  return unit === "C" ? fahrenheitToCelsius(f) : f;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && bun test test/temperature.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/temperature.ts test/temperature.test.ts
git commit -m "feat: add temperature conversion utility (F↔C)"
```

---

### Task 2: Extend Server Settings

**Files:**
- Modify: `server/settings.ts` (lines 6-30)
- Create: `test/settings.test.ts`

- [ ] **Step 1: Write failing tests for extended settings**

```typescript
// test/settings.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

// We need to test loadSettings/saveSettings with the new fields.
// Since settings.ts uses hardcoded paths, we test by importing and exercising.
import { loadSettings, saveSettings, type AppSettings } from "../server/settings";

const SETTINGS_DIR = "./data";
const SETTINGS_PATH = `${SETTINGS_DIR}/settings.json`;

describe("settings with temperature fields", () => {
  let originalContent: string | null = null;

  beforeEach(() => {
    // Back up existing settings
    if (existsSync(SETTINGS_PATH)) {
      originalContent = readFileSync(SETTINGS_PATH, "utf-8");
    }
  });

  afterEach(() => {
    // Restore original settings
    if (originalContent) {
      writeFileSync(SETTINGS_PATH, originalContent);
    }
  });

  test("loadSettings returns defaults when file has only udpPort (migration)", () => {
    // Simulate old-format settings.json with only udpPort
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({ udpPort: 5300 }));
    const settings = loadSettings();
    expect(settings.temperatureUnit).toBe("F");
    expect(settings.tireTemperatureThresholds).toEqual({ cold: 150, warm: 220, hot: 280 });
  });

  test("saveSettings persists temperature fields", () => {
    const settings: AppSettings = {
      udpPort: 5300,
      temperatureUnit: "C",
      tireTemperatureThresholds: { cold: 140, warm: 210, hot: 270 },
    };
    saveSettings(settings);
    const loaded = loadSettings();
    expect(loaded.temperatureUnit).toBe("C");
    expect(loaded.tireTemperatureThresholds).toEqual({ cold: 140, warm: 210, hot: 270 });
  });

  test("loadSettings defaults missing threshold subfields", () => {
    // Write a file with partial thresholds
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true });
    Bun.write(SETTINGS_PATH, JSON.stringify({ udpPort: 5300, tireTemperatureThresholds: { cold: 100 } }));
    const loaded = loadSettings();
    expect(loaded.tireTemperatureThresholds.cold).toBe(100);
    expect(loaded.tireTemperatureThresholds.warm).toBe(220);
    expect(loaded.tireTemperatureThresholds.hot).toBe(280);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && bun test test/settings.test.ts`
Expected: FAIL — `temperatureUnit` not in type / undefined

- [ ] **Step 3: Extend AppSettings interface and defaults**

In `server/settings.ts`, update the interface and defaults:

```typescript
export interface AppSettings {
  udpPort: number;
  temperatureUnit: "F" | "C";
  tireTemperatureThresholds: {
    cold: number;
    warm: number;
    hot: number;
  };
}

const DEFAULTS: AppSettings = {
  udpPort: 5300,
  temperatureUnit: "F",
  tireTemperatureThresholds: {
    cold: 150,
    warm: 220,
    hot: 280,
  },
};
```

- [ ] **Step 4: Update loadSettings() to extract new fields**

In the `try` block of `loadSettings()`, replace the return statement:

```typescript
return {
  udpPort: parsed.udpPort ?? DEFAULTS.udpPort,
  temperatureUnit: parsed.temperatureUnit ?? DEFAULTS.temperatureUnit,
  tireTemperatureThresholds: {
    cold: parsed.tireTemperatureThresholds?.cold ?? DEFAULTS.tireTemperatureThresholds.cold,
    warm: parsed.tireTemperatureThresholds?.warm ?? DEFAULTS.tireTemperatureThresholds.warm,
    hot: parsed.tireTemperatureThresholds?.hot ?? DEFAULTS.tireTemperatureThresholds.hot,
  },
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && bun test test/settings.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 6: Commit**

```bash
git add server/settings.ts test/settings.test.ts
git commit -m "feat: extend AppSettings with temperatureUnit and thresholds"
```

---

### Task 3: Fix Server Routes (GET & PUT)

**Files:**
- Modify: `server/routes.ts` (lines 6, 56-76)

- [ ] **Step 1: Update import in routes.ts**

At line 6, change the import to include `loadSettings`:

```typescript
import { loadSettings, saveSettings } from "./settings";
```

- [ ] **Step 2: Fix GET /api/settings handler**

Replace lines 56-58:

```typescript
app.get("/api/settings", (c) => {
  const settings = loadSettings();
  return c.json({ ...settings, udpPort: udpListener.port });
});
```

- [ ] **Step 3: Fix PUT /api/settings handler**

Replace lines 61-76 with load-merge-save pattern plus threshold validation:

```typescript
app.put("/api/settings", async (c) => {
  const body = await c.req.json();
  const current = loadSettings();

  // Whitelist fields — only allow known settings to be updated
  const merged = {
    udpPort: body.udpPort ?? current.udpPort,
    temperatureUnit: body.temperatureUnit ?? current.temperatureUnit,
    tireTemperatureThresholds: {
      cold: body.tireTemperatureThresholds?.cold ?? current.tireTemperatureThresholds.cold,
      warm: body.tireTemperatureThresholds?.warm ?? current.tireTemperatureThresholds.warm,
      hot: body.tireTemperatureThresholds?.hot ?? current.tireTemperatureThresholds.hot,
    },
  };

  // Validate port
  const port = merged.udpPort;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return c.json({ error: "Port must be between 1024-65535" }, 400);
  }

  // Validate temperature unit
  if (merged.temperatureUnit !== "F" && merged.temperatureUnit !== "C") {
    return c.json({ error: "temperatureUnit must be 'F' or 'C'" }, 400);
  }

  // Validate threshold ordering
  const t = merged.tireTemperatureThresholds;
  if (t.cold >= t.warm || t.warm >= t.hot) {
    return c.json({ error: "Thresholds must be in order: cold < warm < hot" }, 400);
  }

  try {
    // Only restart UDP if port actually changed
    if (port !== udpListener.port) {
      await udpListener.restart(port);
    }
    saveSettings(merged);
    return c.json(merged);
  } catch {
    return c.json({ error: `Failed to bind to port ${port}` }, 500);
  }
});
```

- [ ] **Step 4: Verify server compiles**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && bun build server/index.ts --no-bundle --outdir /tmp/forza-check 2>&1 | head -5`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts
git commit -m "fix: GET/PUT settings now handle full AppSettings with merge and validation"
```

---

### Task 4: Add Settings to Telemetry Context

**Files:**
- Modify: `client/src/context/telemetry.tsx`
- Modify: `client/src/routes/__root.tsx` (line 24)

- [ ] **Step 1: Extend TelemetryContext to include settings**

Replace the entire `client/src/context/telemetry.tsx`:

```typescript
import { createContext, useContext, useState, useCallback } from "react";
import type { TelemetryPacket } from "@shared/types";

export interface TempSettings {
  temperatureUnit: "F" | "C";
  tireTemperatureThresholds: {
    cold: number;
    warm: number;
    hot: number;
  };
}

const DEFAULT_TEMP_SETTINGS: TempSettings = {
  temperatureUnit: "F",
  tireTemperatureThresholds: { cold: 150, warm: 220, hot: 280 },
};

interface TelemetryContextValue {
  connected: boolean;
  packet: TelemetryPacket | null;
  packetsPerSec: number;
  tempSettings: TempSettings;
  refetchSettings: () => Promise<void>;
}

export const TelemetryContext = createContext<TelemetryContextValue>({
  connected: false,
  packet: null,
  packetsPerSec: 0,
  tempSettings: DEFAULT_TEMP_SETTINGS,
  refetchSettings: async () => {},
});

export function useTelemetry() {
  return useContext(TelemetryContext);
}

export function useTempSettings() {
  const [tempSettings, setTempSettings] = useState<TempSettings>(DEFAULT_TEMP_SETTINGS);

  const refetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      const data = await res.json();
      setTempSettings({
        temperatureUnit: data.temperatureUnit ?? "F",
        tireTemperatureThresholds: data.tireTemperatureThresholds ?? DEFAULT_TEMP_SETTINGS.tireTemperatureThresholds,
      });
    } catch {
      // Keep defaults on error
    }
  }, []);

  return { tempSettings, refetchSettings };
}
```

- [ ] **Step 2: Wire up in __root.tsx**

In `client/src/routes/__root.tsx`, add the import and hook call:

After the existing imports, add:
```typescript
import { useTempSettings } from "../context/telemetry";
```

Inside `RootLayout`, after `const ws = useWebSocket();`, add:
```typescript
const { tempSettings, refetchSettings } = useTempSettings();
```

Add a useEffect to fetch settings on mount:
```typescript
import { useState, useEffect } from "react";
```
```typescript
useEffect(() => { refetchSettings(); }, [refetchSettings]);
```

Update the Provider value:
```typescript
<TelemetryContext.Provider value={{ ...ws, tempSettings, refetchSettings }}>
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && bunx tsc --noEmit --project client/tsconfig.json 2>&1 | head -10`
If there's no tsconfig in client, try: `cd /Users/acoop/Documents/GitHub/forza-telemetry && bunx tsc --noEmit 2>&1 | head -10`
Expected: No errors (or only pre-existing ones)

- [ ] **Step 4: Commit**

```bash
git add client/src/context/telemetry.tsx client/src/routes/__root.tsx
git commit -m "feat: expose temperature settings via TelemetryContext"
```

---

### Task 5: Update LiveTelemetry to Use Settings

**Files:**
- Modify: `client/src/components/LiveTelemetry.tsx` (lines 192-246, 264-276, 406-407)

- [ ] **Step 1: Import conversion utility and context**

At the top of `LiveTelemetry.tsx`, add:
```typescript
import { convertTemp } from "../lib/temperature";
import { useTelemetry } from "../context/telemetry";
```

(Check if `useTelemetry` is already imported — if so, skip that import.)

- [ ] **Step 2: Consolidate tireStrokeColor and tireFillColor into one function**

Replace both `tireStrokeColor` (lines 234-238) and `tireFillColor` (lines 241-245) with a single function that accepts thresholds:

```typescript
function tireColor(t: number, thresholds: { cold: number; warm: number; hot: number }): string {
  if (t < thresholds.cold) return "#3b82f6";
  if (t < thresholds.warm) return "#34d399";
  if (t < thresholds.hot) return "#f59e0b";
  return "#ef4444";
}
```

- [ ] **Step 3: Update tempColor and tempBg to accept thresholds**

Replace `tempColor` (lines 193-198):
```typescript
function tempColor(t: number, thresholds: { cold: number; warm: number; hot: number }): string {
  if (t < thresholds.cold) return "text-blue-400";
  if (t < thresholds.warm) return "text-emerald-400";
  if (t < thresholds.hot) return "text-amber-400";
  return "text-red-400";
}
```

Replace `tempBg` (lines 200-205):
```typescript
function tempBg(t: number, thresholds: { cold: number; warm: number; hot: number }): string {
  if (t < thresholds.cold) return "bg-blue-500/20 border-blue-500/40";
  if (t < thresholds.warm) return "bg-emerald-500/20 border-emerald-500/40";
  if (t < thresholds.hot) return "bg-amber-500/20 border-amber-500/40";
  return "bg-red-500/20 border-red-500/40";
}
```

- [ ] **Step 4: Update WheelCard to accept thresholds and unit**

Add `thresholds` and `temperatureUnit` to WheelCard props:
```typescript
function WheelCard({ label, temp, wear, combined, slipAngle, outerSide, spinPct, steerAngle, thresholds, temperatureUnit }: {
  label: string;
  temp: number;
  wear: number;
  combined: number;
  slipAngle: number;
  outerSide: "left" | "right";
  spinPct: number;
  steerAngle: number;
  thresholds: { cold: number; warm: number; hot: number };
  temperatureUnit: "F" | "C";
}) {
```

Update calls inside WheelCard:
- `tireStrokeColor(temp)` → `tireColor(temp, thresholds)`
- `tireFillColor(temp)` → `tireColor(temp, thresholds)` (same function now)
- The temp display line (~407): `{temp.toFixed(0)}°F` → `{convertTemp(temp, temperatureUnit).toFixed(0)}°{temperatureUnit}`

- [ ] **Step 5: Update all WheelCard call sites to pass thresholds and unit**

Find the parent component that renders WheelCard (the tire grid ~lines 470-476). It will need to:
1. Get `tempSettings` from `useTelemetry()`
2. Pass `thresholds={tempSettings.tireTemperatureThresholds}` and `temperatureUnit={tempSettings.temperatureUnit}` to each WheelCard

- [ ] **Step 6: Update any other temp threshold usage sites**

Search for remaining references to `tempColor(`, `tempBg(`, `tireStrokeColor(`, `tireFillColor(` and update them to pass thresholds. These may appear in the tire summary section or history charts.

- [ ] **Step 7: Verify it compiles and renders**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && bunx vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 8: Commit**

```bash
git add client/src/components/LiveTelemetry.tsx
git commit -m "feat: LiveTelemetry uses dynamic temp thresholds and unit conversion"
```

---

### Task 6: Add Temperature Settings UI

**Files:**
- Modify: `client/src/components/Settings.tsx`

- [ ] **Step 1: Import conversion functions and telemetry context**

Add to Settings.tsx imports:
```typescript
import { convertTemp, celsiusToFahrenheit } from "../lib/temperature";
import { useTelemetry } from "../context/telemetry";
```

- [ ] **Step 2: Add state and fetch for temperature settings**

Inside the `Settings` component, after the existing state declarations:

```typescript
const { tempSettings, refetchSettings } = useTelemetry();
const [tempUnit, setTempUnit] = useState<"F" | "C">(tempSettings.temperatureUnit);
const [thresholds, setThresholds] = useState(tempSettings.tireTemperatureThresholds);
const [tempStatus, setTempStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
const [tempError, setTempError] = useState("");
```

Add a `useEffect` to sync when `tempSettings` changes (use JSON.stringify to avoid enumerating every sub-field):
```typescript
const tempSettingsJson = JSON.stringify(tempSettings);
useEffect(() => {
  setTempUnit(tempSettings.temperatureUnit);
  setThresholds(tempSettings.tireTemperatureThresholds);
}, [tempSettingsJson]);
```

- [ ] **Step 3: Add save handler for temperature settings**

```typescript
async function handleTempSave() {
  // Convert display values back to °F if user is in °C mode
  const thresholdsInF = tempUnit === "C"
    ? {
        cold: celsiusToFahrenheit(thresholds.cold),
        warm: celsiusToFahrenheit(thresholds.warm),
        hot: celsiusToFahrenheit(thresholds.hot),
      }
    : thresholds;

  if (thresholdsInF.cold >= thresholdsInF.warm || thresholdsInF.warm >= thresholdsInF.hot) {
    setTempStatus("error");
    setTempError("Thresholds must be in order: cold < warm < hot");
    return;
  }

  setTempStatus("saving");
  setTempError("");
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        temperatureUnit: tempUnit,
        tireTemperatureThresholds: thresholdsInF,
      }),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Failed to save");
    }
    await refetchSettings();
    setTempStatus("saved");
    setTimeout(() => setTempStatus("idle"), 2000);
  } catch (err) {
    setTempStatus("error");
    setTempError(err instanceof Error ? err.message : "Failed to save");
  }
}
```

- [ ] **Step 4: Add reset handler**

```typescript
function handleTempReset() {
  setThresholds({ cold: 150, warm: 220, hot: 280 });
  setTempUnit("F");
}
```

- [ ] **Step 5: Add temperature settings card to the JSX**

After the closing `</Card>` of the Forza Connection card, add a new Card. The card should contain:

1. A unit toggle (two buttons styled as a segmented control):
```tsx
<Card className="bg-slate-900 border-slate-800 mt-4">
  <CardHeader>
    <CardTitle className="text-white">Temperature</CardTitle>
    <CardDescription>
      Set the display unit and tire temperature color thresholds.
    </CardDescription>
  </CardHeader>
  <CardContent>
    <div className="flex items-center gap-2 mb-4">
      <Label className="text-slate-400 mr-2">Unit</Label>
      <Button
        size="sm"
        variant={tempUnit === "F" ? "default" : "outline"}
        onClick={() => {
          if (tempUnit === "C") {
            // Convert displayed thresholds from °C back to °F before switching
            setThresholds({
              cold: celsiusToFahrenheit(thresholds.cold),
              warm: celsiusToFahrenheit(thresholds.warm),
              hot: celsiusToFahrenheit(thresholds.hot),
            });
          }
          setTempUnit("F");
        }}
        className="w-12"
      >
        °F
      </Button>
      <Button
        size="sm"
        variant={tempUnit === "C" ? "default" : "outline"}
        onClick={() => {
          if (tempUnit === "F") {
            // Convert displayed thresholds from °F to °C
            setThresholds({
              cold: convertTemp(thresholds.cold, "C"),
              warm: convertTemp(thresholds.warm, "C"),
              hot: convertTemp(thresholds.hot, "C"),
            });
          }
          setTempUnit("C");
        }}
        className="w-12"
      >
        °C
      </Button>
    </div>

    <div className="space-y-3">
      <div>
        <Label htmlFor="threshold-cold" className="text-blue-400 text-xs">
          Cold (below = blue)
        </Label>
        <Input
          id="threshold-cold"
          type="number"
          value={parseFloat(thresholds.cold.toFixed(1))}
          onChange={(e) => setThresholds({ ...thresholds, cold: parseFloat(e.target.value) || 0 })}
          className="bg-slate-800 border-slate-700 text-white font-mono mt-1 w-24"
        />
      </div>
      <div>
        <Label htmlFor="threshold-warm" className="text-amber-400 text-xs">
          Warm (above = amber)
        </Label>
        <Input
          id="threshold-warm"
          type="number"
          value={parseFloat(thresholds.warm.toFixed(1))}
          onChange={(e) => setThresholds({ ...thresholds, warm: parseFloat(e.target.value) || 0 })}
          className="bg-slate-800 border-slate-700 text-white font-mono mt-1 w-24"
        />
      </div>
      <div>
        <Label htmlFor="threshold-hot" className="text-red-400 text-xs">
          Hot (above = red)
        </Label>
        <Input
          id="threshold-hot"
          type="number"
          value={parseFloat(thresholds.hot.toFixed(1))}
          onChange={(e) => setThresholds({ ...thresholds, hot: parseFloat(e.target.value) || 0 })}
          className="bg-slate-800 border-slate-700 text-white font-mono mt-1 w-24"
        />
      </div>
    </div>

    <div className="flex gap-2 mt-4">
      <Button onClick={handleTempSave} disabled={tempStatus === "saving"}>
        {tempStatus === "saving" ? "Saving..." : tempStatus === "saved" ? "Saved" : "Apply"}
      </Button>
      <Button variant="outline" onClick={handleTempReset}>
        Reset
      </Button>
    </div>

    {tempStatus === "error" && (
      <p className="text-red-400 text-sm mt-2">{tempError}</p>
    )}
  </CardContent>
</Card>
```

- [ ] **Step 6: Verify it compiles**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && bunx vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add client/src/components/Settings.tsx
git commit -m "feat: add temperature unit toggle and threshold inputs to Settings"
```

---

### Task 7: Final Integration Verification

- [ ] **Step 1: Run all tests**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && bun test`
Expected: All tests pass

- [ ] **Step 2: Run full build**

Run: `cd /Users/acoop/Documents/GitHub/forza-telemetry && bunx vite build 2>&1 | tail -5`
Expected: Build succeeds with no errors

- [ ] **Step 3: Manual smoke test checklist**

Start the dev server and verify:
- [ ] Settings page shows Temperature card with °F/°C toggle
- [ ] Default thresholds show 150/220/280 in °F mode
- [ ] Switching to °C converts thresholds to ~66/104/138
- [ ] Saving °C mode persists and reloads correctly
- [ ] Live telemetry shows temps in selected unit
- [ ] Tire colors change at correct thresholds
- [ ] Reset button restores defaults
- [ ] Editing thresholds and saving updates live view without page refresh

- [ ] **Step 4: Commit any fixes**

If any issues found during smoke test, fix and commit.
