# Lap telemetry cache

RaceIQ caches parsed `TelemetryPacket[]` by lap ID in memory. Analysis,
comparison, and chat workflows can reuse decoded telemetry instead of reading
and parsing the same raw session slice repeatedly.

Implementation lives in `server/db/queries.ts`.

## Contract

- Process-local and non-persistent.
- Populated only after a successful, non-empty parse.
- Bounded by an estimated byte budget.
- Least-recently-used eviction.
- No time-to-live.

`getLapById()` serves a cache hit directly. On a miss it parses the lap's raw
frames and caches successful output. `getLapsByIds()` groups misses by session
file, decodes each session in one forward pass, and warms every resolved lap.

## LRU and budget

Cache uses insertion order of a `Map<number, CacheEntry>`. A hit removes and
reinserts its entry, moving it to the most-recent end. `cacheSet()` evicts from
the oldest end until `cacheBytesUsed <= cacheMaxBytes`.

Default limit is 256 MiB. `setCacheMaxBytes()` applies a new limit and evicts
immediately when necessary. Settings exposes the limit; `GET /api/cache/status`
returns:

```ts
{ bytesUsed: number; maxBytes: number; entries: number }
```

The budget is an estimate, not a heap measurement. Current per-packet estimates
are 500 bytes for base packets, 800 for packets with ACC extensions, and 1100
for packets with F1 extensions. Exact object overhead varies by runtime.

## Invalidation

Cached lap telemetry is removed when its source identity can change:

- one lap is deleted;
- a lap raw index is updated during reprocessing;
- replacement reconciliation removes old lap rows;
- session-wide lap deletion removes affected rows.

A server restart clears all entries. New lap IDs cannot collide with existing
entries, so inserts do not require invalidating another key.

## Observability and tests

`getCacheStats()` powers storage settings. `_telemetryCacheForTest` exposes
narrow helpers for LRU, byte-budget, replacement, and deletion tests; it is not
a production API.

Callers should use `getLapById()` or `getLapsByIds()` rather than bypassing cache
and parsing raw session data directly.
