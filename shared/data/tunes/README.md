# Tune data

Checked-in, generated setup and track-guide catalogs consumed as static application data.

## Layout

- `f1-25/<track>.json` records F1 25 track identity and ordinal data.
- `f1-25/f1laps/<track>/setups.json` stores F1Laps setup records; `_leaderboard.json` stores leaderboard snapshots.
- `f1-25/simracingsetup/<track>/setups.json` stores SimRacingSetup records; `_meta.json` stores guide, video, setup-tip, and driving-tip metadata.
- `f1-25/overtake/<track>/_meta.json` stores Overtake.gg track guides.
- Each F1 provider directory has `_source.json` provenance and `lastScraped` metadata.
- `acc/accsetups-com/<track>/<car>.json` stores ACC setup metadata grouped by track and car; `_source.json` records provider provenance.

## Source of truth and regeneration

The upstream provider pages named in each `_source.json` are the external sources. Checked-in JSON is the build-time application source of truth and must be regenerated through repository scripts rather than edited by hand:

- `bun run scripts/scrapers/scrape-f1-setups.ts` updates F1 track identity, setup, guide, and provider metadata.
- `bun run scripts/scrapers/scrape-f1-leaderboards.ts` updates F1Laps `_leaderboard.json` files and source timestamp.
- `bun run scripts/scrapers/scrape-acc-setups.ts` updates ACC setup files and `acc/accsetups-com/_source.json`.

Review and commit the complete generated diff, including `_source.json` timestamps and per-track metadata. A failed or partial scrape must not be treated as a catalog refresh.

## Runtime boundary and dependencies

This directory contains data only. It performs no browser or Node work. Scrapers are Bun/Node code under `scripts/`; consumers import explicit JSON leaf files so bundling does not depend on a working-directory layout. Server CDN community-tune synchronization is a separate database-backed flow and does not write this catalog.

When adding a provider or game, add its generator first, keep stable game/track/car slugs, record source provenance, then generate the full directory. Do not add a barrel or runtime loader under `shared/data/tunes`.
