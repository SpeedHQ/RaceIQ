# Contributing

RaceIQ welcomes code, documentation, game data, telemetry fixtures, setup data, and bug reports. Start with [project documentation](docs/README.md) and keep each change focused.

## Development setup

RaceIQ uses Bun, Hono, SQLite with Drizzle types, React, TanStack Router and Query, Zustand, Tailwind CSS, and shared Base UI/shadcn primitives.

```bash
bun install
cd client && bun install && cd ..
bun run dev
```

Default services:

- HTTP and WebSocket: `3117`
- UDP telemetry: `5301`
- Vite development client: `5173`
- Data directory: `./data`

See [development guide](docs/contributing/development.md) for environment variables, disposable database seeding, and schema changes.

## Contributor guides

- [Frontend development](docs/contributing/frontend.md)
- [Track curation](docs/contributing/track-curation.md)
- [Setup range data](docs/contributing/setup-range-data.md)
- [Telemetry recordings](docs/contributing/telemetry-recordings.md)
- [Test troubleshooting](docs/contributing/test-troubleshooting.md)
- [Architecture overview](docs/architecture/overview.md)

## Track and game data

`bun run extract:tracks` extracts Forza Motorsport and F1 25 track data. Game-specific commands cover other sources:

```bash
bun run extract:tracks:forza
bun run extract:tracks:f1
bun run extract:tracks:acc
bun run extract:tracks:ac-evo
bun run extract:ac-evo
```

Generated track geometry and metadata live under `shared/data/tracks/`; game registries live under `shared/games/`. Corner names, numbering, sectors, and segment geometry are hand-curated; read [track curation](docs/contributing/track-curation.md) before editing them. Curated data is authoritative and detector output is a fallback.

## Database changes

Drizzle schema definitions do not run production migrations. Update both `server/db/schema.ts` and the embedded migration list in `server/db/migrations.ts`. See [development guide](docs/contributing/development.md#database-changes).

## Change quality

- Follow existing architecture and naming conventions.
- Preserve game capability boundaries and avoid implicit `fm-2023` fallbacks.
- Keep shared frontend appearance in semantic component variants; keep feature composition in consumers.
- Add or update tests only for changed observable behavior.
- Add a concise entry under `## Unreleased` in `CHANGELOG.md` for each pull request.
