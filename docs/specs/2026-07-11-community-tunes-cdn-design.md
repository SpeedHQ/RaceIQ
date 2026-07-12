# Community Tunes via CDN — Design

**Date:** 2026-07-11
**Repos:** tune publisher (internal tooling), SpeedHQ/RaceIQ (consumer)
**Status:** Approved design, pending implementation

## Goal

Community-shared Forza Motorsport tunes appear in RaceIQ's FM tune catalog automatically — no RaceIQ release needed when new tunes are posted.

## Decisions (from brainstorm)

| Decision | Choice |
|---|---|
| Delivery | Runtime fetch by RaceIQ **server**, persistent non-expiring cache |
| Hosting | **Cloudflare Pages** (classic Pages, NOT Workers static assets) — free static hosting, deployed with `wrangler pages deploy` |
| Conversion ownership | **Scraper repo** publishes RaceIQ-ready `CatalogTune` JSON |
| Server storage | New `communityTunes` SQLite table (replace-all on sync) |
| Refresh | Startup + every **6 h** + manual refresh button (UI) |
| Curation | Auto-publish: zero extraction warnings + numeric range validation; no manual gate |
| UI | Merged into existing catalog list with source badge + author byline + source filter |
| Process | RaceIQ changes on `feat/community-tunes-cdn` branch → PR. Scraper repo direct to main |

## Architecture

```
community sources ──hourly──▶ scraper (extract + map ordinals)
                       │ output/tunes.json (committed)
                       ▼
                 publish-cdn.ts (convert → validate → hash)
                       │ only when content hash changes
                       ▼
              wrangler pages deploy dist/
                       │
        https://<project>.pages.dev/manifest.json
        https://<project>.pages.dev/fm-2023/tunes.json
                       │
                       ▼
   RaceIQ server sync (startup + 6h + POST refresh)
     manifest.version != stored version → download,
     zod-validate, transactional replace-all into
     communityTunes table; any failure keeps cache
                       │
                       ▼
   /api/tunes catalog endpoint merges built-in JSON
   tunes + communityTunes rows
                       │
                       ▼
   Catalog UI: badge "Community", by-author line,
   source filter toggle, refresh button
```

## Publisher (scraper repo)

Publisher design lives in the scraper repo:
the internal publisher repo → `docs/superpowers/specs/2026-07-11-cdn-publisher-design.md`.

Contract RaceIQ depends on:
- `GET <base>/manifest.json` → `{ version, generatedAt, games: { "fm-2023": { count, path } } }`
- `GET <base>/fm-2023/tunes.json` → `CatalogTune[]` already in RaceIQ shape (`id: community-<messageId>`, `source: "community"`, `sourceName: "Community"`, `gameId: "fm-2023"`, `settings` with `null` for min/max/pref wildcards)
- Hosted on **Cloudflare Pages** (classic Pages, not Workers static assets)
- `version` changes iff content changes (sha256 of tunes.json)

## Consumer (RaceIQ)

### DB (follow migrations.ts convention — hand-rolled SQL, new version entry; schema.ts updated in lockstep)

- `community_tunes`: `id TEXT PK`, `game_id TEXT NOT NULL`, `car_ordinal INTEGER NOT NULL`, `track_ordinal INTEGER`, `name TEXT`, `author TEXT`, `category TEXT`, `description TEXT`, `source_name TEXT`, `settings TEXT (JSON)`, `synced_at TEXT`.
- Manifest version + last sync time stored in existing settings store (`data/settings.json`) — no extra table.

### Sync (`server/community-tunes-sync.ts`)

- `syncCommunityTunes()`: GET manifest → compare `version` with stored → if changed GET tunes.json → zod-validate each row (skip invalid rows, log count) → `BEGIN; DELETE FROM community_tunes WHERE game_id='fm-2023'; INSERT …; COMMIT` → store new version.
- Called: on server startup (non-blocking), `setInterval` 6 h, and `POST /api/tunes/community/refresh` (returns `{synced, count, version}`).
- Network/validation failure → log, keep existing rows (persistent cache; never expires).
- CDN base URL configurable via env (`COMMUNITY_TUNES_URL`), default the Pages domain.

### Routes

- Extend the tune-routes catalog composition: catalog list = static built-in JSON tunes + `SELECT * FROM community_tunes WHERE game_id = <X-Game-Id>`. gameId comes from the `X-Game-Id` header per repo convention (no fm-2023 fallback).
- Clone-to-my-tunes: accept community ids; source row read from DB.

### Client

- Catalog page reads community tunes through the API (built-ins may stay as bundled imports for offline-first render; community list arrives with the query).
- `CatalogTuneCard`: purple `sourceName` badge + "by {author}" byline (as prototyped).
- Source filter toggle (All / Built-in / Community) beside category filters.
- Refresh button → `POST /api/tunes/community/refresh`, invalidates the catalog query.

## Error handling

- CDN unreachable at startup → app runs on last-synced rows; no user-facing error, log only.
- Manifest fetch OK but tunes.json invalid → abort sync, keep old rows, log validation failures.
- Zero-row payload with valid manifest → treated as valid (explicit takedown of everything) but logged loudly.

## Testing

- Publisher: unit tests for filter + conversion (wildcards, track/category mapping, hash stability).
- RaceIQ: sync module tested with mocked fetch (version-unchanged skip, replace-all, failure-keeps-cache); route test that catalog merges DB rows; migration runs on fresh DB.

## Out of scope (later)

- ACC/LMU laptime + BOP datasets (ohne-speed) — separate feature.
- Wheel-settings records.
- User ratings / hiding individual community tunes.
- Author takedown blocklist (revisit if a request arrives).
