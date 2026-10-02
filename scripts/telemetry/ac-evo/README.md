# AC Evo diagnostics

One-off diagnostics for AC Evo captured frames and Windows shared-memory pages.

## Commands

| Command | Required input | Output |
| --- | --- | --- |
| `bun scripts/telemetry/ac-evo/diag-physics.ts` | Hard-coded AC Evo v2 `.bin` path in script | Header, selected physics fields, zero-offset scan, sanity checks |
| `bun scripts/telemetry/ac-evo/diag-status.ts <bin-path>` | AC Evo `.bin` or `.bin.gz` capture | Parser status transitions, gated frames, stale-session finalization |
| `bun scripts/telemetry/ac-evo/poll-graphics.ts` | AC Evo running with `Local\\acpmf_graphics` | 500 ms live graphics samples for 90 seconds |
| `bun scripts/telemetry/ac-evo/probe-shm.ts` | AC Evo running with shared-memory pages | Non-zero graphics fields and named offsets |
| `bun scripts/telemetry/ac-evo/scan-all-pages.ts` | AC Evo running with physics, graphics, and static pages | Fields changing across ten live samples |

## Boundaries and verification

These tools target current AC Evo v2 layouts and Windows shared memory. `diag-status.ts` decompresses only paths ending in `.gz`; it preserves capture framing and uses production parser/lap-detector code. Live probes require AC Evo process availability and are not CI checks.
