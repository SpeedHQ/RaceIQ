# Community Tunes

RaceIQ synchronizes community-published Forza Motorsport tunes from a static CDN and merges them with the built-in catalog.

## Publisher contract

RaceIQ consumes two HTTP resources from the configured base URL:

- `GET /manifest.json`
- `GET /fm-2023/tunes.json`

The manifest provides a content `version`, generation time, and game entries containing count and payload path. The payload contains RaceIQ-ready catalog tune records for game ID `fm-2023`, with stable community IDs, source metadata, author information, and normalized settings. The version changes only when payload content changes.

Publisher conversion and validation happen before deployment. RaceIQ does not scrape or reinterpret publisher source data.

## Consumer behavior

`server/tunes/community-sync.ts` performs synchronization:

1. Fetch the manifest.
2. Compare its version with stored sync state.
3. Fetch and validate the game payload when content changed.
4. Replace that game's `community_tunes` rows transactionally.
5. Store the new manifest version and sync time only after success.

Synchronization runs at server startup, on its configured interval, and when a manual refresh is requested. Catalog queries merge database rows with built-in tunes for the game selected through `X-Game-Id`.

## Failure contract

The local cache does not expire. Network, manifest, payload, or validation failures preserve the previously synchronized rows. A valid zero-row payload is treated as an intentional removal. Invalid individual records are reported according to current sync validation behavior; the active cache is never partially replaced.

## Configuration

`COMMUNITY_TUNES_URL` overrides the CDN base URL. The endpoint must expose the contract above and should use immutable content deployment with a content-derived manifest version.

## Ownership

Publisher maintainers own source collection, conversion, validation, and deployment. RaceIQ owns manifest consumption, persistence, refresh behavior, and catalog presentation. Changes to payload shape or identity rules require coordinated updates on both sides.

See `server/tunes/community-sync.ts`, `server/db/community-tune-queries.ts`, and `test/community-tunes-sync.test.ts` for current implementation details.
