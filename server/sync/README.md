# Sync

## Purpose

Owns synchronization of community leaderboard lap times from the configured community CDN into the server's in-memory cache. `laptimes.ts` exposes cache reads, an explicit sync pass, and startup scheduling.

## Structure

- `laptimes.ts` validates the CDN manifest and per-game payloads, maps CDN manifest keys to supported RaceIQ game IDs, updates per-game cache entries, and schedules the six-hour refresh.

## Boundaries and invariants

- `COMMUNITY_TUNES_URL` overrides the default CDN origin; manifest and payload paths retain their existing URL-resolution rules.
- Manifest version equality skips non-forced refreshes. Forced refreshes re-fetch without changing merge behavior.
- Each valid game payload replaces only that game's cached rows. Missing, failed, or invalid game payloads preserve that game's prior cache.
- Invalid rows are skipped individually. Cache is memory-only and is repopulated after restart.
- Sync does not persist leaderboard data or join it to tunes.
- Route handlers consume cache reads and manual refresh results; runtime startup owns when `startLaptimesSync` is invoked. This domain does not import either domain.

## Testing

Exercise `syncLaptimes` with mocked manifest and per-game fetch responses, covering unchanged versions, forced refreshes, partial game failures, invalid rows, and relative or absolute payload paths. Verify `getLaptimes` retains prior rows for failed games and returns newly validated rows for successful games.
