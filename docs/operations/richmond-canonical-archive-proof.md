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
- Completeness: `complete`
- Physical sample-order mismatches: 0

`verifyCanonicalArchiveParquet` passed against all 370,498 expected rows. Parquet sample count equals RaceIQ recorder frame count. Archive source identity equals `.bin` and decoded `.bin.gz` identity.

## Run and stint structure

SQLite evidence is retained at:

`test/artifacts/local/iracing/richmond-work/test.db`

Persisted run records:

- Total runs: 11
- Driver runs: 1
- Participant runs: 1
- Pace runs: 7
- Tire runs: 2

Pace ranges:

1. Laps 1–36
2. Laps 37–54
3. Laps 55–81
4. Laps 82–86
5. Service transition with no lap membership
6. Laps 87–179
7. Laps 180–200

Tire ranges:

1. Laps 1–86
2. Laps 87–200

These boundaries provide stable anchors for correlating video timestamps with IBT frames, RaceIQ packets, Parquet samples, race events, laps, fuel-service boundaries, and tire-service boundaries.

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
