# ADR 0001: Separate native LMU capture from historical DuckDB import

- **Status:** Accepted
- **Date:** 2026-09-19
- **Decision owners:** RaceIQ maintainers
- **Implementation status:** Source boundary and native fixture tooling implemented; committed fixture replacement awaits a new native LMU capture

## Context

Le Mans Ultimate exposes live telemetry through its `LMU_Data` shared-memory interface. It can also produce DuckDB telemetry recordings that users may retain independently of RaceIQ.

These sources serve different user workflows and have different fidelity guarantees:

- Shared memory exposes native simulator state while RaceIQ and LMU run together.
- DuckDB contains exported channels and events from a completed or historical session.
- A channel-oriented DuckDB recording may omit native fields and update channels at different rates.
- Native source frames preserve fields RaceIQ does not decode yet and can be replayed after parser improvements.

The original LMU seed fixture was generated from DuckDB and downsampled to 10 Hz. That fixture did not represent live shared-memory capture and produced visibly coarse replay. It also blurred the boundary between live recording and manual historical import.

## Decision

RaceIQ supports two explicit, independent LMU ingestion paths.

### Native shared-memory capture

Native shared memory is the authoritative path for live LMU telemetry and RaceIQ-owned recordings.

1. `LMUTelemetrySource` polls `LMU_Data` every 10 ms.
2. Unchanged simulator snapshots are discarded using session event and elapsed time.
3. `encodeLMUSourceFrame()` packages each changed player snapshot as a versioned `RQLMUSF` frame.
4. The LMU adapter parses that frame into `TelemetryPacket`.
5. The live pipeline performs lap detection, persistence, WebSocket broadcast, and canonical session recording.

Native captures retain simulator cadence. RaceIQ must not deliberately downsample them for committed fixtures or replay.

LMU's installed SDK exposes per-update `mDeltaTime` and an update event, but
does not contract a numeric telemetry frequency. RaceIQ therefore treats native
cadence as source-defined rather than assuming 50 Hz or 100 Hz.

Native shared-memory captures are the source for:

- live dashboards;
- automatic session and lap recording;
- parser and lap-detector fixtures;
- seeded replay and Analyse validation;
- replay-fidelity and cadence tests.

### Manual DuckDB import

DuckDB remains an optional manual import method for historical sessions recorded without RaceIQ running.

1. User explicitly selects a `.duckdb` file in Sessions.
2. If the database has uncheckpointed data, user also selects its matching `.duckdb.wal` sidecar.
3. Import preview validates LMU metadata, channel indexes, drivable samples, and completed laps.
4. Importer samples available channels onto its fixed 50 Hz conversion timeline.
5. Importer encodes versioned LMU source frames and feeds the normal parser and import pipeline.
6. Imported laps then use the same persistence and replay contracts as other RaceIQ sessions.

Synthetic source frames are an internal compatibility boundary for manual import. They do not make DuckDB equivalent to native shared memory and do not establish live source cadence or fidelity.

DuckDB is the source for:

- manual historical-session import;
- import preview and validation tests;
- channel and event alignment tests;
- WAL-sidecar handling tests;
- missing-channel and incomplete-session behavior.

### Fixture provenance

Committed native LMU fixtures must originate from `LMURecorder` output captured from shared memory. Fixture tooling may trim complete laps and anonymize identity, but must preserve every selected source frame.

DuckDB recordings must not be converted into native LMU fixtures, seed replay data, or live-cadence benchmarks. Real or synthetic DuckDB fixtures remain isolated to importer tests.

## Invariants

- Live LMU operation never depends on DuckDB.
- Manual DuckDB import never starts or substitutes for the live shared-memory source.
- Native frames remain source-format bytes until adapter parsing; normalization happens afterward.
- Fixture generation preserves selected native frame cadence and does not interpolate missing samples.
- Imported DuckDB telemetry exposes only channels supported by the recording and importer mapping.
- Both paths converge on the registered LMU adapter and telemetry pipeline after source-specific acquisition.
- Tests identify fixture provenance and do not use an imported fixture to claim native fidelity.

## Consequences

### Benefits

- Live and replay tests represent actual LMU shared-memory behavior.
- Historical DuckDB sessions remain importable when RaceIQ was not running.
- Parser, lap detector, persistence, and semantic replay remain shared after source acquisition.
- Source limitations are explicit instead of hidden behind a common fixture format.

### Costs

- Two acquisition paths require separate tests and documentation.
- DuckDB channel mapping must track changes in LMU-exported schemas.
- Native fixture refreshes require running LMU and recording a representative session.
- Imported telemetry may have lower fidelity than native captures even though both replay through the same adapter.

## Rejected alternatives

### Use DuckDB as the primary LMU source

Rejected because it cannot provide live telemetry and does not preserve complete native shared-memory state.

### Remove DuckDB support

Rejected because users need to import historical LMU sessions recorded before or without RaceIQ.

### Generate native fixtures from DuckDB

Rejected because generated frames validate importer conversion, not native shared-memory acquisition or cadence.

### Upsample downsampled fixtures

Rejected because interpolation improves appearance without restoring source measurements and would misrepresent telemetry fidelity.

## Implementation map

- `server/games/lmu/source.ts` — native shared-memory polling and dispatch
- `server/games/lmu/memory-reader.ts` — `LMU_Data` access
- `server/games/lmu/source-frame.ts` — versioned native frame encoding
- `server/games/lmu/normalizer.ts` — source-frame normalization
- `server/games/lmu/import-duckdb.ts` — manual DuckDB preview and conversion
- `server/routes/laps/transfer-routes.ts` — manual import detection and execution
- `client/src/components/sessions/SessionImportModal.tsx` — DuckDB and WAL selection
- `test/games/lmu/lmu-adapter.test.ts` — source and importer contracts
- `test/e2e/lmu-recording-fixture.test.ts` — native fixture replay contract
- `SpeedHQ/extractions/src/games/lmu/generate-seed-fixture.ts` — native fixture trimming and anonymization
