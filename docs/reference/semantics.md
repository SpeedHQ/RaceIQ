# Telemetry semantics

## Native channels remain one-to-one

Every per-game semantic mapping must preserve source meaning, granularity, and provenance one-to-one.

- Map each game-native channel to the narrowest accurate semantic.
- Do not rename a source into a physically different concept. Surface, core, and carcass temperatures are distinct.
- Do not average, merge, or duplicate native channels to manufacture another semantic. Preserve source bands such as iRacing carcass left/middle/right independently.
- Use `unavailable` when a game does not provide a semantic. Never infer or alias a value merely to satisfy a common UI contract.
- Unit conversion may normalize a direct source into the canonical unit, but the mapping must be classified as normalized and retain source provenance.
- Select or combine channels for shared product behavior only in an explicit consumer or documented derivation. Do not encode that projection as a false source mapping.

Example: F1 `tyresSurfaceTemperature` maps to representative surface temperature, while `tyresInnerTemperature` maps to core temperature. Neither maps to an invented carcass average.

See [telemetry reference](telemetry.md) for generated source and availability matrices.

## F1 2025 recording channel policy

Live UDP packets and motion-platform delivery remain unchanged. Recording reduction applies only at the capture encoder, never at the live parser. Replay must preserve every field emitted by `F1StateAccumulator.buildPacket`, including derived fields.

| Packet / native channels | Recording policy | Required consumers / rationale |
| --- | --- | --- |
| `MOTION`: world position, world velocity, G-forces, yaw, pitch, roll | Retain the entire packet, including other cars and direction vectors | Replay, track maps, racing lines, acceleration, speed and body attitude; no whole-family removal |
| `MOTION_EX`: suspension position | Retain | Per-wheel suspension travel |
| `MOTION_EX`: wheel speed, slip ratio, slip angle | Retain | Wheel rotation, combined slip, tire analysis and electronics inference |
| `MOTION_EX`: lateral, longitudinal and vertical wheel forces | Retain | Tire-force analysis and unloaded-wheel detection |
| `MOTION_EX`: angular velocity | Retain | Canonical `AngularVelocityX/Y/Z`; these are not platform-only channels |
| `MOTION_EX`: front wheel angle, center-of-gravity height, aero heights, axle roll angles, chassis yaw/pitch | Retain | Published `f1.motionEx` telemetry and analysis |
| `MOTION_EX`: suspension velocity and acceleration | Omit from new encoded frames | Motion-platform-only within RaceIQ: no published telemetry or replay/analysis consumer |
| `MOTION_EX`: local velocity and angular acceleration | Omit from new encoded frames | Motion-platform-only within RaceIQ: decoded internal state only; world velocity and angular velocity remain available |
| Other packet families and unknown payload extensions | Retain | Outside this reduction's audited scope |

The classification is specific to current RaceIQ consumers, not a claim that the omitted physical quantities can never be useful for analysis. The authoritative projection is [`F1StateAccumulator`](../../packages/game-f1-2025/src/f1-state.ts); native byte offsets are defined by [`f1-packet-decoders.ts`](../../packages/game-f1-2025/src/f1-packet-decoders.ts).

### Capture format and compatibility

New F1 recordings use the recording-only `F1CX` version 1 envelope for supported `MOTION_EX` packets. This is not a UDP packet format. The existing outer capture framing, timestamps, record counts, lap indexes and sparse-checkpoint framing are unchanged.

The envelope is `[ASCII F1CX:4][version:u8=1][native body length:u32LE][original F1 header:29][retained body bytes]`. Native body byte ranges `[16,48)`, `[132,144)` and `[156,168)` are absent: 56 bytes per packet, less 9 bytes of envelope overhead, saves 47 bytes before compression. All other body bytes, including unknown trailing extensions, retain their original order and exact values.

Capture readers expand the envelope back to native layout before handing it to the real game parser. Omitted internal slots are zero-filled for layout compatibility, not published as replacement analysis channels. Sparse deltas operate on the compact storage representation; decoded native frames must never become the previous compact delta base. Byte offsets always refer to encoded records, not reconstructed packet lengths.

Old native-frame recordings and parser checkpoint version 1 remain readable. New parser checkpoints serialize zeroes for omitted internal fields without changing the live accumulator or checkpoint schema. Existing files are not rewritten merely by opening them. Older RaceIQ builds without `F1CX` support cannot replay the new extended-motion payloads correctly; use a current build for new recordings.

Lossless maintenance uses a different policy from new recording: splitting or downsampling an older native capture must retain nonzero platform-only values because conservation checks compare native frames exactly. The shared sparse encoder defaults to this lossless policy; it may compact already-zero slots without changing reconstructed bytes. Only new-session recorder entry points opt into channel omission.

Validation must compare full emitted telemetry from a representative native capture against a newly recorded/replayed capture, then exercise indexed lap endpoints, downsampling, sparse seeks, chunked readers and segment resets. Live source buffers must remain byte-identical. Size comparisons must use the same outer framing and compression settings so savings are attributable to channel omission.

### Representative capture measurement

Measured with `bun packages/game-f1-2025/test/measure-f1-capture-size.ts` on `f1-2025-2026-04-22T11-42-43-029Z.bin.gz`. The baseline uses the previous generic sparse encoder policy; both outputs have identical frame framing, sparse markers, header record counts and gzip settings.

| Representation | Baseline bytes | New recording bytes | Saved bytes | Reduction |
| --- | ---: | ---: | ---: | ---: |
| Uncompressed capture | 154,111,439 | 152,951,855 | 1,159,584 | 0.75% |
| gzip capture | 13,769,016 | 12,507,863 | 1,261,153 | 9.16% |

The capture contains 137,403 source records. Real-parser replay of the original, baseline and compact outputs produces the same 137,254 telemetry packets and four forward lap transitions. All three emitted-telemetry SHA-256 digests match: `bd245b385d3cf772f2c20b213a10a082aaff365c9e7af240caec680bcfed1a10`. This result is capture-specific, not a guaranteed compression ratio.
