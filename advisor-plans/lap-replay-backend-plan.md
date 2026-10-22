# Lap replay server implementation

Contract: [shared integration contract](lap-replay-contract.md). Reciprocal UI work: [UI plan](lap-replay-ui-plan.md).

## Scope and ownership

Own replay/Insights handlers currently in `apps/backend/src/routes/laps/resource-routes.ts`, feature semantic DTOs under `packages/lap-replay/contracts/replay.ts`, package-owned server implementation and focused endpoint tests. Preserve shared DB/capture/analysis services, middleware and application lifetime ownership. The coordinator owns package manifests, public barrels, app registration and final test discovery.

## Tasks

1. Move `SemanticReplayFrame` and `SemanticLapTelemetry` definitions from the client hook into browser-safe contracts; reuse authoritative LMU wire, insight and coverage types. Preserve the wire format; strengthen the existing unknown findings array to `LapInsight[]` only where the real handler already guarantees it.
2. Extract actual Hono handlers for semantic telemetry, Insights reads and Insights rerun into `server/`, preserving existing source/artifact selection, native replay, frame-index restoration, serialization and errors. Export real routes through `/server`; remove old handlers rather than wrap them (C4/C5).
3. Compose routes in the existing app with inherited auth/CSRF/origin behavior and inferred RPC typing. Move exclusively owned server tests if found; keep shared cross-feature tests centrally owned and migrate their public imports (C4/C5).

## Acceptance and verification

Server acceptance is C4 and server/contracts ownership in C5; C1/C2 depend on the unchanged real backend integration. Reuse all shared E2E scenario definitions. Validate shared-ID/header failures, wrong-game/missing laps, parsing failures and uncommitted live-capture states against existing source fixtures. Follow the shared contract's authoritative distinction between ordinary unavailable capture results and the later publication-race guard. Preserve current handling rather than invent new fallback data, clocks, indices, auth or persistence behavior.

The coordinator runs feature server/unit gates, real API error/recording scenarios, full UI/backend replay/Insights integration, public typing, boundary rejection and production browser build. Record passing results and any unavailable environment explicitly. Server and UI implementations proceed independently after the shared contract; final completion depends on integrated E2E evidence.

## Implementation outcome

The package owns the three real Hono handlers, semantic DTOs and focused route integration suite; application registration preserves the typed route chain and shared middleware. Existing mixed comparison/AI route coverage remains centrally owned.

Executed outcomes are linked from the [shared verification record](lap-replay-contract.md#recorded-verification). Real compiled HTTP coverage includes ordinary errors, rerun persistence and both unavailable-capture states. The unchanged later publication-disappearance race and generic replay-failure catch were not fault-injected; their handling was preserved, not claimed as independently exercised.
