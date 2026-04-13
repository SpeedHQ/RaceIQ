# Temperature Unit & Threshold Configuration

**Date**: 2026-03-18
**Status**: Draft

## Overview

Allow users to select °F or °C for temperature display and edit tire temperature color thresholds. The server stores thresholds (always in °F, matching raw Forza UDP data) and the unit preference. The client handles all conversion for display and input.

## Architecture

### Data Flow

1. Forza UDP → Server receives tire temps in °F (raw)
2. Server stores `temperatureUnit` and `tireTemperatureThresholds` in `settings.json` (thresholds always in °F)
3. Server sends raw °F telemetry + settings to client (no conversion)
4. Client converts temps and thresholds to user's preferred unit for display
5. When user edits thresholds (shown in preferred unit), client converts back to °F before saving to server

### Server Changes

#### `server/settings.ts` — Extend `AppSettings`

```typescript
export interface AppSettings {
  udpPort: number;
  temperatureUnit: "F" | "C";
  tireTemperatureThresholds: {
    cold: number;  // always stored in °F
    warm: number;  // always stored in °F
    hot: number;   // always stored in °F
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

#### `server/settings.ts` — Update `loadSettings()`

The current `loadSettings()` only extracts `udpPort` from the parsed JSON. It must be updated to also extract and default the new fields:

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

#### `server/routes.ts` — Fix both GET and PUT handlers

**GET handler**: Currently returns hardcoded `{ udpPort: udpListener.port }` instead of stored settings. Must call `loadSettings()` and merge with runtime state:

```typescript
app.get("/api/settings", (c) => {
  const settings = loadSettings();
  return c.json({ ...settings, udpPort: udpListener.port });
});
```

**PUT handler**: Currently destructures only `{ udpPort }` and saves just that, erasing other fields. Must use a load-merge-save pattern:

```typescript
app.put("/api/settings", async (c) => {
  const body = await c.req.json();
  const current = loadSettings();
  const merged = { ...current, ...body };
  // validate thresholds: cold < warm < hot
  const t = merged.tireTemperatureThresholds;
  if (t && (t.cold >= t.warm || t.warm >= t.hot)) {
    return c.json({ error: "Thresholds must be in order: cold < warm < hot" }, 400);
  }
  saveSettings(merged);
  // ... restart UDP listener if port changed, etc.
});
```

No new endpoints needed — the existing routes are sufficient once fixed.

### Client Changes

#### Temperature conversion utility

Add a shared utility in `client/src/lib/temperature.ts` (reusable if other temp values are added later):

```typescript
function fahrenheitToCelsius(f: number): number {
  return (f - 32) * 5 / 9;
}

function celsiusToFahrenheit(c: number): number {
  return (c * 9 / 5) + 32;
}

function convertTemp(f: number, unit: "F" | "C"): number {
  return unit === "C" ? fahrenheitToCelsius(f) : f;
}
```

#### `LiveTelemetry.tsx` — Use settings for display

The four threshold functions (`tempColor`, `tempBg`, `tireStrokeColor`, `tireFillColor`) currently hardcode 150/220/280. These will be updated to:

1. Accept thresholds as parameters (from settings)
2. Compare raw °F temps against raw °F thresholds (no conversion needed for color logic)
3. Display the converted temp value with the correct unit symbol

The temp display at line 407 changes from:
```tsx
{temp.toFixed(0)}°F
```
To:
```tsx
{convertTemp(temp, settings.temperatureUnit).toFixed(0)}°{settings.temperatureUnit}
```

Color functions remain comparing in °F (raw vs raw thresholds), so no conversion needed there.

Note: `tireStrokeColor` and `tireFillColor` are currently identical functions — consolidate into one during this refactor.

#### `Settings.tsx` — New temperature section

Add a new Card (or section within existing card) below the Forza Connection card:

1. **Temperature Unit Toggle** — °F / °C selector (radio buttons or toggle)
2. **Tire Temp Thresholds** — Three number inputs:
   - Cold (below = blue): default 150°F / 65.6°C
   - Warm (below = green, above = amber): default 220°F / 104.4°C
   - Hot (above = red): default 280°F / 137.8°C
3. Values displayed in the currently selected unit
4. On save, client converts thresholds from display unit back to °F before sending to server

The save mechanism follows the existing pattern: `PUT /api/settings` with the full settings object.

5. **Reset to Defaults** button — restores thresholds to 150/220/280°F

### Settings Fetch

The client already fetches settings via `GET /api/settings` in `Settings.tsx`. The response will now include `temperatureUnit` and `tireTemperatureThresholds`. These need to be accessible in `LiveTelemetry.tsx` as well.

**Options** (recommend A):
- **A)** Fetch settings in the telemetry context (`telemetry.tsx`) so both components have access
- **B)** Lift settings into a shared React context
- **C)** Fetch independently in each component

Option A is simplest — the telemetry context already manages WebSocket state and can include a one-time settings fetch.

**Reactivity after save**: When the user changes settings in `Settings.tsx`, the telemetry context must pick up the new values without requiring a page refresh. Approach: the telemetry context exposes a `refetchSettings()` function. `Settings.tsx` calls it after a successful PUT. This keeps the flow simple — no WebSocket push or polling needed.

## Files Modified

| File | Change |
|------|--------|
| `server/settings.ts` | Add `temperatureUnit` and `tireTemperatureThresholds` to `AppSettings` interface and defaults |
| `server/routes.ts` | Fix GET to return full settings; fix PUT to load-merge-save; add threshold validation |
| `client/src/lib/temperature.ts` | New file: `fahrenheitToCelsius`, `celsiusToFahrenheit`, `convertTemp` utilities |
| `client/src/components/LiveTelemetry.tsx` | Use settings for thresholds and unit conversion in display; parameterize threshold functions; consolidate `tireStrokeColor`/`tireFillColor` |
| `client/src/components/Settings.tsx` | Add temperature unit toggle and threshold inputs |
| `client/src/context/telemetry.tsx` | Fetch and expose settings (temperature unit + thresholds); expose `refetchSettings()` for reactivity after save |

## Edge Cases

- **First run / missing fields**: Server defaults to °F and 150/220/280 thresholds
- **Invalid threshold order**: Both client and server validate cold < warm < hot before saving
- **Rounding**: Display rounded integers; store full precision in °F
- **Threshold input in °C**: User types 100°C → client stores as 212°F

## Out of Scope

- Kelvin support
- Per-tire threshold customization
- Temperature unit for other values (engine temp, oil temp if added later)
