# Lap Telemetry Cache

In-memory cache of parsed `TelemetryPacket[]` per lap. Backs analyse, compare, and chat workflows so they don't re-parse a `.bin` slice on every request.

Lives in `server/db/queries.ts` — `cacheGet`, `cacheSet`, `cacheDelete`, `setCacheMaxBytes`, `getCacheStats`.

## Why

Each lap is reconstructed by seeking into a `.bin` (or gunzipping a `.bin.gz`) at the lap's `rawByteOffset`, then parsing N frames. For a hot path (compare two laps, chat asks four follow-ups, analyst re-runs) that's tens of MB of disk + parse work per request. Cache holds the parsed array and serves directly.

Process-local Map. No persistence. Survives the lifetime of one server process.

## Eviction

LRU by insertion order. `Map` preserves insertion order; `cacheGet` re-inserts on hit so the most-recent stays at the back.

```
cacheGet(id)   — promote on hit
cacheSet(id, packets) — insert + evict from front until under budget
cacheDelete(id)  — explicit removal (called from delete-lap paths)
```

`evictUntilWithinBudget()` walks from the front (oldest) until `cacheBytesUsed <= cacheMaxBytes`.

## Budget

`cacheMaxBytes` defaults to 256 MB. User-tunable via Settings → Storage → "Cache size limit (MB)" (16–2048).

```
settings.json: { "cacheMaxMB": 256 }
  → setCacheMaxBytes(256 * 1024 * 1024)
  → evictUntilWithinBudget()
```

Lowering the limit triggers immediate eviction. Raising just expands headroom.

## Byte estimate

`TelemetryPacket` has ~50–80 numeric fields plus optional game-specific extensions. Per-packet rough cost:

| Game | Bytes/packet |
|---|---|
| Forza | 500 |
| ACC | 800 |
| F1 2025 | 1100 |

Sniffed from the first packet's `f1` / `acc` extension presence. Estimate, not exact `JSON.stringify` size — close enough for budget enforcement; precision wouldn't change which laps get evicted.

## API

`GET /api/cache/status` → `{ bytesUsed, maxBytes, entries }` — feeds the donut/bar in Settings → Storage. Polled every 5s by the UI.

## Settings UI

`client/src/components/settings/StorageSection.tsx` → `CacheSection`:

- Live used/max bar (refresh 5s).
- Entry count.
- Editable MB limit. Save button hits `/api/settings`, which calls `setCacheMaxBytes(...)`. Change is non-persistent across cache contents — eviction may run, no restart needed.

## Test hooks

`_telemetryCacheForTest` exposes get/set/delete/clear/size/bytesUsed/maxBytes/setMaxBytes/resetMaxBytes/keys/estimateBytes for `test/lap-cache.test.ts`. Not part of the public surface.

## Lifecycle

- Populated lazily by lap-fetch paths after parsing.
- Evicted on budget pressure or explicit `cacheDelete(id)` (e.g. lap row removal in `deleteLapsForSession`).
- Cleared implicitly on server restart — process-local Map.

## What it doesn't do

- No disk persistence. A restart re-parses on next access.
- No TTL. Entries live until evicted by LRU pressure.
- No invalidation on lap edits — direct callers must `cacheDelete` themselves. Currently only `deleteLapsForSession` does this; lap inserts go through fresh fetches so stale-key risk is low.
