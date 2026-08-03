# shared/experiments

Experiment domain contracts for experiment mode, focus transitions, and persisted change logs.

## Purpose
- Define experiment focus/state enums.
- Define typed change records persisted on versions.
- Provide parsing/normalization for stored applied changes.
- Provide stint-target heuristics shared by UI and runtime.

## Key modules
- `focus.ts`
  - `ExperimentFocus`, `EXPERIMENT_FOCUSES`
  - `versionKindForFocus`, `focusForVersionKind`
  - `headlineMetricForVersionKind`
- `types.ts`
  - `SetupChange`, `DrillChange`, `TestChange`, `ExperimentVersionKind`
- `test-changes.ts`
  - `normalizeTestChange`
  - `parseTestChanges`
  - `summarizeTestChange`
- `stint-target.ts`
  - `suggestLapTarget`, `TARGET_GREEN_MIN`, `DEFAULT_LAP_SEC`

## Browser vs Node boundary
- Pure parsing and enums, browser-safe.
- No Node modules, no filesystem reads.
- `stint-target.ts` is deterministic helper for UI and server call-sites.

## Dependency direction
- Server flow depends heavily on focus and change parsing:
  - `server/db/*`
  - `server/experiments/*`
  - `server/ai/*`
- Client experiment UI imports the same contracts for labels and metrics under `client/src/components/tunes/*`.

## Add/extend safely
- Keep new focus/kind values aligned across `focus.ts`, DB schemas, and UI labels.
- Stored `applied_changes` parsing is deliberately tolerant: `parseTestChanges` returns an empty list for malformed JSON, accepts the legacy singular `path`, and derives summaries when `direction` is absent.
- `suggestLapTarget` expects `(estimatedLapSec, trackLengthM)` inputs; pass canonical values from track/time estimates.
- Avoid barrel exports; import leaf paths explicitly.
