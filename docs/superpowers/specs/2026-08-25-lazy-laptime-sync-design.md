# Lazy Laptime Sync Design

## Goal

Remove community leaderboard CDN work from normal server startup while preserving fast, reliable leaderboard data when the feature is first used.

## Current behavior

`server/runtime/boot.ts` starts `startSyncAndStaleSessionJobs()` after the HTTP server listens. That invokes `startLaptimesSync()`, which immediately fetches the CDN manifest and three game payloads into an in-memory cache, then uses `setInterval` for six-hour refreshes. The cache is lost on every Bun restart.

The data is consumed only by `GET /api/laptimes`, which feeds `CommunityLeaderboard`.

## Architecture

- Remove laptime startup work from `startSyncAndStaleSessionJobs`; stale-session and community-tune startup behavior remain unchanged.
- Keep `syncLaptimes()` as the single fetch, validation, version-check, and cache-update operation.
- Add a process-local first-use gate in `server/sync/laptimes.ts`.
- The first `GET /api/laptimes` request awaits one initial `syncLaptimes()` call before reading the cache. Concurrent first requests share the same promise and do not start duplicate fetches.
- Start an in-process `Bun.cron("0 */6 * * *", ...)` job only after first use. The cron callback invokes `syncLaptimes()` and retains existing failure handling.
- Keep `POST /api/laptimes/refresh` as an explicit forced refresh. It may be used before the first GET and must not create duplicate cron jobs.
- Do not persist laptimes in this change. Restarting the process still clears the cache, but the cost is paid only if the leaderboard is requested.

## API behavior

`GET /api/laptimes` remains response-compatible. With a game header, it returns the cached rows after initial lazy hydration. Without a game header, it returns an empty array as today; it does not need to trigger a CDN fetch because no leaderboard data is requested.

If initial CDN sync fails, the endpoint returns the existing cache (normally empty) and the request remains successful under current sync error semantics. A later request may retry initial hydration. Existing cached rows remain available across failed scheduled refreshes.

## Scheduling

Use Bun's in-process `Bun.cron` API, not `setInterval`. The schedule `0 */6 * * *` runs at hour 0, 6, 12, and 18 in the process timezone. The job is process-local and intentionally does not survive process restarts; first-use hydration re-establishes it.

The existing `syncInProgress` guard remains as defense in depth. The first-use promise gate handles concurrent route requests; the guard protects manual refresh and cron overlap.

## Tests

Add focused tests covering:

1. startup job wiring does not invoke laptime sync;
2. first game-scoped GET triggers exactly one sync and returns its rows;
3. concurrent first game-scoped GET requests share one sync;
4. a GET without `X-Game-Id` does not trigger sync;
5. scheduled refresh registration occurs once after first use;
6. manual forced refresh remains available;
7. failed initial sync does not crash the route and permits a later retry.

Use dependency injection or a narrow scheduler seam so tests do not depend on wall-clock cron execution.

## Non-goals

- No SQLite/libSQL laptime table or materialized-view emulation.
- No change to laptime payload schema, CDN manifest format, route shape, or leaderboard rendering.
- No change to community-tune synchronization.
