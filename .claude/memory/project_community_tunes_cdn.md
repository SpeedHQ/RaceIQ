---
name: community-tunes-cdn
description: Community tunes synced from SpeedHQ Cloudflare Pages CDN into RaceIQ FM catalog
type: project
---

Community-tunes consumer (branch `feat/community-tunes-cdn`, spec `docs/integrations/community-tunes.md`).

- DB: `community_tunes` table (migration v20 in `server/db/migrations.ts`, Drizzle model `communityTunes` in `server/db/schema.ts`). Columns: id PK, game_id, car_ordinal, track_ordinal?, name, author, category, description, source_name, settings(JSON text), synced_at. strengths/weaknesses NOT persisted — community cards render empty for those.
- Sync: `server/community-tunes-sync.ts` `syncCommunityTunes()` — fetch `${COMMUNITY_TUNES_URL ?? "https://speedhq-tunes.pages.dev"}/manifest.json`, skip if version == stored (settings `communityTunesVersion`), else fetch tunes.json, zod-validate (skip invalid), transactional replace-all via `replaceCommunityTunes()` in `server/db/community-tune-queries.ts`. Failure keeps cache. `startCommunityTunesSync()` wired in `server/index.ts` (startup + 6h interval).
- Sync state stored in settings.json via `getCommunityTunesSyncState`/`setCommunityTunesSyncState` in `server/settings.ts`.
- Routes (`server/routes/tune-routes.ts`): GET /api/catalog/tunes merges TUNE_CATALOG + community rows for `X-Game-Id` header (no fm-2023 fallback). POST /api/tunes/community/refresh → {synced,count,version}. Clone handler resolves `community-*` ids from DB.
- Client: `useCatalogTunes` sends X-Game-Id header; `useRefreshCommunityTunes`. CatalogTune gains source?/sourceName?/gameId?. CatalogTuneCard shows purple sourceName badge + byline. TuneCatalog has All/Built-in/Community source filter + Refresh button.
- Tests: `test/community-tunes-sync.test.ts` (mocked fetch: skip/replace-all/invalid-skip/failure-keeps-cache).
