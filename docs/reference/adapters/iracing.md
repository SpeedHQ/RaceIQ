# iRacing adapter

RaceIQ reads iRacing directly through the local Windows SDK memory map. It does not install `irsdk-node` or run a companion service.

## Live data flow

1. `apps/backend/src/index.ts` detects `iRacingSim64DX11` and starts `IRacingTelemetrySource`.
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
4. Confirmation decodes the useful driving window directly into telemetry packets and feeds the common import pipeline at the recording's native cadence.
5. RaceIQ retains a byte-identical `.ibt` as `sessions.rawFile`, marks the session source as `ibt`, and stores lap windows as packet indices. It does not create a derived `.bin` capture.

Cancel, commit, and preview expiry remove the staged file. Confirmed previews expire after 30 minutes. A successful import keeps its owned original-format recording; failed imports roll back their sessions and owned recording. Replay and reprocessing decode that retained IBT, including original native channels, rather than converting it into BIN.

Exports of imported IBT telemetry retain the complete original recording, even when initiated from a single lap. ZIP archives contain the original `.ibt` rather than a converted lap capture; re-import uses the same production IBT preview and commit service.

## Analysis boundaries

- The transport is Windows-local.
- Live SDK telemetry provides lap distance and native sector starts, but no stable world-space racing line. The adapter uses `lap-distance` coordinates rather than fabricating world positions.
- The live SDK does not provide per-wheel rotation, slip ratio, slip angle, or tyre-force channels suitable for continuous analysis.
- Tyre temperatures and tyre condition are pit snapshots; cold tyre pressures are static setup values, not live hot pressure.
- RaceIQ reads telemetry and session identity. It does not write garage setup values back to iRacing.

## Implementation map

- `packages/game-iracing/src/sdk-reader.ts` — memory map and SDK descriptor decoding
- `packages/game-iracing/src/source.ts` — supervised polling and source-frame emission
- `packages/capture-formats/src/iracing/source-frame.ts` — v2/v3 replay contract
- `packages/capture-formats/src/iracing/session-info.ts` — targeted SessionInfo extraction
- `packages/game-iracing/src/normalizer.ts` — canonical telemetry mapping
- `packages/game-iracing/src/index.ts` — server adapter
- `packages/game-iracing/src/ibt-reader.ts` — streaming IBT decoder
- `packages/game-iracing/src/ibt-source.ts` — original-format packet and native-channel decoding
- `apps/backend/src/imports/iracing-ibt.ts` — preview, original-file publication, commit, and cleanup
