# Games

## Purpose

Own server-side integration for each supported racing game: source-format detection, parsing, native telemetry readers, recording codecs, identity extraction, and game-specific runtime policy.

`init.ts` registers adapters. `registry.ts` exposes registered adapters and process detection. `packet-dispatch.ts` selects the adapter for incoming source frames while preserving registration priority.

## Structure

- `acc/`, `ac-evo/`, `f1-2025/`, `fm-2023/`, and `iracing/` contain each game's adapter and format-specific implementation.
- `kunos/` contains shared ACC/AC Evo memory-reading, triplet-processing, recording, and lap-rule infrastructure.
- `shared/` contains small mechanics reused by otherwise independent game implementations.
- `types.ts` defines server-only adapter policy and parsing contracts layered on shared game metadata.

## Boundaries and invariants

Game adapters own source interpretation. Preserve adapter IDs, registration order, source magic/version checks, parser state lifetimes, recording formats, and ordinal resolution semantics.

Runtime owns source lifecycle and process supervision; telemetry owns normalized packet processing. Games may call those entry points but must not absorb their session orchestration. Database-backed identity registration is restricted to explicit live or committed-import boundaries so passive parsing remains side-effect free.

## Testing

Use focused parser, codec, extraction, and native-source tests for the changed game. For dispatch or registry changes, verify adapter priority and per-game parser-state behavior. Binary changes require round-trip and legacy-capture coverage; native-reader changes require a source-level smoke test on Windows.
