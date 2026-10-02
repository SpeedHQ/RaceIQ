# Tunes

## Purpose

Synchronize published community tune catalogs from the configured CDN into RaceIQ's persistent local cache.

## Structure

- `community-sync.ts` owns manifest retrieval, payload validation and projection, per-game replacement, manual forced refreshes, and the recurring startup schedule.
- `syncCommunityTunes` is the on-demand entry point used by the community refresh route.
- `startCommunityTunesSync` starts the non-blocking initial pass and six-hour schedule.

## Boundaries and invariants

- CDN base URLs come from `COMMUNITY_TUNES_URL`, with the production Pages deployment as the fallback. Manifest and payload paths retain their existing URL-resolution rules.
- Only explicitly listed game IDs are synchronized. A missing manifest entry or zero valid rows is a full takedown for that game.
- Each game's rows are replaced through the database domain's transactional replace operation. Manifest or non-array payload failures retain the previously persisted cache; invalid individual rows are skipped before replacement. The manifest version is saved only after every scoped game succeeds.
- An unchanged manifest version skips scheduled work; forced refresh bypasses only that version check. Concurrent passes are suppressed.
- HTTP route registration remains in the routes domain. Runtime invokes the scheduler and persists sync state; database code owns transactional replacement. This domain coordinates those contracts without owning their storage or lifecycle infrastructure.

## Testing

Exercise both exported entry points with controlled manifest and payload responses. Cover unchanged and forced versions, missing games, relative and absolute payload paths, invalid rows and payloads, failed HTTP responses, transactional replacement failures, and overlapping sync requests. Assert database replacement calls, persisted version changes, returned counts, and retained-cache failure results.
