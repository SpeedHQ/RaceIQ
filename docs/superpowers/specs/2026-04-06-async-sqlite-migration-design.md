# Async SQLite Migration: bun:sqlite to @libsql/client

## Problem

`bun:sqlite` is synchronous — every query blocks the event loop. The `getLaps()` query (joins laps + sessions + tunes, returns up to 200 rows) causes visible UI pauses because the WebSocket broadcast and HTTP responses stall while SQLite runs.

A background Worker was attempted but Bun's Worker API silently fails in compiled Windows executables (SpeedHQ/RaceIQ#13).

## Solution

Replace `bun:sqlite` with `@libsql/client` + `drizzle-orm/libsql`. libsql is a SQLite fork with a truly async API. Drizzle's query builder is adapter-agnostic — the schema and query shapes stay identical, only the driver layer changes.

## Scope

- Replace the DB driver in `server/db/index.ts`
- Make all query functions async in `queries.ts` and `tune-queries.ts`
- Add `await` to all call sites (routes, lap-detector, zip, index.ts)
- Remove the worker-client shim
- Update drizzle-kit config for libsql
- Update dependencies

## Out of scope

- Schema changes (none needed)
- Client changes (none needed — API response shapes are unchanged)
- Migration SQL changes (same SQLite dialect)
- Settings (already file-based)

## Design

### DB initialization (`server/db/index.ts`)

Before:
```typescript
import { Database } from "bun:sqlite";
const sqlite = new Database(DB_PATH);
sqlite.exec("PRAGMA journal_mode = WAL");
export const db = drizzle(sqlite, { schema });
export { sqlite };
```

After:
```typescript
import { createClient } from "@libsql/client";
const client = createClient({ url: `file:${DB_PATH}` });
await client.execute("PRAGMA journal_mode = WAL");
export const db = drizzle(client, { schema });
export { client };
```

Key difference: initialization is now async. The module uses top-level await (already used elsewhere in the codebase, e.g. `server/index.ts`).

### Migrations

Currently sync `sqlite.exec()` calls wrapped in BEGIN/COMMIT. Becomes `await client.execute()`. libsql supports transactions via `client.transaction()` or manual BEGIN/COMMIT.

### Query functions (`queries.ts`, `tune-queries.ts`)

Mechanical transformation: every function gets `async`, every Drizzle call gets `await`.

Before:
```typescript
export function getLaps(...): LapMeta[] {
  const rows = db.select(...).from(laps).innerJoin(...).all();
  return rows.map(...);
}
```

After:
```typescript
export async function getLaps(...): Promise<LapMeta[]> {
  const rows = await db.select(...).from(laps).innerJoin(...).all();
  return rows.map(...);
}
```

### Raw SQL calls

A few places use raw `sqlite.query()` / `sqlite.exec()` (startup profile check in `index.ts`, migration runner). These become `await client.execute()`.

libsql's `execute()` returns `{ rows, columns, ... }` — slightly different from bun:sqlite's `query().get()` which returns a plain object. Raw calls need minor result unwrapping.

### worker-client.ts

Becomes a thin passthrough:
```typescript
export { getLaps as getLapsAsync } from "./queries";
```

Or we inline the `getLaps` import at the single call site in `lap-routes.ts` and delete `worker-client.ts` entirely.

### Call site changes

All call sites already handle promises (route handlers are async, lap-detector uses await). The change is adding `await` where sync calls were used.

### Dependencies

- Add: `@libsql/client`
- Remove: `better-sqlite3` (currently unused — was a fallback)
- Keep: `drizzle-orm`, `drizzle-kit`
- Update: `drizzle.config.ts` — change driver to `libsql`

### Compiled binary

`@libsql/client` defaults to native bindings (`libsql`). If these don't bundle in Bun's compiled executable, switch the import to `@libsql/client/sqlite3` (pure JS SQLite3 backend, no native code). Test after build.

### Testing

- All existing tests pass (parser tests don't touch DB)
- Manual test: start dev server, verify laps load, verify live telemetry doesn't pause when lap list refreshes
- Manual test: build installer, run from Program Files, verify startup and lap list

## Files changed

| File | Change |
|------|--------|
| `server/db/index.ts` | Replace bun:sqlite with libsql client, async init |
| `server/db/queries.ts` | All functions async |
| `server/db/tune-queries.ts` | All functions async |
| `server/db/worker-client.ts` | Remove or reduce to re-export |
| `server/index.ts` | await DB calls, import client instead of sqlite |
| `server/lap-detector.ts` | await query calls |
| `server/routes/*.ts` | await query calls |
| `server/zip.ts` | await query calls |
| `server/corner-detection.ts` | Check if it calls DB directly |
| `package.json` | Add @libsql/client, remove better-sqlite3 |
| `drizzle.config.ts` | Update driver |

## Risks

- **Low:** Drizzle's SQLite query API is identical across adapters. This is a mechanical async transformation.
- **Medium:** Native bindings in compiled binary. Mitigation: fall back to `@libsql/client/sqlite3`.
- **Low:** PRAGMA behavior differences between bun:sqlite and libsql. Both are SQLite under the hood — WAL, foreign keys, busy_timeout all work the same.
