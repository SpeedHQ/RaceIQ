# Unified TireGrid Component Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace three separate tire health displays (FM23 `TireRaceView`, F1 `TireTempDiagram`, ACC `AccTireSection`) with a single shared `TireGrid` component.

**Architecture:** Create `TireGrid` in `client/src/components/telemetry/TireGrid.tsx`. It owns its section header ("Tires" + optional compound badge), renders a 2×2 grid of tire tiles, and accepts `TireData[]` with temps always in °C. Each caller normalises their packet data and passes game-specific thresholds; the component has no game knowledge. Delete `TireRaceView.tsx` after all callers are migrated.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4

---

### Task 1: Create TireGrid component

**Files:**
- Create: `client/src/components/telemetry/TireGrid.tsx`

- [ ] **Step 1: Create the file**

```tsx
import { useUnits } from "@/hooks/useUnits";

export interface TireData {
  label: string;
  tempC: number;       // always °C — caller normalises
  wear: number;        // 0 (new) → 1 (gone)
  brakeTemp?: number;  // °C, optional
  pressure?: number;   // psi, optional
}

interface TireGridProps {
  tires: TireData[];
  healthThresholds: { green: number; yellow: number }; // fractions 0–1
  tempThresholds: { blue: number; orange: number; red: number }; // °C
  compound?: string;
  compoundStyle?: { bg: string; text: string };
}

export function TireGrid({ tires, healthThresholds, tempThresholds, compound, compoundStyle }: TireGridProps) {
  const units = useUnits();
  const greenPct = healthThresholds.green * 100;
  const yellowPct = healthThresholds.yellow * 100;

  const hasBrake = tires.some((t) => t.brakeTemp !== undefined);
  const hasPressure = tires.some((t) => t.pressure !== undefined);

  const tempColor = (c: number) => {
    if (c > tempThresholds.red)    return "text-red-400";
    if (c > tempThresholds.orange) return "text-orange-400";
    if (c < tempThresholds.blue)   return "text-blue-400";
    return "text-emerald-400";
  };

  const tempBg = (c: number) => {
    if (c > tempThresholds.red)    return "bg-red-500";
    if (c > tempThresholds.orange) return "bg-orange-400";
    if (c < tempThresholds.blue)   return "bg-blue-500";
    return "bg-emerald-500";
  };

  const brakeColor = (t: number) => {
    if (t > 700) return "text-red-400";
    if (t > 450) return "text-orange-400";
    if (t < 175) return "text-blue-400";
    return "text-app-text-secondary";
  };

  return (
    <div>
      <div className="p-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Tires</h2>
        {compound && (
          <span
            className={`text-xs font-bold uppercase px-2 py-0.5 rounded ${
              compoundStyle ? `${compoundStyle.bg} ${compoundStyle.text}` : "bg-slate-700 text-slate-200"
            }`}
          >
            {compound}
          </span>
        )}
      </div>
      <div className="p-3">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          {tires.map((t) => {
            const h = Math.max(0, (1 - t.wear) * 100);
            const hBarColor = h > greenPct ? "bg-emerald-400" : h > yellowPct ? "bg-yellow-400" : "bg-red-500";
            const hTextColor = h > greenPct ? "text-emerald-400" : h > yellowPct ? "text-yellow-400" : "text-red-400";
            const tempDisplay = units.tempUnit === "F"
              ? Math.round(t.tempC * 9 / 5 + 32)
              : Math.round(t.tempC);

            return (
              <div key={t.label} className="flex items-center gap-3">
                <div className={`w-4 h-12 rounded-sm ${tempBg(t.tempC)}`} />
                <div className="flex-1 min-w-0">
                  <div className={`text-xl font-mono font-bold tabular-nums leading-none ${tempColor(t.tempC)}`}>
                    {tempDisplay}{units.tempLabel}
                  </div>
                  {(hasBrake || hasPressure) && (
                    <div className="flex gap-3 mt-1 text-sm font-mono font-bold tabular-nums leading-none">
                      {hasBrake && t.brakeTemp !== undefined && (
                        <span className={brakeColor(t.brakeTemp)}>B:{Math.round(t.brakeTemp)}&deg;C</span>
                      )}
                      {hasPressure && t.pressure !== undefined && (
                        <span className="text-app-text-muted">{t.pressure.toFixed(1)}psi</span>
                      )}
                    </div>
                  )}
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 h-1.5 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${hBarColor}`} style={{ width: `${h}%` }} />
                    </div>
                    <span className={`text-xs font-mono font-bold tabular-nums ${hTextColor}`}>{h.toFixed(0)}%</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run from `client/`:
```bash
npx tsc -b --noEmit
```
Expected: no errors for the new file.

---

### Task 2: Migrate F1LiveDashboard

**Files:**
- Modify: `client/src/components/f1/F1LiveDashboard.tsx`

The private `TireTempDiagram` function is deleted. Its call site is replaced with `TireGrid` inline data prep + render.

- [ ] **Step 1: Add import, remove old function**

At the top of `F1LiveDashboard.tsx`, add:
```tsx
import { TireGrid } from "../telemetry/TireGrid";
```

Delete the entire `TireTempDiagram` function (lines ~173–244 — from `function TireTempDiagram` through its closing `}`).

- [ ] **Step 2: Replace call site**

Find in F1LiveDashboard.tsx:
```tsx
<TireTempDiagram packet={rawPacket!} />
```

Replace with:
```tsx
<TireGrid
  tires={[
    { label: "FL", tempC: Math.round(fToC(rawPacket!.TireTempFL)), wear: rawPacket!.TireWearFL, brakeTemp: rawPacket!.f1?.brakeTempFL ?? 0, pressure: rawPacket!.f1?.tyrePressureFL ?? 0 },
    { label: "FR", tempC: Math.round(fToC(rawPacket!.TireTempFR)), wear: rawPacket!.TireWearFR, brakeTemp: rawPacket!.f1?.brakeTempFR ?? 0, pressure: rawPacket!.f1?.tyrePressureFR ?? 0 },
    { label: "RL", tempC: Math.round(fToC(rawPacket!.TireTempRL)), wear: rawPacket!.TireWearRL, brakeTemp: rawPacket!.f1?.brakeTempRL ?? 0, pressure: rawPacket!.f1?.tyrePressureRL ?? 0 },
    { label: "RR", tempC: Math.round(fToC(rawPacket!.TireTempRR)), wear: rawPacket!.TireWearRR, brakeTemp: rawPacket!.f1?.brakeTempRR ?? 0, pressure: rawPacket!.f1?.tyrePressureRR ?? 0 },
  ]}
  healthThresholds={tryGetGame("f1-2025")?.tireHealthThresholds ?? { green: 0.70, yellow: 0.50 }}
  tempThresholds={{ blue: 80, orange: 105, red: 115 }}
  compound={rawPacket!.f1?.tyreCompound ?? "unknown"}
  compoundStyle={COMPOUND_COLORS[rawPacket!.f1?.tyreCompound ?? "unknown"] ?? COMPOUND_COLORS.unknown}
/>
```

- [ ] **Step 3: Verify build**

```bash
npx tsc -b --noEmit
```
Expected: no errors.

---

### Task 3: Migrate AccLiveDashboard

**Files:**
- Modify: `client/src/components/acc/AccLiveDashboard.tsx`

Delete `AccTireSection`. Replace import/usage of `useUnits` in that section with the normalised tires array passed to `TireGrid`.

- [ ] **Step 1: Add TireGrid import, remove AccTireSection**

Add import:
```tsx
import { TireGrid } from "../telemetry/TireGrid";
```

Remove imports no longer needed after deleting `AccTireSection`:
- `import { useUnits } from "../../hooks/useUnits";`  ← delete this line (only used by AccTireSection)

Delete the entire `AccTireSection` function.

- [ ] **Step 2: Replace call site in AccLiveDashboard**

Find:
```tsx
{/* Tires */}
<div className="border-b border-app-border">
  <AccTireSection packet={packet} />
</div>
```

Replace with:
```tsx
{/* Tires */}
<div className="border-b border-app-border">
  <TireGrid
    tires={[
      { label: "FL", tempC: packet.TireTempFL, wear: packet.TireWearFL, brakeTemp: packet.BrakeTempFrontLeft ?? 0, pressure: packet.TirePressureFrontLeft ?? 0 },
      { label: "FR", tempC: packet.TireTempFR, wear: packet.TireWearFR, brakeTemp: packet.BrakeTempFrontRight ?? 0, pressure: packet.TirePressureFrontRight ?? 0 },
      { label: "RL", tempC: packet.TireTempRL, wear: packet.TireWearRL, brakeTemp: packet.BrakeTempRearLeft ?? 0, pressure: packet.TirePressureRearLeft ?? 0 },
      { label: "RR", tempC: packet.TireTempRR, wear: packet.TireWearRR, brakeTemp: packet.BrakeTempRearRight ?? 0, pressure: packet.TirePressureRearRight ?? 0 },
    ]}
    healthThresholds={tryGetGame("acc")?.tireHealthThresholds ?? { green: 0.85, yellow: 0.70 }}
    tempThresholds={{ blue: 60, orange: 85, red: 100 }}
    compound={packet.acc?.tireCompound}
  />
</div>
```

Note: `tryGetGame` is already imported in `AccLiveDashboard.tsx`.

- [ ] **Step 3: Verify build**

```bash
npx tsc -b --noEmit
```
Expected: no errors.

---

### Task 4: Migrate LiveTelemetry (FM23) and delete TireRaceView

**Files:**
- Modify: `client/src/components/LiveTelemetry.tsx`
- Delete: `client/src/components/telemetry/TireRaceView.tsx`

- [ ] **Step 1: Update imports in LiveTelemetry.tsx**

Remove:
```tsx
import { TireRaceView } from "./telemetry/TireRaceView";
```

Add:
```tsx
import { TireGrid } from "./telemetry/TireGrid";
```

Also add `useUnits` call inside the component if not already present. Check whether `const units = useUnits();` exists in `LiveTelemetry`. If not, add it near the top of the component body (after existing `useState`/`useRef` calls):
```tsx
const units = useUnits();
```

(`useUnits` is already imported at the top of the file.)

- [ ] **Step 2: Replace driver mode tire section**

Find in the driver mode return block:
```tsx
{/* Tire Health */}
<div className="border-b border-app-border">
  <div className="p-2 border-b border-app-border">
    <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Tire Health</h2>
  </div>
  <div className="p-3">
    <TireRaceView packet={packet} />
  </div>
</div>
```

Replace with:
```tsx
{/* Tire Health */}
<div className="border-b border-app-border">
  <TireGrid
    tires={[
      { label: "FL", tempC: units.toTempC(packet.TireTempFL), wear: packet.TireWearFL },
      { label: "FR", tempC: units.toTempC(packet.TireTempFR), wear: packet.TireWearFR },
      { label: "RL", tempC: units.toTempC(packet.TireTempRL), wear: packet.TireWearRL },
      { label: "RR", tempC: units.toTempC(packet.TireTempRR), wear: packet.TireWearRR },
    ]}
    healthThresholds={(gameId ? tryGetGame(gameId) : null)?.tireHealthThresholds ?? { green: 0.70, yellow: 0.40 }}
    tempThresholds={{ blue: 60, orange: 85, red: 100 }}
  />
</div>
```

(`gameId` and `tryGetGame` are already in scope in `LiveTelemetry`.)

- [ ] **Step 3: Delete TireRaceView.tsx**

```bash
rm client/src/components/telemetry/TireRaceView.tsx
```

- [ ] **Step 4: Verify build and tests**

```bash
cd client && npx tsc -b --noEmit
cd .. && bun test
```

Expected: no TypeScript errors, 107 tests pass.

- [ ] **Step 5: Run full pre-commit checks and commit**

```bash
cd client && npx eslint src/components/telemetry/TireGrid.tsx src/components/f1/F1LiveDashboard.tsx src/components/acc/AccLiveDashboard.tsx src/components/LiveTelemetry.tsx 2>&1
```

Expected: 0 errors (warnings OK).

Then from repo root:
```bash
git add client/src/components/telemetry/TireGrid.tsx \
        client/src/components/telemetry/TireRaceView.tsx \
        client/src/components/f1/F1LiveDashboard.tsx \
        client/src/components/acc/AccLiveDashboard.tsx \
        client/src/components/LiveTelemetry.tsx
git commit -m "Unify tire health display into shared TireGrid component (#37)

- Add TireGrid: 2x2 grid with section header, temp color bar, optional brake/pressure, health bar + %
- Replace F1 TireTempDiagram with TireGrid (F1 compound colors, brake, pressure)
- Replace ACC AccTireSection with TireGrid (ACC temp thresholds, brake, pressure)
- Replace FM23 TireRaceView with TireGrid (no brake/pressure, no compound)
- Delete TireRaceView.tsx

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```
