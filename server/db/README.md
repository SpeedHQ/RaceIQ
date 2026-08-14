# Database domain

## Purpose

Owns RaceIQ's SQLite persistence boundary: connection startup, schema evolution, domain queries, and telemetry replay storage. Callers use focused query modules rather than issuing SQL outside this folder.

## Structure

- `index.ts` creates the libSQL/Drizzle client and exposes idempotent `initDb()` startup.
- `schema.ts` describes current tables; `migrations.ts` preserves ordered upgrades for existing databases.
- `*-queries.ts` modules group reads and mutations by stored aggregate. Lap operations are split between read, mutation, reprocessing, and experiment-link concerns.
- `lap-eligibility.ts` reads persisted policy decisions in SQL without defining policy rules.
- `quality-event-queries.ts` links localized quality facts to durable session events and invalidates generation-tied analysis caches.
- `telemetry-codec.ts` serializes compressed CSV telemetry fixtures; `telemetry-replay-storage.ts` replays indexed frames from session capture files and owns replay caches.
- `discovered-*.ts` persists game-provided identities that are not yet in static catalogs.

## Boundaries and invariants

- Schema and migration history are append-only compatibility contracts. Change both deliberately; never rewrite an applied migration.
- Entrypoints must await `initDb()` before querying. Foreign keys, WAL mode, backfills, and migration ordering are established there.
- Raw session files are the authoritative telemetry replay source; frame offsets and counts retain their persisted meaning.
- Query modules normalize SQLite nulls and booleans at the boundary. Game IDs, ordinal pairs, experiment links, and exclusion provenance must remain scoped together.
- Session and lap quality, eligibility decision snapshots, version identities, event links, and source/output generations are persisted compatibility data. SQL may select by stored status only when schema, policy, configuration, JSON provenance, and stored generation identities are current. Policy evaluation remains in `shared/racing/quality/`.
- Database code may use game adapters to interpret persisted telemetry, but game policy and parsing semantics stay in their owning domains.

## Testing

Use an isolated `DATA_DIR`. Run the focused storage or query test file for changed behavior; telemetry replay changes should include `test/telemetry-storage.test.ts`, while schema or migration changes require database seed and migration coverage. Verify startup through `initDb()` rather than constructing an uninitialized client.
