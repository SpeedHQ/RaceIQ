# Database domain

## Purpose

Owns RaceIQ's SQLite persistence boundary: connection startup, schema evolution, domain queries, and telemetry replay storage. Callers use focused query modules rather than issuing SQL outside this folder.

## Structure

- `index.ts` creates the libSQL/Drizzle client and exposes idempotent `initDb()` startup.
- `schema.ts` describes current tables; `migrations.ts` preserves ordered upgrades for existing databases.
- `*-queries.ts` modules group reads and mutations by stored aggregate. Lap operations are split between read, mutation, reprocessing, and experiment-link concerns.
- `telemetry-codec.ts` serializes compressed CSV telemetry fixtures; `telemetry-replay-storage.ts` replays indexed frames from session capture files and owns replay caches.
- `discovered-*.ts` persists game-provided identities that are not yet in static catalogs.

## Boundaries and invariants

- Schema and migration history are append-only compatibility contracts. Change both deliberately; never rewrite an applied migration.
- Entrypoints must await `initDb()` before querying. Foreign keys, WAL mode, backfills, and migration ordering are established there.
- Dashboard authentication shares the application-owned libSQL client. Auth code must not open or close a separate SQLite connection; mixing libSQL and `bun:sqlite` on a live WAL database can unlink the WAL while another connection is still writing. Entrypoints own connection shutdown after all database work completes.
- Repository lint forbids `bun:sqlite` imports, re-exports, dynamic imports, and CommonJS loading. Standalone synchronous fixtures and tooling use native `libsql`; runtime authentication uses the shared application client.
- Raw session files are the authoritative telemetry replay source; frame offsets and counts retain their persisted meaning.
- Query modules normalize SQLite nulls and booleans at the boundary. Game IDs, string `carId`/`trackId` pairs, experiment links, and exclusion provenance must remain scoped together.
- Database code may use game adapters to interpret persisted telemetry, but game policy and parsing semantics stay in their owning domains.
- AC Evo stores the exact trimmed source car name and a JSON `[trackName, trackConfiguration]` tuple. Numeric game IDs become strings at normalization; binary source formats stay unchanged.
- Historical ordinal columns are migration inputs only. Identity upgrades preserve session/lap IDs and user annotations; unresolved AC Evo IDs remain empty until source capture recovery.
- Restore a pre-upgrade database backup to roll back an identity schema upgrade; older binaries cannot read the contracted schema.

## Testing

Use an isolated `DATA_DIR`. Run the focused storage or query test file for changed behavior; telemetry replay changes should include `test/telemetry-storage.test.ts`, while schema or migration changes require database seed and migration coverage. Verify startup through `initDb()` rather than constructing an uninitialized client.
