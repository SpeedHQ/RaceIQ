# Richmond Canonical Archive Conversion Proof

Date: 2026-08-21

## Scope

This report records production-path conversion of a complete iRacing race at Richmond Raceway:

```text
iRacing IBT -> RaceIQ .bin -> RaceIQ .bin.gz -> canonical Parquet
```

Large local recordings are stored under `test/artifacts/local/` and ignored by Git. This proof is committed; source and generated binaries remain local.

## Source recording

- Path: `test/artifacts/local/iracing/richmond-nis-win.ibt`
- Size: 410,413,173 bytes
- Track: Richmond Raceway
- Car: NASCAR Ford Mustang
- IBT schema version: 2
- Driving frames: 349,750
- Lap transitions: 203
- Candidate laps: 201
- Import eligibility: `canImport: true`

Production IBT preview completed in 11.64 seconds from the repository-local path.

## Production conversion

The IBT was staged and committed through `stageIbtUpload` and `commitStagedIbt`. The normal iRacing adapter, lap detector, session pipeline, and `SessionRecorder` produced RaceIQ framing.

### RaceIQ `.bin`

- Inspection copy: `test/artifacts/local/iracing/richmond-work/richmond-session.bin`
- Size: 347,989,219 bytes
- Recorder-declared frames: 370,498
- Persisted laps: 200
- Valid laps: 199
- Source identity: `sha256:7c9505f106debf074b1d198d3f9e3f58957a136b9a53bd39bbbc9b2a9f6c8c61`

Preview reported 201 candidate laps. Production persistence retained laps 1–200; initial partial/reset evidence did not become an additional persisted race lap.

### RaceIQ `.bin.gz`

- Path: `test/artifacts/local/iracing/richmond-work/sessions/iracing/2026-08-21T21-50-59-601Z.bin.gz`
- Size: 147,366,867 bytes
- Decoded size: 347,989,219 bytes
- Decoded identity: `sha256:7c9505f106debf074b1d198d3f9e3f58957a136b9a53bd39bbbc9b2a9f6c8c61`

The `.bin` and decoded `.bin.gz` byte counts and SHA-256 identities match exactly.

### Canonical Parquet

- Path: `test/artifacts/local/iracing/richmond-work/archives/sessions/1/analysis-generation_8a6ea648e5c7b3d2ad6a97201ecf9a3ab1b91a71cc771c1c570a6eea267958a4/telemetry.parquet`
- Size: 117,639,102 bytes
- Samples: 370,498
- Canonical nodes: 214
- Source identity: `sha256:7c9505f106debf074b1d198d3f9e3f58957a136b9a53bd39bbbc9b2a9f6c8c61`
- Output identity: `sha256:3d410d7e6473609b26f3de1ae59dd127ca16619050ca34ba0228ebf0822c24bc`
- Status: `verified`
- Sample archive completeness: `complete`
- Physical sample-order mismatches: 0

`verifyCanonicalArchiveParquet` passed structural checks against all 370,498 expected rows. Parquet sample count equals RaceIQ recorder frame count. Archive source identity equals `.bin` and decoded `.bin.gz` identity. This verifies physical sample archival, not semantic event detection.

## Semantic detector validation

The original SQLite evidence remains at:

`test/artifacts/local/iracing/richmond-work/test.db`

That database records the pre-fix detector baseline. Current verification replayed all 370,498 RaceIQ packets through the production parser, canonical semantic projector, race-event coordinator, lap detector, and session-run builder.

### Source priority

- [`richmond win review.md`](./richmond%20win%20review.md) records direct video evidence and remains authoritative for cautions, restarts, tire changes, repairs, contact, and race narrative.
- The IBT, RaceIQ recording, and canonical Parquet prove sample preservation and provide raw telemetry for correlation.
- Canonical semantic events corroborate video when source telemetry carries the fact. Missing or conflicting source evidence must remain explicit rather than override the video.

### Corrected race-control evidence

- Detected 16 complete full-course caution lifecycles.
- Native caution-start lap values: 1, 8, 18, 26, 35, 53, 59, 79, 85, 100, 106, 111, 177, 183, 188, and 193.
- Detected 16 caution ends and green restarts.
- Delayed restart around lap 39 remained one continuous caution instead of becoming a false second caution.
- Detected the checkered flag on native lap 200 and retained lap 200 in every active session run.

iRacing reports the current lap at the event sample. Video notes often describe the lap being entered, so a native green event on lap 5 corresponds to taking green entering lap 6. The same indexing explains video/native one-lap offsets around several caution transitions.

### Corrected pit-service evidence

The semantic detector found eight pit entries and eight pit exits. Entry laps align with video: 36, 54, 81, 86, 88, 102, 107, and 179.

| Evidence | Canonical semantic result | Video reconciliation |
|---|---|---|
| Tire service | Full four-corner changes on laps 37, 55, 82, 108, and 180 | Matches five video-observed four-tire stops. No false tire event on fuel-only lap 87. |
| Fuel service | Laps 37, 55, 82, 87, and 180 | Matches native fuel-level increases. Video reports fuel on lap 108, but native `PitSvFuel`, service flags, and fuel level show no qualifying fuel addition there; telemetry cannot corroborate that action. |
| Repair activity | Native repair countdown decreased on laps 55, 82, 87, 103, 108, and 180 | Confirms video-observed repair activity on laps 87, 103, and 108 and supports the uncertain lap 55 wait. Laps 82 and 180 show automatic repair countdown activity, not proof that the driver intentionally waited for repairs. |
| Drive-through | Entered lap 88 and exited lap 89 without a stall | Independently supports the video note that this visit may have been a drive-through; neither source establishes why I returned. |
| Service lifecycle | Seven completed stops and one drive-through | Pre-race pit-stall state no longer fabricates service. Each real visit has at most one completion despite one-frame stall-state flicker. |

### Corrected run structure

- Participant runs: 1, laps 1–200
- Driver runs: 1, laps 1–200
- Tire runs: 6
- Tire memberships: laps 1–36, 37–54, 55–81, 82–107, 108–179, and 180–200
- Pace runs: 8
- Pace memberships: laps 1–36, 37–54, 55–81, 82–86, 87–102, 103–107, 108–179, and 180–200
- Zero-membership runs: 0

Pace runs remain service-delimited segments, not uninterrupted green-flag periods. Caution and formation conditions stay attached to their laps so pace analysis can exclude them without fragmenting participant, driver, tire, or pace runs on every flag transition.

### Original regression baseline

The original database produced seven pace runs, two tire runs, one false lap 87 tire event, no repair events, no caution lifecycle, and one zero-membership transition. Keep it only as regression evidence. Regenerate persisted detector artifacts before using them for current analysis.

## Losslessness checks

| Boundary | Check | Result |
|---|---|---|
| IBT import | Production preview and import | 201 candidates; 200 persisted laps |
| `.bin` -> `.bin.gz` | Decoded byte count | Exact match |
| `.bin` -> `.bin.gz` | Decoded SHA-256 | Exact match |
| `.bin.gz` -> Parquet | Source SHA-256 | Exact match |
| Recorder -> Parquet | Frame/sample count | 370,498 = 370,498 |
| Parquet | Structural verification | Passed |
| Parquet | Physical sample ordering | 0 mismatches |
| Parquet | Status/completeness | `verified` / `complete` |

These checks prove lossless transport and complete sample archival. They do not validate semantic interpretation of cautions, tire changes, repairs, or pace/tire run boundaries.

## Reproduction tools

Local conversion scripts:

- `test/artifacts/local/iracing/build-richmond-archive.ts`
- `test/artifacts/local/iracing/resume-richmond-parquet.ts`

Use a fresh local data directory for a complete import:

```powershell
$env:DATA_DIR = "$PWD/test/artifacts/local/iracing/richmond-work"
$env:RACEIQ_TEST_MODE = "1"
bun test/artifacts/local/iracing/build-richmond-archive.ts
```

The resume script rebuilds or verifies Parquet from an existing compressed RaceIQ recording without repeating the IBT import:

```powershell
$env:DATA_DIR = "$PWD/test/artifacts/local/iracing/richmond-work"
$env:RACEIQ_TEST_MODE = "1"
bun test/artifacts/local/iracing/resume-richmond-parquet.ts
```

Local machine-readable summary:

`test/artifacts/local/iracing/richmond-conversion.json`

## Implementation verification

Long-session archive writing now serializes packet JSON directly into bounded DuckDB appender batches instead of retaining JSON strings in `SampleRow`. Writer configuration:

- Maximum packets: 500,000
- Per-packet JSON limit: 256 KiB
- Aggregate streamed JSON limit: 2 GiB
- DuckDB writer memory: 1 GiB
- DuckDB spill quota: 1 GiB
- Threads: 1
- Physical export order: `ORDER BY sample_ordinal`
- Parquet output limit: 512 MiB

Focused verification:

- `bun run typecheck`: passed
- Canonical archive focused tests: 14 passed
- Five permanent GameId archive contracts: passed
- Real Richmond conversion: verified complete, 370,498 samples

Implementation commit:

`6772ebfde3a4690c85c5d7f9361c016b22c8c3d4` — `fix: stream long canonical archive builds`
