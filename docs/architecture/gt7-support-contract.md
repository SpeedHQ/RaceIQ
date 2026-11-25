# GT7 support contract

## Scope

Initial GT7 support means live packet capture, normalized live telemetry, and lap/session recording through the existing RaceIQ pipeline. Shared lap analysis remains the consumer of recorded samples.

## Input and transport

- Listen on UDP 33740 by default; override with `GT7_UDP_PORT`.
- In direct mode, send one-byte heartbeats to the console on UDP 33739 every 1.6 seconds.
- In relay mode, do not send heartbeats; an upstream relay owns the PS5 heartbeat.
- Default mode is relay, matching the SimHub Windows relay setup.
- Start with heartbeat format `C`; accept and parse all known packet lengths: 296, 316, 344, and 368 bytes.
- Decrypt Salsa20 with the documented GT7 key and packet-size IV mask, then require decrypted `G7S0` magic before parsing.
- Preserve raw source datagrams in recordings; normalize decoded values into the existing `TelemetryPacket` contract.

## Normalized semantics

- Map directly available speed, inputs, RPM, fuel, position, orientation, temperatures, suspension travel, wheel speed, lap times, lap count, car ID, race state, and car category when packet format `C` is present.
- Resolve car IDs to bundled GT7 display names and identify circuits from completed lap signatures. The seven circuit layouts in the supplied weekly-events image have signatures.
- Map GT7 gear nibbles to RaceIQ gear values; retain unavailable fields as unavailable in the adapter capability model.
- Derive unsigned wheel surface-speed / car-speed slip ratio only above 1 m/s. It is a proxy, not signed SAE slip ratio.
- GT7's packet reports total laps as zero in time trials. Use this for the coarse session type (`time-trial` or `race`); do not infer Race A/B/C, Daily Race, or World Series identity from telemetry.
- Event name, event class restriction, and weekly schedule are not in telemetry. Packet format `C` includes the car's category, which does not identify the event's restrictions. Keep event labels unset until an explicit event catalog or user annotation exists.

## Shared consumption

- Store GT7's coarse `race` / `time-trial` session type through the common session API. The adapter uses the existing server game registry, lap detector, live pipeline, recording codec, WebSocket broadcast, and common session/lap APIs.
- GT7 does not provide a native session UID. Session continuity derives from car, track, lap progression, and timing through the common detector.
- No GT7-specific analysis or live UI is required in this first slice; common components render channels declared by its capability model.

## Acceptance

- Valid supported GT7 packets decode to `gameId: "gt7"` and invalid, malformed, or unsupported datagrams are ignored.
- Decoded GT7 frames enter existing live broadcast and lap/session recording paths.
- The first slice preserves source semantics and labels sessions only with evidence present in the packet.
