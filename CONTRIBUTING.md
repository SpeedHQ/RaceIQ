# Contributing

RaceIQ welcomes code, documentation, game data, telemetry fixtures, setup data, and bug reports. Start with [project documentation](docs/README.md) and keep each change focused.

## Development setup

RaceIQ uses Bun, Hono, SQLite with Drizzle types, React, TanStack Router and Query, Zustand, Tailwind CSS, and shared Base UI/shadcn primitives.

```bash
bun install
cd client && bun install && cd ..
bun run dev
```

`bun run dev` serves main checkout at `http://raceiq.localhost:1355`; linked worktrees get branch-prefixed Portless URLs. UDP telemetry listens on Forza's default port `5301` (override with `RACEIQ_DEV_UDP_PORT`); multiple concurrent dev servers cannot share that UDP port. Development data stays in each worktree's `./data`.

See [development guide](docs/contributing/development.md) for environment variables, disposable database seeding, and schema changes.

## Contributor guides

- [Frontend development](docs/contributing/frontend.md)
- [Track curation](docs/contributing/track-curation.md)
- [Setup range data](docs/contributing/setup-range-data.md)
- [Telemetry recordings](docs/contributing/telemetry-recordings.md)
- [Test troubleshooting](docs/contributing/test-troubleshooting.md)
- [Architecture overview](docs/architecture/overview.md)

## Track data

Checked-in game catalogs and track geometry live under `shared/games/` and `shared/data/tracks/`. Preserve those assets and curate track metadata with [track curation](docs/contributing/track-curation.md); track segments and coverage tooling remain available through `tracks:segments` and `tracks:coverage`.

## Database changes

Drizzle schema definitions do not run production migrations. Update both `server/db/schema.ts` and the embedded migration list in `server/db/migrations.ts`. See [development guide](docs/contributing/development.md#database-changes).

## Change quality

- Follow existing architecture and naming conventions.
- Preserve game capability boundaries and avoid implicit `fm-2023` fallbacks.
- Keep shared frontend appearance in semantic component variants; keep feature composition in consumers.
- Add or update tests only for changed observable behavior.
- Add a concise entry under `## Unreleased` in `CHANGELOG.md` for each pull request.
