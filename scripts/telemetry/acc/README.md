# ACC diagnostics

One-off checks for ACC captured shared-memory frames. Parsed diagnostics use `load-packets.ts` only where frame loading, car/track resolution, and parser overrides match; raw offset probes remain independent.

## Commands

| Command | Required input | Output |
| --- | --- | --- |
| `bun scripts/telemetry/acc/acc-to-csv.ts [bin-path]` | ACC `.bin`; default fixture when omitted | `.csv` beside input plus lap-0 summary |
| `bun scripts/telemetry/acc/check-acc-dump.ts` | Built-in ACC fixture path | Header, frame-size, and raw physics values |
| `bun scripts/telemetry/acc/check-acc-speeds.ts` | Built-in ACC fixture path | Speeds at selected frame indices |
| `bun scripts/telemetry/acc/check-graphics-times.ts` | Built-in ACC fixture path | Graphics lap-time fields at samples |
| `bun scripts/telemetry/acc/check-lap-sequence.ts` | Built-in ACC fixture path | Lap-number transitions |
| `bun scripts/telemetry/acc/check-lap-times.ts` | Built-in ACC fixture path | Maximum current, last, and best lap times |
| `bun scripts/telemetry/acc/find-speed-offset.ts` | Built-in ACC fixture path with frame 5000 | Plausible speed offsets |

## Boundaries and verification

Inputs must use ACC Kunos frame format. `acc-to-csv.ts`, `check-lap-sequence.ts`, and `check-lap-times.ts` parse frames through ACC server code; offset probes intentionally inspect bytes directly. Run command against fixture and compare reported frame counts, offsets, and summaries with expected capture characteristics.
