# Lap-Level DRS/ERS Capability Detection

## Goal

Analyse should show DRS and ERS data only when the selected lap's semantic telemetry actually exposes those channels. Detection must work per lap and per car, so F1 can expose both, Forza can expose neither, and AC Evo can vary by car.

## Design

Add a pure capability detector that scans all semantic analysis frames in the selected lap. DRS and ERS are independent capabilities:

- DRS is supported when at least one frame contains a valid `aero.drs-active` value.
- ERS is supported when at least one frame contains a valid ERS value (`fuel.ers-store-energy`, `fuel.ers-deployed`, `fuel.ers-harvested`, or `fuel.ers-deploy-mode`).

Pass the resulting capability flags from the Analyse page to the sidebar panel. The panel renders DRS and ERS sections independently. Unsupported sections are omitted entirely. No placeholder row is rendered for an unsupported channel.

Current-frame values continue to supply the displayed values. Capability detection is lap-wide, preventing a sparse frame or cursor position from hiding a supported channel.

## Testing

Add deterministic unit/component coverage using semantic frame fixtures:

- F1-shaped frames expose both DRS and ERS.
- Forza-shaped frames expose neither.
- A lap exposing only DRS renders only DRS.
- A lap exposing only ERS renders only ERS.
- Empty or invalid values expose neither.

Tests must assert observable capability results and rendered section presence/absence.
