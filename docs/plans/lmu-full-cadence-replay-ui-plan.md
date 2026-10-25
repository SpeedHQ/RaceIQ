# Full-cadence replay UI plan

Shared boundary: [contract](lmu-full-cadence-replay-contract.md). Codec/UI work can proceed independently of backend using exact contract-conforming data; production must use the real route.

## Scope and tasks

1. Own `packages/lap-replay/contracts/replay-wire.ts` (new shared codec), relevant barrel exports, and `client/src/hooks/laps.ts`. Implement lossless encoder/builder and validating decoder for the contracted representation (FC1, FC3). Intern identical value metadata and supplemental observations, not sampled frames.
2. Request the compact representation and return the unchanged expanded `SemanticLapTelemetry` model to existing scene/chart consumers. Preserve real error handling and existing noncompact JSON behavior. Do not introduce fake replay fallback, thinning, interpolation, or default values (FC1–FC3).
3. Extend focused codec/route/browser coverage where appropriate. Update only browser intercepts affected by representation negotiation; direct JSON API callers retain their current response (FC3).

## Acceptance and edge handling

UI acceptance references FC1–FC4 and shared E1–E4 in the contract. Missing context stays missing; empty observations stay empty. Preserve complete metadata, competitors, nulls and state transitions, sequence ordering, and timestamp values. Validate wire format, dictionary index bounds, tuple structure, and reconstructed context before playback. Repeated observation entries may share immutable dictionary data; consumers must not mutate them. Unknown/malformed input must fail explicitly through existing error UI, not silently decode partial data.

## Verification and completion dependency

Parent executes shared E1–E4 against the real backend: exact expanded-vs-compact equality and native cadence (E1/FC1), malformed data rejection (E2/FC3), unchanged insights/source data (E3/FC2), real browser fetch/decode/preparation/scene and measured cold/warm time (E4/FC3–FC4). Reuse current replay integration and browser harness. Codec unit cases supplement actual integration. Record outcomes; no completion claim from mocks or unexecuted tests. Final integration is an explicit dependency, not a serial dependency during implementation.
