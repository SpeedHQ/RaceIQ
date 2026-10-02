# Telemetry diagnostics

One-off scripts for inspecting captured telemetry and validating game-specific frame parsing. Scripts read fixtures or live shared-memory pages and write diagnostic output to stdout; they do not own production capture or import behavior.

## Domains

- `acc/` — ACC binary frame diagnostics and parsed lap checks.
- `ac-evo/` — AC Evo physics, status, and shared-memory diagnostics.
- `recordings/` — cross-game recording inspection, replay, compression, and lap-offset checks.

Reusable gzip magic handling lives in `scripts/lib/compression.ts`. It is used only where input policy is magic-byte based; scripts with extension-based or unconditional decompression retain those policies explicitly.

## Boundaries and verification

These are operator tools, not stable application APIs. Run each command against its required fixture or live game process and inspect stdout/stderr and exit status. Do not import diagnostic entrypoints from production code.
