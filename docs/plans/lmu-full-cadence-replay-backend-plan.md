# Full-cadence replay backend plan

Shared boundary: [contract](lmu-full-cadence-replay-contract.md). Parent owns integration and shared artifacts.

## Scope and tasks

1. Preserve the existing full-resolution resolver, insights, and source capture behavior (FC1–FC2). Reuse the frame-resolution loop while allowing the HTTP representation to consume lightweight resolved samples without allocating canonical envelopes and provenance objects that it discards. Owned supporting files: `shared/telemetry/resolver/contracts.ts`, `packages/telemetry-core/src/telemetry/resolver/frame-view.ts`, and `packages/telemetry-core/src/telemetry/replay/canonicalize.ts`.
2. Serve compact replay for the contracted Accept media type using the shared codec; retain existing JSON API behavior and errors (FC1, FC3). Owned files: `server/telemetry/replay.ts`, `packages/lap-replay/server/index.ts`; codec ownership belongs to UI/codec implementer.
3. Accelerate repeated LMU context decoding only after establishing exact byte-identity and mutation invariants. Fully validate first/changed context and every changing frame key. Keep cache bounded/scoped; no timestamp-only reuse (FC1–FC2). Owned files: native source-frame decoder, partition decoder, LMU parser, shared context codec. Remove duplicate source-identity inspection in `server/session-capture/source-loader.ts` without removing any validation invariant.

## Acceptance and edge handling

Backend acceptance references FC1–FC4 in the contract, not a second definition. Preserve stale/error/missing values, context absence/empty distinctions, ordering, lap boundaries, parser resets, timestamp domains, exact large integer timestamps, and competitor details. Context changes or malformed inputs must fall back to full validation or reject as before; cache hits require byte-identical non-key data, never observation timestamp guesses. Requests with another representation or game retain the current contract. No source rewrite or decimation.

## Verification and completion dependency

Execute shared E1–E4 with parent as owner: real import -> persisted split artifact -> actual replay route -> production decoder -> browser surface. E1 covers FC1/FC3 and data/state transitions; E2 covers invalid input/error boundaries; E3 covers FC2 and insight/source invariants; E4 covers FC3/FC4. Extend existing replay integration/native recording scenarios rather than replacing integration with mocks. Unit checks supplement, never replace, this evidence. Record cold/warm route timings, bytes, browser readiness, and unresolved target failures. UI/codec implementation proceeds in parallel after contract publication; completion depends on passing integrated evidence.
