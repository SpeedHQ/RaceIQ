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

## Automatic iRacing IBT capture

- Settings → Connection → **Connect to iRacing** opts into native disk telemetry for the current backend runtime. The Windows backend must run under the same user/session as iRacing; connecting does not launch the simulator or authenticate a cloud account. Capture defaults to disconnected after restart.
- `packages/game-iracing/src/disk-logging.ts` sends the SDK `IRSDK_BROADCASTMSG` telemetry start/stop commands and resolves the current user's Known Documents folder, including redirection, then `iRacing/telemetry`. Only fresh `IsDiskLoggingEnabled` / `IsDiskLoggingActive` observations confirm native state. A queued command is not proof of recording; iRacing writes disk telemetry when the driver is in the car.
- `apps/backend/src/runtime/iracing-capture.ts` serializes connection changes and collection. It copies new/modified in-window `.ibt` files into `DATA_DIR/sessions/iracing/ibt`, without moving, deleting, or altering native originals. Historical files at connection time are not bulk-imported. Archive names retain the native stem and a SHA-256 identity; identical generations are deduplicated and differing generations never overwrite each other.
- Settled metadata alone is insufficient: a native exclusive-read probe must show the writer is closed. Copies remain hidden in archive-local staging until stable source metadata and closed-file checks pass, then publish atomically without replacement. Pending in-window files continue collecting after disconnect; unrelated later recordings are excluded. Shutdown allows a bounded final flush, leaving any still-open originals intact.
- Disconnect stops only logging requested by this runtime while its source ownership remains known; independently enabled logging is left alone. Errors are explicit status reason codes. Saved-file counts describe files newly archived during this runtime.
- Collection does not automatically import recordings or duplicate live laps. Original disk-only channels remain preserved in `.ibt` bytes; GPS replay/racing-line rendering is a separate capability.
- Reference: [iRacing SDK documentation](https://sajax.github.io/irsdkdocs/telemetry/), [enabled](https://sajax.github.io/irsdkdocs/telemetry/isdiskloggingenabled.html) / [active](https://sajax.github.io/irsdkdocs/telemetry/isdiskloggingactive.html) flags, and the documentation-linked [broadcast implementation](https://github.com/kutu/pyirsdk/blob/master/irsdk.py).


## Testing

Use focused parser, codec, and native-source tests for the changed game. For dispatch or registry changes, verify adapter priority and per-game parser-state behavior. Binary changes require round-trip and legacy-capture coverage; native-reader changes require a source-level smoke test on Windows.
