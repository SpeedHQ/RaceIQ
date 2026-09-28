# Use lossless sparse storage for canonical session recordings

## Problem

Short sessions produced massive recordings: a six-lap LMU capture yielded 15,397,984,812 bytes (14.34 GiB) as a raw canonical `.bin`. RaceIQ stored every complete source frame even when most bytes repeated, and gzip ran only later, leaving a multi-gigabyte live file. Simply discarding unparsed fields to reduce size would prevent future parsing and replay from recovering the original telemetry.

New recordings need to stay small without losing any source bytes. Existing captures must be converted without changing their laps before drivers can continue in the updated app.

## Decision

Write a full source-frame checkpoint at session start, across segment/context boundaries, and at least every 128 frames. Between checkpoints, store a changed-block delta only when smaller than the full frame; otherwise store the original frame. LMU and ACC/AC Evo use their existing sparse layouts; Forza, F1, and iRacing use the versioned `RQSD` storage codec when adjacent source frames have compatible identities and lengths. iRacing's already delta-coded source frames may have no second-layer saving. Readers reconstruct the exact original source bytes before game parsing, Analyse replay, lap seeks, and export. Gzip remains an optional wrapper around the same decompressed canonical record stream; source-frame schema versions are independent of storage codec versions.

An alternative was recording each telemetry channel at its own lower rate. That would save space, but discards intervening source values and fields before they reach disk; future parsers could never recover them. Sparse storage instead retains every captured source frame at the chosen peak acquisition cadence while reducing repeated bytes. Gzip alone runs too late to keep live `.bin` files small, and sparse encoding does **not** guarantee smaller gzipped output.

Where RaceIQ controls polling, it can choose a high peak capture Hz without committing every derived channel to that rate. When parsing the retained frames into telemetry packets, it can independently select an output rate for each channel and later reparse at different rates without another drive. Per-channel rate selection is a downstream capability, not an already implemented recording policy. Actual source update rates, poll cadence, and missing samples bound available fidelity; sparse encoding cannot create measurements between source updates.

Historical conversion is required when eligible captures exist: the app blocks continuation with a conversion dialog until the driver starts conversion and all captures succeed. Conversion never runs automatically at startup or reconnect; the driver clicks Convert. It streams and verifies every reconstructed record against the original, preserves lap identities and remaps their offsets transactionally. Current conversion replaces every verified eligible capture even when sparse output does not save space; users should not assume conversion shrinks a particular `.bin.gz` file. Readers continue to understand legacy captures during conversion. A capture-format eligibility marker identifies converted sessions; stored payload magic/version controls decoding, not the marker.

## Measured yields

PR [#410](https://github.com/SpeedHQ/RaceIQ/pull/410) reports paired canonical captures from the same fixture frames (no acquisition timestamps). Percentages are savings against **raw canonical** `.bin` and, where available, **raw canonical gzip** `.bin.gz` respectively; results are fixture-specific, not guaranteed live savings.

| Fixture | Raw `.bin` → sparse `.bin` | Raw `.bin.gz` → sparse `.bin.gz` |
| --- | ---: | ---: |
| LMU, 47,400 native frames | 15,397,984,812 → 238,908,647 bytes (**98.45% smaller**) | Not measured against paired raw canonical gzip |
| Forza Motorsport 2023 | 6.73 → 4.84 MiB (**28.2% smaller**) | 3.12 → 3.17 MiB (**1.7% larger**) |
| F1 2025 | 146.97 → 146.97 MiB (**0%**) | 13.16 → 13.16 MiB (**0%**) |
| ACC | 117.33 → 47.85 MiB (**59.2% smaller**) | 19.34 → 18.69 MiB (**3.4% smaller**) |
| AC Evo | 97.85 → 30.79 MiB (**68.5% smaller**) | 12.82 → 12.17 MiB (**5.1% smaller**) |
| iRacing | 5.83 → 5.83 MiB (**0%**) | 2.62 → 2.62 MiB (**0%**) |

LMU's sparse canonical gzip was 50,445,804 bytes; its original **native-dump** gzip was 126,638,057 bytes. That 60.17% reduction compares different containers, so it is **not** a raw-canonical-gzip saving. The LMU gzip step reduced its sparse `.bin` by another 78.88%, also not a raw-versus-sparse gzip comparison. F1's interleaved packet identities and iRacing's existing SDK deltas explain the zero savings on these fixtures. Forza's gzip increase demonstrates that historical conversion can increase on-disk size despite reducing the uncompressed recording.
