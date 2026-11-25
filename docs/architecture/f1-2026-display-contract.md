# F1 2026 display contract

This extends the telemetry contract in [the macOS goal](../project-status/macos-desktop.md).
The wire format identifies energy interpretation; the separate regulations flag
identifies whether legacy DRS applies. A 2026-format packet can carry an older car.
For 2026 format, stored, harvested and deployed energy are displayed in kJ;
capacity and percentage are unavailable. Missing readings remain unavailable.
Legacy recordings without a format field retain the 2025 display convention.

## Backend plan

Expose the existing format and regulations semantic values in F1 live and replay
projections. Preserve source values and availability; do not infer regulations
from format. Acceptance: projection tests confirm both IDs reach consumers.

## UI plan

Using the same contract, render 2026 energy in kJ without a percentage bar,
identify mode 3 as Boost, and suppress legacy DRS where 2026 regulations apply
or are unknown. Keep legacy 2025 readings and show missing values as unavailable.
Acceptance: rendered tests cover 2025, 2026, missing values, zero and mixed rules.
