# Unified TireGrid Component — Design Spec

## Goal

Replace three separate tire health displays (FM23 `TireRaceView`, F1 `TireTempDiagram`, ACC `AccTireSection`) with a single shared `TireGrid` component.

## Component API

File: `client/src/components/telemetry/TireGrid.tsx`

```tsx
interface TireData {
  label: string;
  tempC: number;       // always °C
  wear: number;        // 0 (new) → 1 (gone)
  brakeTemp?: number;  // °C — row shown only if any tire has this
  pressure?: number;   // psi — row shown only if any tire has this
}

interface TireGridProps {
  tires: TireData[];                                          // always 4: FL, FR, RL, RR
  healthThresholds: { green: number; yellow: number };        // fractions 0–1
  tempThresholds: { blue: number; orange: number; red: number }; // °C cutoffs
  compound?: string;
  compoundStyle?: { bg: string; text: string };              // F1 compound badge colors
}
```

## Per-Tile Layout

```
[ vertical bar ]  temp °C (colored by temp)
  (temp-colored)  B:xxx° xx.xpsi  (only if brake/pressure provided)
                  [──health bar──] xx%
```

- Vertical bar: height = 48px, background colored by temp thresholds
- Temp text: `text-xl font-mono font-bold`
- Brake + pressure: `text-xl font-mono font-bold` in a flex row, omitted entirely if neither provided
- Health bar: `h-1.5 rounded-full`, color: green/yellow/red per healthThresholds
- Health %: `text-xs text-app-text-muted` inline after bar, right-aligned

## Section Header

Rendered inside the component:
- Left: `"Tires"` label (`text-xs font-semibold text-app-text-muted uppercase tracking-wider`)
- Right: compound badge if `compound` provided, styled with `compoundStyle` (F1) or default slate (ACC), omitted for FM23

## Temp Threshold Defaults per Game

| Game | blue (cold) | orange (hot) | red (critical) |
|------|-------------|--------------|----------------|
| f1-2025 | < 80°C | > 105°C | > 115°C |
| acc | < 60°C | > 85°C | > 100°C |
| fm-2023 | < 60°C | > 85°C | > 100°C |

Callers pass these explicitly; the component has no game knowledge.

## Callers

### F1LiveDashboard
- Replaces `TireTempDiagram` (private function, deleted)
- Temps: `fToC(packet.TireTempFL)` etc. (already in component)
- Brake: `f1?.brakeTempFL`, pressure: `f1?.tyrePressureFL`
- Compound: `f1?.tyreCompound`, compoundStyle from `COMPOUND_COLORS`

### AccLiveDashboard
- Replaces `AccTireSection` (private function, deleted)
- Temps: ACC packets are already °C
- Brake: `packet.BrakeTempFrontLeft`, pressure: `packet.TirePressureFrontLeft`
- Compound: `packet.acc?.tireCompound`, no compoundStyle (default slate badge)

### LiveTelemetry (FM23 driver mode)
- Replaces `TireRaceView` in driver mode panel
- Temps: `units.toTempC(packet.TireTempFL)` etc.
- No brake, no pressure, no compound

## Files Changed

- `client/src/components/telemetry/TireGrid.tsx` — **new**
- `client/src/components/telemetry/TireRaceView.tsx` — **deleted**
- `client/src/components/acc/AccLiveDashboard.tsx` — replace AccTireSection
- `client/src/components/f1/F1LiveDashboard.tsx` — replace TireTempDiagram
- `client/src/components/LiveTelemetry.tsx` — replace TireRaceView usage

## Out of Scope

- `TireDiagram` (pit crew mode / analyse view) — not changed
- Per-lap wear rate / laps remaining estimate — removed (pit window handles pit strategy)
