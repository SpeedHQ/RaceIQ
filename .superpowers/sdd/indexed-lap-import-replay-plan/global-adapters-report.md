# Global lightweight adapters report

Implemented direct detector projection for FM and iRacing canonical adapters.

- FM `tryParseLapIndex` reads detector fields directly from canonical offsets; no `tryParse` call or full packet allocation.
- FM `primeParserState` is state-only no-op (stateless adapter).
- iRacing projection decodes/hydrates source-delta frame, updates lap/session parser state, and returns detector fields without invoking `normalizeIRacingFrame`.
- iRacing `primeParserState` only advances source decoder state.

ACC and AC Evo remain blocked pending extraction of their shared-memory field reads into reusable lightweight parser primitives; current hooks still require replacement before acceptance. No focused parity tests were added because those hooks are incomplete.
