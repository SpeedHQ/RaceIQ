# Full-cadence LMU replay contract

Status: implementation decisions resolved from the requested full-cadence behavior and existing replay contracts. No recorded samples or source bytes may be removed.

Plans: [Backend](lmu-full-cadence-replay-backend-plan.md), [UI](lmu-full-cadence-replay-ui-plan.md).

## Existing authorities

- `docs/architecture/lmu-recording.md`: native cadence and source fidelity.
- `packages/lap-replay/contracts/replay.ts`: expanded `SemanticLapTelemetry` consumed by replay UI.
- `shared/telemetry/lmu-context.ts`: exact LMU context, timestamps, validation, and observation semantics.
- `packages/lap-replay/server/index.ts`: endpoint authentication/game checks, errors, insight scan, ordering.

## Integration boundary

`GET /api/laps/:id/semantic-telemetry`, with existing authentication and required `X-Game-Id`. No pagination. Preserve source sequence, order, and every timestamp/value/state/freshness. Existing JSON representation remains available to explicit API clients. The UI requests the compact representation with `Accept: application/vnd.raceiq.semantic-replay+json`; the response uses that media type and `Vary: Accept`. Errors retain existing status/body semantics. The expanded representation remains the consumer model, not a fake fallback.

Compact representation: `format: "raceiq-semantic-replay-v1"`; existing lap-level fields remain unchanged, excluding `envelopes`. `definitions` contains semantic value metadata (`semanticId: string`, optional `unit: string|null`, optional `state: string`, optional `freshness: string`). `supplemental` is a dictionary of complete `LmuObservationWire` objects. `envelopes` preserves every frame's `sequence`, `observedAt`, `receivedAt`, `simulator`; `values` becomes ordered `[definitionIndex: integer, value: JSON value]` pairs. Optional `lmu` preserves all context fields, including competitors; only its `supplemental` becomes ordered dictionary indices. Absent context remains absent, distinct from an empty observation list. All indices must be in bounds. Unknown formats, malformed tuples, invalid context, and invalid indices fail explicitly before playback. The decoder reconstructs `SemanticLapTelemetry` without interpolation, coercion, thinning, or loss of diagnostics.

Example value: definitions `[{"semanticId":"motion.speed","unit":"m/s","state":"ok","freshness":"fresh"}]`, frame values `[[0,42.5]]`. A later stale sample has a distinct definition. Shared observation dictionary references do not imply shared acquisition times: every dictionary entry retains its original timestamp/provenance and exact value.

## Acceptance criteria

- **FC1:** Every recorded replay frame, sequence, timestamp, semantic value, unit, state, freshness, LMU supplemental value/provenance, and competitor survives compact round-trip exactly. 100 Hz recordings remain 100 Hz.
- **FC2:** Full-resolution insight analysis and source recording bytes remain unchanged. No recording rate setting or retention change.
- **FC3:** Real UI fetch/decode/playback uses the compact representation. Existing JSON clients, game mismatch, missing lap, parse errors, and unavailable live members retain their behavior.
- **FC4:** Measure cold and warm application route plus browser fetch/decode/preparation against the same real LMU split lap (local lap 32, 7,753 frames). Target 1–2 seconds ready-to-use without hiding cold work; report exact measurements and any unmet target. Baseline: 539,335,387 response bytes, 6.52 seconds in-process route, observed browser requests 29–42 seconds.

## Edge handling and E2E evidence

- **E1 / FC1–FC3:** Controlled 100 Hz recording through real import/persistence and Hono route, decode using production UI decoder, compare every frame against expanded response. Include boundaries, sub-millisecond precision where present, repeated and changing observations, null/missing/error/stale values, empty context, context absence, competitors, and acquisition/session transitions. Expected: exact equality, not merely matching counts.
- **E2 / FC1, FC3:** Feed malformed indices, format, tuples, and context to production decoder. Expected explicit rejection, never fabricated values. Preserve real endpoint error responses.
- **E3 / FC2:** Compare source file hashes before/after replay; compare insight outputs between representations and prove full-resolution input remains used.
- **E4 / FC3–FC4:** Exercise actual browser surface against real backend and native local recording; time network, JSON decoding, model preparation, and observe first/last sample and playable scene. Use existing replay browser harness/helpers where possible. Run isolated local benchmark, not concurrent agents/builds, for final measurements.

Parent owns contract, backend route integration, shared artifacts, and final E1–E4 execution. UI/codec and backend work can proceed independently after this contract. Parser acceleration may reuse only byte-identical validated context portions; changed bytes must take the full validation path. Any boundary change updates both plans and this contract before dependent edits.

## Recorded verification

- E1/E3: controlled 100 Hz native-format capture imported through real persistence and replay route; decoded compact output equals expanded JSON output, every adjacent frame remains 10 ms apart, frame count matches stored source window, and split artifact SHA-256 remains unchanged.
- E1/E3: exhaustive read-only comparison on real local lap 32 passed for all 7,753 frames, 992,384 semantic values, and 108,542 supplemental observations against the existing expanded JSON semantics, including recorded `ok`, `missing`, and `error` states. Source artifact hash remains unchanged.
- E2: focused codec and native-context regressions cover malformed dictionaries/tuples/indices, stale and invalid values, exact large timestamps, byte changes, duplicate JSON keys, cache resets, and session transitions.
- E4: actual application endpoint requested by Chromium with the negotiated media type returned all 7,753 frames and 7,753 prepared playback samples. Cold fetch/JSON/decode/preparation took 2,236 ms; warm took 1,093 ms. Cold remains 236 ms above the 2-second target; this is not a claim that every cold browser load is under 2 seconds.
- E4: isolated in-process actual-route plus JSON/decode/preparation measured 1,579 ms cold and 843 ms warm. Response shrank from 539,335,387 to 25,079,783 bytes without sample removal.
- E4: real Replay canvas and instruments rendered using the production client/backend; seeking the final native sample reached 87.23 seconds. Initial development-page module loading and renderer startup are separate from the data-path timings above. Managed-browser screenshots timed out, and the direct-protocol fallback returned a blank image; DOM, instrument, canvas, and seek observations succeeded.
- Final focused gates: 116 tests passed across 13 files, including the native 100 Hz round-trip, codec, source-stream, sparse recorder, resolver, and changelog scenarios. One pre-existing source-stream symlink test could not complete because Windows returned `EPERM` at `symlinkSync`; do not interpret this as a passing symlink-escape scenario.
- Replay UI/server, backend, and LMU test-project typechecks passed, as did the replay feature-boundary check. The broader client typecheck also reported an unrelated unused `LapMeta` import in `server/session-capture/import-pipeline.ts:7`; that file was left unchanged.
