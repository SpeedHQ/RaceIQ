# Games

## Purpose

Own neutral backend adapter contracts, registries, packet dispatch, and mechanics shared by independent game packages. Game implementations live in `packages/game-*/src/`; persisted wire layouts and dump decoders live in `packages/capture-formats/src/`.

Backend application registers adapters. `registry.ts` exposes registered adapters and process detection. `packet-dispatch.ts` selects the adapter for incoming source frames while preserving registration priority.

## Structure

- `packages/game-acc/`, `game-ac-evo/`, `game-f1-2025/`, `game-fm-2023/`, `game-iracing/`, and `game-lmu/` own their backend adapters and game-specific implementations.
- `kunos/` contains shared ACC/AC Evo memory-reading, triplet-processing, recording, and lap-rule infrastructure.
- `packages/game-lmu/src/` reads the built-in `LMU_Data` mapping and decodes LMU telemetry `.duckdb` files into replayable source frames.
- `shared/` contains small mechanics reused by otherwise independent game implementations.
- `types.ts` defines server-only adapter policy and parsing contracts layered on shared game metadata.

## Boundaries and invariants

Game adapters own source interpretation. Preserve adapter IDs, registration order, source magic/version checks, parser state lifetimes, recording formats, and ordinal resolution semantics.

Backend-core and capture-formats never depend on game implementations or application assembly. Each game consumes only foundation packages, not sibling games. ACC and AC Evo own separate direct lap-index projections; shared Kunos infrastructure contains no concrete parser imports.

Runtime owns source lifecycle and process supervision; telemetry owns normalized packet processing. Games may call those entry points but must not absorb their session orchestration. Database-backed identity registration is restricted to explicit live or committed-import boundaries so passive parsing remains side-effect free.

## Testing

Use focused parser, codec, and native-source tests for the changed game. For dispatch or registry changes, verify adapter priority and per-game parser-state behavior. Binary changes require round-trip and legacy-capture coverage; native-reader changes require a source-level smoke test on Windows.
