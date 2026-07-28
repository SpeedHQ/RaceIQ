# iRacing native SDK source

RaceIQ reads iRacing directly. It does not use `irsdk-node` or run a separate
Node service.

## Data flow

1. The central process supervisor detects `iRacingSim64DX11`.
2. `IRacingSdkReader` opens `Local\IRSDKMemMapFileName` with the Windows file
   mapping API.
3. RaceIQ parses the official SDK header and 144-byte variable descriptors,
   then copies the newest stable telemetry row. The tick counter is checked
   again after the copy to reject a row that iRacing changed mid-read.
4. `IRacingTelemetrySource` combines the row with the current session-info YAML
   and encodes a versioned RaceIQ raw source frame.
5. That raw frame enters the normal `parsePacket()` dispatch. The iRacing game
   adapter normalizes it to `TelemetryPacket`, then `processPacket()` handles
   lap detection, raw recording, SQLite persistence, analysis, and WebSocket
   output exactly as it does for the other games.

Every source frame repeats the compact car, class, track, engine, and session
identity. This is intentional: a stored lap remains parseable in isolation and
does not depend on an earlier session-info frame.

## Boundaries

- Windows only: the iRacing SDK transport is a local Windows memory map.
- No external SDK wrapper or runtime dependency is installed.
- Live SDK telemetry provides lap distance but not a stable world-space racing
  line, so the adapter uses the `lap-distance` coordinate system. Track-map
  geometry is not inferred from zero-filled world coordinates.
- RaceIQ currently reads telemetry and session identity. It does not write
  garage setup values back to iRacing.

## Main implementation

- `server/games/iracing/sdk-reader.ts` — memory mapping and official descriptor
  decoding
- `server/games/iracing/session-info.ts` — targeted session-info extraction
- `server/games/iracing/source-frame.ts` — replayable raw frame contract
- `server/games/iracing/source.ts` — source-owned 60 Hz polling and parser push
- `server/games/iracing/normalizer.ts` — canonical `TelemetryPacket` mapping
- `server/games/iracing/index.ts` — server game adapter
