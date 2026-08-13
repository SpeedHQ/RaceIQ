
## Review follow-up
- Restored AC Evo `acc.tireRadius` as unavailable/parser-placeholder; generated catalog no longer advertises false direct zero values. AC Evo brake-pad wear and camber remain direct through `acc.brakePadWear`/`acc.tireCamber`.
- Expanded focused tests with exact core ordering, game allowlist expectations, direct ACC/AC Evo mapping assertions, compilation of every allowlisted ID for every registered game, and fixture-backed resolver smoke checks asserting no error states.
- Reran `bun run telemetry:catalog`, `bun run telemetry:catalog:check`, and focused test: `3 pass, 0 fail, 289 expect() calls`.
