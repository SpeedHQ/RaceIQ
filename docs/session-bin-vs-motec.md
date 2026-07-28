# Session `.bin` vs MoTeC `.ld`

Two storage formats. What each holds, what each costs.

## Summary

|                         | RaceIQ `.bin`                              | MoTeC `.ld` (+ `.ldx`)                       |
|-------------------------|--------------------------------------------|----------------------------------------------|
| Unit                    | whole raw source frame, bytes as received  | per-channel sample array                     |
| Layout                  | row-major — frame after frame              | column-major — channel after channel         |
| Rate                    | one fixed rate for everything              | per-channel (20 / 50 / 60 / 100 / 200 Hz)    |
| Fields                  | everything sim exposed                     | 55 channels exporter chose                   |
| Cost per sample         | full struct per frame                      | 4 bytes (float32)                            |
| Re-parseable            | yes — bit-exact replay through pipeline    | no — parsed values only                      |
| Lap splits              | `laps.raw_byte_offset`, O(1) seek          | `.ldx` beacon markers, microseconds          |
| Measured, 686 s AC Evo  | ~219 MB uncompressed                       | 3.84 MiB                                     |

~54× uncompressed for same stint. Deliberate.

## Why we pay it

`.bin` stores raw source bytes, so **any future change works against every old
recording**. New lap detector, new corner detection, newly decoded field, fixed
parser bug — reprocess and old laps get it. Nothing has to be re-driven.

`.ld` stores parsed values. Whatever the exporter chose to log is all that log
will ever hold. A field not logged in 2024 cannot be recovered in 2026.

So the 54× buys retroactivity. Size is the rent on optionality, not the product.

Decomposition of the 54×:

| Factor                | Ratio | Why                                                          |
|-----------------------|-------|--------------------------------------------------------------|
| Sample rate           | 2.4×  | ours 63.5 Hz uniform; MoTeC delivers 26.6 Hz/channel average  |
| Fields decoded        | 4.4×  | ac-evo parser emits ~244 packet fields vs 55 channels         |
| Bytes per sample      | 5.1×  | 20.6 B/decoded-field vs 4.02 B — raw pages stored whole       |

2.4 × 4.4 × 5.1 = 54, matching the measured ratio. Each factor is measured, not
estimated: MoTeC's 26.6 Hz/channel is 1,003,325 samples ÷ 686.2 s ÷ 55 channels,
and its 4.02 B/sample is 4,031,456 B ÷ 1,003,325 samples.

Only ~10.6× of that is more data. The remaining ~5× is bytes we store and do not
currently read: static page (256 B, changes once per session, written on all
~43,600 frames), unread regions of the 3,944 B graphics page, struct padding.
Those are exactly the bytes that make a future decoder able to reach old sessions
— and the most compressible part of the file.

Note the rate row uses MoTeC's *delivered* average. Its *declared* per-channel
rates average 96.7 Hz — i.e. most `.ld` channels claim a rate they do not
actually carry distinct samples at. See [telemetry-fidelity.md](telemetry-fidelity.md).
We are not faster than MoTeC per channel on the channels it logs fastest; we are
uniform, which is a different property.

## `.bin` layout

`server/udp-recorder.ts`. Append-only, length-prefixed:

```
[0xFFFFFFFF u32][4 u32][totalFrames u32]   // 12-byte meta frame at offset 0
[len u32][len bytes]                        // repeated
```

`META_FRAME_MAGIC = 0xffffffff` separates header from real packet length.
`totalFrames` patched on `stop()`. Append-only: hard kill truncates at most last
in-flight write. Reader detects truncation by reading declared length, checking
that many bytes follow.

UDP games: frame is the datagram (Forza 311 / 324 / 331 bytes at 60 Hz).
Shared-memory games have no datagram, so `server/games/shared/pack-triplet.ts`
synthesises one:

```
[magic u32]["ACEP" / "ACCP"][carOrdinal i32][trackOrdinal i32]
[physLen u32][physics][graphLen u32][graphics][staticLen u32][static]
```

AC Evo: `24 + 800 + 3944 + 256 = 5024` bytes payload, + 4-byte length prefix =
**5028 B/frame at 63.5 Hz ≈ 319 KB/s ≈ 19 MB/min**.

Footprint managed two ways: `laps.raw_byte_offset` snapshots the recorder offset
at lap start so single-lap re-parse is a seek, not a scan; and
`server/session-compressor.ts` gzips `.bin` older than 24 h in place while
nothing records, updating DB path to `.bin.gz`.

## `.ld` layout

`server/motec/ld.ts`, verified byte-for-byte against
`Spa-mercedes_amg_gt3_evo-2-2024.12.15-09.59.54.ld`:

- fixed header, then singly-linked list of 124-byte channel-meta blocks
- each block points at own contiguous little-endian sample array
- AC Evo writes float32 for every channel (`dtypeA` 7 / `dtype` 4). int16/int32
  variants exist in other exports, handled too

Measured: **55 channels, 1,003,325 samples, 4,031,456 B, 686.2 s log, rates
20 / 50 / 60 / 100 / 200 Hz.** ~4.0 B/sample — file is almost nothing but sample
data.

Lap splits live in `.ldx` (`server/motec/ldx.ts`) as `Beacons` marker times in
microseconds.

## Why the size gap

Not compression. Three multipliers:

1. **Column-major, per-channel rates.** MoTeC logs suspension travel at 200 Hz,
   fuel at 20 Hz. We log everything at assembly rate — frame is atomic.
2. **Field selection.** Exporter picked 55 channels. AC Evo graphics page alone
   is 3,944 bytes, we decode a fraction, we store all of it.
3. **Framing overhead.** `.ld` sample arrays are contiguous. We pay 4-byte length
   prefix + 24-byte triplet header every frame.

## Capability split

`.bin` only:

- Replay through live pipeline bit-exactly (`server/reprocess.ts`,
  `server/import-session-bin.ts`). New lap-detector versions, corner detection,
  derived channels apply retroactively to old sessions.
- Decode fields not yet decoded when session was recorded.
- Debug parser bugs against exact bytes sim produced.

`.ld` only:

- 4 MB file, portable, opens in i2.
- Channels at natural rates.
- Carries data from sims we have no reader for.

## See also

- `server/udp-recorder.ts` — writer, framing
- `server/games/shared/pack-triplet.ts` — shared-memory frame synthesis
- `server/import-session-bin.ts` — re-import, re-parse
- `server/session-compressor.ts` — background gzip
- `server/motec/ld.ts`, `server/motec/ldx.ts` — MoTeC readers
