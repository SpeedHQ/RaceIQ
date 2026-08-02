---
name: analyse-ui-features
description: LapAnalyse UI features: track overlay cycling, sector colors, sector time fallback, nav settings button
type: project
---

Features added/fixed on branch `feature/data-panel-info-hovers` (2026-04-08):

**Track overlay cycling** (`LapAnalyse.tsx`):
- State: `useLocalStorage("analyse-trackOverlay", "none")` — persisted
- Cycles: `none → inputs → segments → sectors → none`
- Passed as `trackOverlay` prop through `AnalyseTopSection` → `AnalyseTrackMap`
- AnalyseTrackMap receives: `sectors` (when "sectors"), `segments` (when "segments"), `showInputs` (when "inputs")

**Sector colors on track map** (`AnalyseTrackMap.tsx`):
- S1=red `#ef4444`, S2=blue `#3b82f6`, S3=yellow `#eab308`
- Uses `fracToIdx()` (distance-based) for both colored lines AND tick marks — must stay in sync
- Tick marks previously used index-based `Math.round(frac * length)` which misaligned with the distance-based colored lines

**Sector time fallback for Forza** (`server/routes/laps/resource-routes.ts`):
- Forza doesn't broadcast sector times via telemetry → `DEFAULT_SECTORS = { s1End: 0.333, s2End: 0.666 }` from `shared/track-sectors.ts`
- Detection: if `CurrentLap` field doesn't progress by ≥1s across the lap → fall back to `TimestampMS`
- `const useTimestamp = lapProgression < 1`

**Nav settings button** (`client/src/routes/__root.tsx`):
- Moved to left of nav tabs (before Home)
- Shows driver name if set: `{driverName || "Settings"} <Settings2 icon />`
- `driverName` from `useSettings()` → `displaySettings.driverName`
- Required adding `driverName?: string` to `DisplaySettings` interface in `telemetry.ts`

**Setup wizard driver name prepopulation** (`client/src/components/Onboarding.tsx` StepProfile):
- Uses refs to avoid setState-in-effect lint errors
- Saves on unmount via cleanup effect (handles Next click without blur event)

**Why:** User workflow improvements for lap analysis. Sector overlay and fallback were broken/missing for FM2023.
**How to apply:** When modifying analyse page overlays, check `trackOverlay` state and the fracToIdx/sector color pipeline.
