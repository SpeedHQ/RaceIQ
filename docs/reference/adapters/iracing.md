# iRacing adapter

RaceIQ reads iRacing directly through the local Windows SDK memory map. It does not install `irsdk-node` or run a companion service.

## Live data flow

1. `server/index.ts` detects `iRacingSim64DX11` and starts `IRacingTelemetrySource`.
2. `IRacingSdkReader` opens `Local\\IRSDKMemMapFileName` through `kernel32`.
3. The reader parses the SDK header and variable descriptors, then copies the newest stable telemetry row. It checks the tick counter again after the copy and rejects a row changed during the read.
4. The source combines telemetry values with the current SessionInfo snapshot and encodes a versioned RaceIQ source frame.
5. The iRacing adapter parses and normalizes that frame to `TelemetryPacket` before the common pipeline performs recording, lap/sector processing, persistence, analysis, and WebSocket broadcast.

iRacing normally publishes live SDK variables at 60 Hz. RaceIQ checks the shared-memory map independently from the user-configured WebSocket refresh cap and accepts each new SDK tick once using its tick counter. The WebSocket broadcaster separately sends the latest accepted frame at the configured refresh rate. Actual change frequency remains variable-specific.

## Source-frame contract

The canonical raw source frame begins with `IRIQ` magic and a schema version.

- A **session frame** carries session identity, a variable name/type dictionary, and the first complete value set.
- A **value-delta frame** carries indexed values changed since the preceding frame.
- Schema v3 session frames also retain the exact UTF-8 SessionInfo YAML and its update revision. A YAML change emits a new session frame.

Schema v2 recordings contain only normalized SessionInfo identity. YAML omitted from a v2 recording cannot be recovered. Raw v3 YAML remains in source frames; RaceIQ does not attach it to every normalized packet or WebSocket update.

For exhaustive SDK and SessionInfo coverage, use the generated [telemetry catalog](../../../shared/telemetry/catalog/generated/TELEMETRY_CATALOG.md) and [compatibility matrix](../../../shared/telemetry/catalog/generated/telemetry-catalog-matrix.md).

## Recorded IBT import

The Analyse page accepts `.ibt` recordings:

1. Upload streams to a temporary staging file.
2. Preview scans telemetry rows and reports identity, duration, channel coverage, driving rows, and complete-lap candidates without creating a session.
3. A recording without a complete lap is rejected.
4. Confirmation replays the useful driving window through an isolated iRacing parser and the common `Pipeline`.
5. RaceIQ creates normal session/lap rows plus a canonical `.bin` raw capture. The source `.ibt` is not retained as `sessions.rawFile`.

Cancel, commit, and preview expiry remove the staged file. Confirmed previews expire after 30 minutes.

## Analysis boundaries

- The transport is Windows-local.
- Live SDK telemetry provides lap distance and native sector starts, but no stable world-space racing line. The adapter uses `lap-distance` coordinates rather than fabricating world positions.
- The live SDK does not provide per-wheel rotation, slip ratio, slip angle, or tyre-force channels suitable for continuous analysis.
- Tyre temperatures and tyre condition are pit snapshots; cold tyre pressures are static setup values, not live hot pressure.
- RaceIQ reads telemetry and session identity. It does not write garage setup values back to iRacing.

## Implementation map

- `server/games/iracing/sdk-reader.ts` — memory map and SDK descriptor decoding
- `server/games/iracing/source.ts` — supervised polling and source-frame emission
- `server/games/iracing/source-frame.ts` — v2/v3 replay contract
- `server/games/iracing/session-info.ts` — targeted SessionInfo extraction
- `server/games/iracing/normalizer.ts` — canonical telemetry mapping
- `server/games/iracing/index.ts` — server adapter
- `server/games/iracing/ibt-reader.ts` — streaming IBT decoder
- `server/games/iracing/import-ibt.ts` — preview, staging, commit, and cleanup
