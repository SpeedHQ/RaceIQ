# Telemetry Recording Architecture

RaceIQ retains canonical raw source frames beside normalized lap metadata. Raw retention allows future parser, lap-detector, and derived-channel changes to reprocess existing sessions without another drive.

## Data flow

```mermaid
graph LR
  Source[Game source] --> Adapter[Game parser or accumulator]
  Adapter --> Packet[TelemetryPacket]
  Source --> Raw[Canonical raw frame]
  Packet --> Pipeline[Pipeline.processPacket]
  Raw --> Pipeline
  Pipeline --> Recorder[SessionRecorder]
  Pipeline --> Detector[Lap detector]
  Recorder --> Bin[Session .bin or .bin.gz]
  Detector --> DB[(sessions and laps)]
  Bin --> Replay[Import or reprocess]
  Bin --> Split[Package-owned split and verification]
  Split --> Archive[Indexed gzip members and JSON manifest]
  Archive --> LapReplay[Selected-lap replay and export]
  Replay --> Adapter
```

UDP adapters preserve original source datagrams. ACC and AC Evo pack three shared-memory pages with adapter magic and resolved ordinals. iRacing preserves versioned session/value-delta source frames. Production uses `SparseSessionRecorderAdapter` for all six games.

## Incremental live lap capture (release-gated)

The bounded live source recorder owns file creation, writes, header patching, flush, and sync in a worker. Enabling `configureLiveCaptureRuntime()` additionally binds the production per-lap derivation worker and restart replay. That binding is deliberately absent from production boot until the [live release gates](../plans/live-lossless-lap-splitting.md#phase-4--performance-and-end-to-end-release-gates) pass. Existing imports and reprocessing keep the explicit offline recorder; they do not use live admission limits as an unlimited-speed import transport.

Detector ownership transitions, not parser checkpoint predictions, define lap windows. Each candidate retains exact pre-frame initialization; a canonical epoch starts with its parser anchor and preceding context, excluding the current gameplay frame. An unpersisted window is explicitly abandoned and conserved as auxiliary data. Reaching another candidate does not authorize discarding an unresolved lap: derivation waits for journaled finalization or abandonment, independently of delayed database identity binding.

Ingress reserves bounded transport/control capacity without awaiting source filesystem operations, worker completion, durability, verification, or publication. The live adapter allows 16 MiB in flight and batches at most 4 MiB. Derivation caches at most 8 MiB or 1,024 source records and journals ordered work on disk; a cache miss catches up from the pinned canonical source during recording. Control admission is distinct from control execution. Exhaustion and worker/I/O failures are explicit recording failures, never permission to silently drop accepted records.

The derivation worker may combine up to 64 additional adjacent, monotonic watermark controls already written to the work journal. It never crosses candidate, ownership, binding, or close controls. Every combined sequence is acknowledged only after the latest watermark executes; the first nonmatching control remains available to ordered replay and late-ownership lookahead. This amortizes canonical seek/read work without changing authoritative windows or retaining a growing control history.

The source worker uses bounded vectored writes without copying native payloads. Each durability fence syncs source data; the parent directory tree is synced once after source creation, because later appends and the final header patch do not create directory entries.

Capture, restart recovery, and release benchmarks share the same Bun worker constructor and small-heap GC policy. This changes heap-growth behavior, not the explicit transport, control, source-cache, or checkpoint ceilings. Release measurements still enforce CPU, readiness, and additional RSS budgets.

Publication order is canonical durability, authoritative journal/binding durability, native conservation and independent semantic replay verification, archive durability, then an atomic fenced database member commit. Only that commit authorizes `lap-capture-ready`. Source native/header counts, all logical source records, and transport sequences are separate counters.

Unpublished gzip stages and position spools are regenerable scratch, not recovery authority. Closing a stage finishes its bytes for native and parser verification without a separate scratch-file durability fence. Every committed archive append is still synced before the database publication fence; restart derives any unfinished work from the retained durable source and journal.

The live worker pre-opens one spare gzip staging file and one source-position journal while the current member is recording. A confirmed boundary consumes those prepared resources and replenishes the spare asynchronously. The next member can accept records while the previous member closes, verifies, replays, and publishes; archive commits remain ordered. At most one finalization is outstanding alongside the active member. If another boundary arrives before that finalization completes, derived processing waits at the bounded capacity fence rather than growing an unlimited finalization queue. This does not promise zero handover latency when preparation or finalization falls behind.

Graceful close waits for active and outstanding finalization work before reporting a sealed capture. Failure stops further publication, reports the error without requiring another source frame, and discards unpublished stages, position journals, and unused prepared files. Prepared files are scratch only: they do not change detector ownership, readiness, canonical recording, or the indexed archive format.

Live capture layout 3 uses archive schema v5 and immutable committed snapshots. A reader validates member ranges, integrity, generation, and the committed archive length, then reads only the selected prefix/member. Later appends do not invalidate an older snapshot. This is not an exception to manifest v4's strict physical EOF check; legacy directory bundles and v4 archives retain their existing contracts.

Normal live close drains outstanding tail work and seals metadata; it does not schedule a second whole-session split or revisit completed members. Canonical source remains retained. Retaining both source and archive is not a storage-saving claim.

Restart recovery checks source device/inode and durable length, rotates the attempt fence, and streams journal controls by effective owned start with sequence ties. Its indexed keyset cursor retains bounded active candidate/window state, not full-history arrays. Delayed observations can reference any already committed lap, not just the last member. A persisted unpublished lap without durable authoritative ownership fails visibly rather than being absorbed into auxiliary data. Recovery preserves canonical suffix bytes and truncates only an uncommitted archive suffix.

An authoritative window may select a prepared running-start trim without a separate promotion event. Recovery restores that selection, conserves its tentative prefix as auxiliary data, releases discarded candidate reservations, and can resume when the prefix was committed before the crash.

Recording lifecycle notifications use opaque string capture epochs. Reconnect restores current recording, finalizing, sealed, or failed state; stale epoch events and terminal rollback cannot manufacture readiness. Previously committed laps remain usable after a later recording failure.

Behavioral fixture proof and numeric release approval are separate. The matched runner measures the legacy live recorder plus production post-session splitting against live derivation; subset or accelerated samples cannot authorize activation. Current commands and measurement limitations are documented in the [contributor guide](../contributing/telemetry-recordings.md#verify-incremental-live-capture). ADRs [0011](../adr/0011-package-owned-indexed-capture-splitting.md) and [0012](../adr/0012-indexed-session-lap-archive.md) describe the historical offline decisions; live layout 3 extends rather than rewrites them.

## Canonical session file

`packages/capture-formats/src/session/recorder.ts` writes one append-only file per session:

```text
[optional 0xFFFFFFFF u32][payload length = 4 u32][total frames u32]
[stored length u32, bit 31 set][captured UTC epoch milliseconds u64 LE][stored payload]
[stored length u32, bit 31 set][captured UTC epoch milliseconds u64 LE][stored payload]
...
```

The 12-byte capture meta header holds a frame count, **not** a format or source-contract version; historical files can omit it. New live captures timestamp each accepted source frame at UDP receipt, shared-memory triplet assembly, or native-frame poll, **before** parsing, queuing, or writing. The writer only persists the supplied time. Bit 31 in the four-byte stored-length prefix indicates an additional eight-byte unsigned little-endian UTC epoch-millisecond value before the payload; remaining bits contain the stored payload length (maximum 16 MiB). Older records retain `[u32 length][payload]` without a fabricated timestamp. Record offsets and sparse checkpoint distances include all prefix bytes. The first telemetry record creates the file; sessions with no records leave no file. `total frames`, when present, is patched when the recorder stops. A truncated final record does not invalidate earlier records for ordinary replay because each payload is length-prefixed; migration rejects truncated input. `.bin.gz` wraps the same bytes in gzip; record lengths and lap byte offsets refer to the **decompressed** stream.

Readers expose the optional acquisition timestamp as `frameTimeMs` (UTC epoch milliseconds), distinct from the simulator's `TimestampMS`.

The sparse adapter writes full source frames at session start, after context boundaries, and at most every 128 frames. LMU v2 (`LMSD`) and ACC/AC Evo (`KNSD`) retain their existing 64-byte-block layouts. Forza, F1, and iRacing use `RQSD` v1: bitmap over changed 32-byte blocks, exact source length, and checkpoint back-distance; a delta is stored only when smaller than raw. Packet identity and size must match the adjacent source frame. iRacing's existing SDK delta records often remain raw. Readers validate references and reconstruct exact source bytes before parser dispatch, including streaming Analyse replay and arbitrary lap-offset seeks. Exported lap windows rebase checkpoints for independent playback. Older builds cannot read newly sparse captures.

### Full records, sparse deltas, and versions

Every telemetry record begins with a four-byte little-endian **stored payload length**; bit 31 flags an eight-byte UTC capture timestamp before the payload in new live recordings. The game source-frame bytes are unchanged. A full record's payload is the unchanged game source frame, including any game-specific header or source-frame schema version. A sparse record's payload starts with a storage-codec magic:

Capture times preserve pauses and acquisition gaps through gzip, export, import, and replay across all six games. Replay uses recorded UTC when available; simulator `TimestampMS` remains independent for games with native session clocks. ACC/AC Evo replay derives packet wall-clock time from recorded UTC; sparse captures without it cannot recover original capture times. Readers preserve missing timestamps on sparse and imported records and never invent them. Existing UTC timestamps survive import unchanged. Inter-frame gaps indicate missing or delayed acquisition, not proof of slow disk writes; identifying recorder latency requires measuring capture-to-write or flush timing separately. Timestamped records add eight bytes per stored frame and are incompatible with older readers.

`SparseSessionRecorder` and `buildLapsZip` write a separate `RSP1` version-1 meta record after the first telemetry frame. This distinguishes captures produced in sparse format even when no delta is smaller than the source frame; readers skip the marker. Playback, reprocessing, and imports accept captures identified by `RSP1` or a known sparse codec record; unmarked full-frame legacy captures are unsupported. Seed migration converts checked-in legacy fixtures to sparse captures before shared import.

| Payload starts with | Meaning |
|---|---|
| `RQSD` (`52 51 53 44` hex) | Forza/F1/iRacing generic sparse delta; next byte is codec version `01` |
| `LMSD` | LMU sparse delta; existing layout, no RQSD version byte |
| `KNSD` | ACC/AC Evo sparse delta; existing layout, no RQSD version byte |
| No sparse magic | Full, unchanged source frame |

`RQSD` v1 layout, **inside** the length-prefixed payload:

```text
["RQSD" 4 bytes][codec version u8 = 1][checkpoint back-distance u32 LE]
[original source-frame length u32 LE][changed 32-byte-block bitmap][changed blocks]
```

The checkpoint is the latest stored **full** frame. Back-distance counts bytes from the current record's length prefix to that checkpoint's length prefix; it validates the seek/reference. Changed blocks apply to the **immediately preceding reconstructed frame**, not directly to the checkpoint. Original length is the reconstructed full source-frame size, not the sparse payload size. A raw checkpoint is written at session start, after boundaries, and at least once every 128 frames, so seeking to a lap starts by finding a nearby full frame. A file may interleave full records and deltas.

Example using an observed 331-byte headerless Forza full record followed by an **illustrative identical** frame encoded as a sparse delta:

```text
full:   4b 01 00 00 | 00 00 00 00 40 50 3d 08 ...
        length 331   | original source-frame bytes (331 total)

sparse: 0f 00 00 00 | 52 51 53 44 | 01 | 4f 01 00 00 | 4b 01 00 00 | 00 00
        length 15    | "RQSD"      | v1 | back 335     | original 331 | bitmap
```

Here `335 = 4 + 331` bytes from sparse record prefix back to full record prefix. Eleven 32-byte blocks cover 331 bytes; their two-byte zero bitmap means no blocks changed. Decoder reproduces the complete 331-byte source frame. With optional meta header, the same two records start 12 bytes later; their relative back-distance remains 335.

Codec magic/version select **stored-payload decoding**. They are separate from game source-frame schema versions (for example, LMU/iRacing) and from `sessions.capture_format_version = 1`, a DB storage-format marker. The DB marker does not select decoder; readers inspect each payload's magic and validate supported codec layout/checkpoint before forwarding reconstructed frames to game parser.

Before each write, `Pipeline.processPacket()` snapshots the recorder byte offset and passes it to the active lap detector. Completed lap rows identify the first record and frame count; sparse lap seeks restore from its nearest checkpoint (at most 128 prior records).

Session rotation can occur while a detector handles a packet. `Pipeline` compares recorder epochs, writes the triggering frame to the new file when necessary, and patches the detector's current-lap offset. This keeps lap-one offsets in the correct recording.

### Replay time and Analyse behavior

All **new live recordings in all six supported games** carry `frameTimeMs` on each accepted source frame. Optionality exists for backward compatibility: older canonical recordings and imported records may lack acquisition time. `frameTimeMs` is acquisition UTC on the capture record, not a value encoded by the sparse codec or a simulator lap timer. `parseRawLapFramesFromSource()` restores the full source frame, parses it, and attaches the stored time to the packet. Sparse and full records use the same path. Imports, exports, and gzip retain timestamps when present; they cannot invent one for older records.

`resolveTelemetryReplay()` sets each semantic envelope's `observedAt` from that packet:

| Capture record | `observedAt` | Parsed packet time |
|---|---|---|
| New live frame (all six games), or any record with `frameTimeMs` | Actual acquisition UTC; `wall-clock` domain | `frameTimeMs` attached; ACC/AC Evo also set `TimestampMS` to this UTC value |
| Sparse/imported frame without `frameTimeMs`: FM/F1/iRacing/LMU | Simulator `TimestampMS`; `session` domain, if finite | Native simulator time remains unchanged |
| Sparse/imported frame without `frameTimeMs`: ACC/AC Evo | Lap persistence time; `wall-clock` domain, same fallback for each frame | Parser generates `TimestampMS` at replay time; original acquisition time is unrecoverable |
| Sparse/imported frame without `frameTimeMs`: other game with non-finite `TimestampMS` | Lap persistence time; `wall-clock` domain | Native packet time remains unchanged |

`receivedAt` is **lap-row persistence time**, not per-frame receipt time; adding `frameTimeMs` does not change it. The semantic resolver also uses `observedAt` for observation provenance and time-based freshness calculations. Do not subtract times from different domains or interpret a legacy lap's constant fallback as recorded sample cadence.

Current Analyse client copies `observedAt.milliseconds` into its frame model but does not display acquisition UTC or use it as a chart axis. Users should not expect a new time graph or changed lap boundaries/metrics. Recorded UTC makes replay timing metadata accurate; ACC/AC Evo `TimestampMS` and time-sensitive semantic values/freshness can differ for sparse captures without recorded UTC, whose parser uses replay time.

## Source records by game

| Game | Canonical raw record |
|---|---|
| Forza Motorsport 2023 | UDP datagram accepted by `parseForzaPacket()` |
| F1 25 | UDP datagram accepted by `F1StateAccumulator` |
| ACC | `ACCP` packed physics, graphics, and static pages |
| AC Evo | `ACEP` packed physics, graphics, and static pages |
| iRacing | `IRIQ` versioned session or value-delta source frame |
| Le Mans Ultimate | `RQLMUSF` versioned player telemetry and scoring source frame |

Shared-memory packed triplets use:

```text
[magic u32][car ordinal i32][track ordinal i32]
[physics length u32][physics]
[graphics length u32][graphics]
[static length u32][static]
```

The framing keeps `SessionRecorder` game-agnostic. Each server adapter's `tryParse()` recognizes and decodes its own raw records.

LMU live capture and committed replay fixtures use native shared-memory source frames. DuckDB remains a separate manual historical-import path. See [LMU recording decision](lmu-recording.md).

## Replay, import, and reprocessing

`server/session-capture/reprocess.ts` opens a supported sparse capture, gunzips it when needed, walks length-prefixed records, calls the registered game parser, and feeds a fresh lap detector backed by a capturing database adapter. Matching lap windows update raw indexes and metadata in place; changed windows rebuild detected lap rows. Replacement matching uses source-window overlap rather than lap numbers, which can repeat for open-route attempts. Matched replacements preserve notes, favorites, and tune links; session identity and user metadata remain intact.

`server/session-capture/import-capture.ts` accepts sparse RaceIQ `.bin` / `.bin.gz` uploads, identified by the `RSP1` marker or a known sparse codec record. It gunzips input, reconstructs checkpointed payloads before parsing, and preserves segment markers and recorded UTC times. Full-frame legacy uploads and simulator dump containers are rejected. `buildLapsZip` re-encodes selected session windows as sparse captures so exported `.bin.gz` members remain importable even when no codec delta is smaller. Seed scripts alone decode checked-in legacy fixtures, convert them to sparse captures, then pass those captures through the shared importer.

Development dump files are different, adapter-specific capture formats. Use [Telemetry recordings](../contributing/telemetry-recordings.md) for fixture capture and import commands; do not treat those dump containers as production session framing.

Developer fixture playback and live UDP benchmarks continue to read original raw recordings so parser and recording coverage matches acquisition. Only HTTP import payloads and seeded database captures are converted to sparse format; checked-in source fixtures remain unchanged.

### Indexed completed-session lap archives

New split publications contain `manifest.json` and `capture.bin.gz` in an immutable attempt directory under the session folder. The data file concatenates independent gzip members, one per lap or auxiliary ownership range. The package writes members directly with backpressure; no loose lap files are published. Auxiliary members rotate at 64 MiB of encoded capture data, with at most one capture-record overshoot. Each member retains independent sparse checkpoints, parser bootstrap state, and explicitly non-owned completion context.

Manifest v4 records `entryName`, physical `memberOffset`, `compressedByteLength`, and uncompressed `byteLength`. Its source byte ranges remain offsets in the decoded source capture, while `ownedFrameByteOffset` is local to the decoded member. `sourceByteLength` remains the physical source-file size, including gzip input. Detector lap numbers, including zero, are preserved rather than renumbered.

Database layout version 2 stores the actual JSON path in `sessions.captureManifestFile` and the gzip data path in `sessions.captureArchiveFile`; migration 78 adds the latter column. Layout version 1 still reads manifest v3 filesystem chunks, and null-layout historical reads retain their existing interpretation. These layout versions are independent of sparse codec and source-frame versions.

`openCaptureArchive()` validates bounded, contiguous, non-overlapping member ranges and controlled unique identities. A selected read seeks only to that member's header, DEFLATE payload, and trailer. Native CRC32, exact compressed-byte consumption, and uncompressed size checks reject corruption, hidden extra members, unsupported flags, and truncation. Offsets must be safe integers; the implementation does not depend on ZIP or 32-bit container offsets. Limits are 16 MiB per JSON manifest, 100,000 members, and 512 MiB per compressed or uncompressed member.

`SessionCaptureSource.artifact` carries the selected archive member explicitly. Replay streams it; buffer-based export/native readers allocate only that member. No entry name is presented as a filesystem path. Streamed lap consumers drain the selected member to EOF before accepting telemetry, so early lap completion cannot bypass its checksum. Metadata and telemetry caches include validated publication/file identity; selected-buffer keys include the member range. Invalid published layouts never fall back to the monolith.

The package verifies native bytes, order, timestamp presence/absence, source conservation, parser bootstrap, and owned/context windows through the production reader before publication. Closed and synced data and manifest files move together through the existing atomic directory rename and fenced DB transaction. Cancellation, stale attempts, failed writes, and failed transactions do not publish references. Recovery removes only unreferenced attempts.

Semantic artifact hashes cover the decoded selected capture bytes; `storageEncoding` is `gzip`. Retained session-source hashing remains separate. Sources are not retired by archive publication. See the [implementation plan](../plans/indexed-session-lap-archive.md) and [proposed storage decision](../adr/0012-indexed-session-lap-archive.md).


## Compression and cleanup

`server/session-capture/compressor.ts` gzips inactive `.bin` files older than 24 hours and updates `sessions.rawFile` to the `.bin.gz` path. Reprocess and import readers restore the same sparse capture byte stream transparently. User-triggered compression may also sweep unreferenced `.bin` files.

Unmarked legacy canonical `.bin` and `.bin.gz` files are unsupported for playback, reprocessing, and uploads. Seed scripts convert checked-in source fixtures into new sparse captures. `sessions.capture_format_version = 1` marks newly created sparse recordings; source-frame schema versions remain unchanged.

See [Session storage](../operations/session-storage.md) for lifecycle, orphan handling, and operational constraints.

## Raw capture versus exported channels

RaceIQ session capture is intentionally larger than a channel-oriented format such as MoTeC `.ld`:

- A raw frame preserves every source byte, including fields RaceIQ does not decode yet.
- A channel log stores only values selected and parsed by its exporter.
- Raw frames support future parser fixes and new derivations; omitted channel-log data cannot be reconstructed.

That trade-off does not imply higher measurement fidelity. Sample cadence, duplicate source frames, per-channel update rates, and source limitations still apply. See [Telemetry fidelity](../research/telemetry-fidelity.md).

## Reliability invariants

- Graceful shutdown flushes the session recorder and native readers before exit.
- Lap byte offsets always point to the length prefix of a canonical raw record.
- Parser and replay state are isolated per import/reprocess operation.
- Seed conversion parses legacy source frames and writes sparse captures; application replay and reprocessing accept sparse captures only.
- Compressed and uncompressed files must decode to the same record stream.

## Implementation map

- `packages/capture-formats/src/session/recorder.ts` — canonical append-only writer
- `server/telemetry/live-pipeline.ts` — raw write ordering and lap offsets
- `packages/capture-formats/src/kunos/pack-triplet.ts` — ACC and AC Evo records
- `packages/capture-formats/src/session/sparse-recorder.ts` — checkpointed encoder and production writer for all six games
- `packages/capture-formats/src/session/{lmu-sparse,kunos-sparse,generic-sparse}.ts` — source-byte-preserving delta codecs
- `packages/capture-formats/src/session/framing.ts` and `server/session-capture/source-loader.ts` — bounded seeks and streaming restoration
- `packages/capture-formats/src/iracing/source-frame.ts` — iRacing records
- `server/session-capture/import-capture.ts` — capture detection and canonical import entry
- `server/session-capture/import-pipeline.ts` — parser, detector, and persistence pipeline
- `server/session-capture/reprocess.ts` — detector replay and index refresh
- `server/session-capture/compressor.ts` — background gzip
- `packages/capture-splitting/src/{archive,contract,index}.ts` — indexed gzip contract, bounded member reader, lossless writer and verifier
