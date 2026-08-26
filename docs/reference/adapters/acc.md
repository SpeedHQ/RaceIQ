# Assetto Corsa Competizione adapter

RaceIQ reads ACC through local Windows shared memory and the ACC Broadcasting Network Protocol. Shared memory remains the player telemetry source; the registered UDP client supplies competitor facts for live voice triggers. RaceIQ and ACC must run on the same machine.

## Source contract

| Page | Mapping | Reader size | Typical source cadence | Purpose |
|---|---|---:|---:|---|
| Physics | `Local\\acpmf_physics` | 800 bytes | 300 Hz | inputs, motion, suspension, tyres, brakes, damage |
| Graphics | `Local\\acpmf_graphics` | 1,588 bytes | 60 Hz | timing, position, pits, flags, electronics |
| Static | `Local\\acpmf_static` | 688 bytes | session change | car, track, engine, fuel and suspension constants |

The graphics parser accepts the 1,320-byte legacy base layout and reads extended fields only when available. Raw offsets and vendor definitions belong in the [ACC v1.8.12 specification](../external/acc/acc-shared-memory-v1.8.12.pdf); `server/games/acc/structs.ts` is RaceIQ's executable layout.

## Broadcasting Network Protocol

`AccBroadcastClient` registers protocol version 4 with ACC at `127.0.0.1:9000`. Override the endpoint or passwords with `ACC_BROADCAST_HOST`, `ACC_BROADCAST_PORT`, `ACC_BROADCAST_PASSWORD`, and `ACC_BROADCAST_COMMAND_PASSWORD`.

The client parses realtime updates and entry-list messages, joins them by ACC `carIndex`, and attaches the runtime-only competitor snapshot to `packet.acc`. The semantic resolver then exposes competitor identity, class, lap count, pit/location, world position, speed, last-lap time, and validity to the existing live engineer engine.

UDP state is not written into `ACCP` recordings. Missing or incomplete broadcast data disables ACC voice candidates without suppressing shared-memory telemetry.

## Read and parse flow

```text
Windows mappings
  -> BufferedAccMemoryReader

  -> TripletAssembler
  -> StatusCheckProcessor
  -> parseAccBuffers
  -> packTriplet("ACCP")
  -> Pipeline.processPacket
```
In parallel, `AccBroadcastClient` receives ACC UDP datagrams, `AccBroadcastState` joins entry-list identity with realtime car updates, and `ParsingProcessor` copies the latest snapshot into the normalized packet before `Pipeline.processPacket`.

`server/index.ts` checks for the ACC process every two seconds and starts or stops `AccSharedMemoryReader` with the game. `BufferedAccMemoryReader` polls the pages at their native cadences and retries unavailable mappings every ten seconds. `TripletAssembler` snapshots the latest complete triplet on a 10 ms timer.

`StatusCheckProcessor` passes live or paused states. Parsing normalizes the source into `TelemetryPacket`, resolves car and track names to RaceIQ ordinals, and preserves ACC-specific values under `packet.acc`.

## Normalization

Important conversions in `parseAccBuffers()` include:

- speed from km/h to m/s;
- acceleration from g to m/s²;
- throttle and brake fractions to the shared 0–255 input scale;
- steering from `-1..1` to the shared signed input scale;
- ACC gear enum to RaceIQ's neutral/forward-gear convention;
- lap times from milliseconds to seconds;
- suspension travel normalized against static-page maximum travel;
- pit flags combined into `in_pit`, `pit_lane`, or `out`.

RaceIQ also maps local angular velocity, wheel load, camber, tyre middle temperature, slip ratio, slip angle, combined slip, ride height, and other extended fields. Do not copy a field list into this page: use the generated [telemetry catalog](../../../shared/telemetry/catalog/generated/TELEMETRY_CATALOG.md) and [compatibility matrix](../../../shared/telemetry/catalog/generated/telemetry-catalog-matrix.md).

## Recording and replay

Shared-memory pages are not replayable by themselves, so the adapter stores a packed source frame:

```text
["ACCP" magic][car ordinal][track ordinal]
[physics length][physics bytes]
[graphics length][graphics bytes]
[static length][static bytes]
```

The packed bytes enter the common session recorder. Replay and import call the same adapter `tryParse()` path, which unpacks and parses the original pages again. See [Telemetry recording](../../architecture/telemetry-recording.md).

## Boundaries

- Shared memory is Windows-local; ACC Broadcasting Protocol uses a separate localhost UDP registration.
- Graphics and physics pages update independently. A packed triplet is a snapshot of the latest page values, not an atomic simulator transaction.
- ACC reports `completedLaps` late. Lap detection uses the current-lap timer reset instead of treating that counter as the boundary. See [Lap detection](../../architecture/lap-detection.md).
- ACC SDK reserves physics `tyreWear[4]` fields but marks them unused. RaceIQ reports tire wear and degradation unavailable instead of treating zero placeholders as fresh tyres.
- Extended ACC layouts may grow. Keep minimum-size checks and optional reads aligned with `server/games/acc/structs.ts`.

## Implementation map

- `server/games/acc/shared-memory.ts` — reader and processor wiring
- `server/games/kunos/buffered-memory-reader.ts` — Windows mappings and polling
- `server/games/kunos/triplet-assembler.ts` — latest-page assembly
- `server/games/kunos/triplet-pipeline.ts` — status, dump, parse processors
- `server/games/acc/structs.ts` — offsets and layout sizes
- `server/games/acc/parser.ts` — source normalization
- `server/games/kunos/pack-triplet.ts` — packed replay frame
- `server/games/acc/lap-detector.ts` — ACC policy over shared Kunos lap lifecycle
- `server/games/acc/broadcast-protocol.ts` — protocol v4 binary encoding/decoding
- `server/games/acc/broadcast-client.ts` — UDP registration and receive lifecycle
- `server/games/acc/broadcast-state.ts` — entry-list/realtime join and semantic snapshot
