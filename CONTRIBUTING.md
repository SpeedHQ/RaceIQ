# Contributing

RaceIQ welcomes code, documentation, game data, telemetry fixtures, setup data, and bug reports. Start with [project documentation](docs/README.md) and keep each change focused.

## Development setup

RaceIQ uses Bun, Hono, SQLite with Drizzle types, React, TanStack Router and Query, Zustand, Tailwind CSS, and shared Base UI/shadcn primitives.

```bash
bun install
cd client && bun install && cd ..
bun run db:seed
bun run dev
```

`bun run dev` serves main checkout at `http://raceiq.localhost:1355`; linked worktrees get branch-prefixed Portless URLs. UDP telemetry listens on Forza's default port `5301` (override with `RACEIQ_DEV_UDP_PORT`); multiple concurrent dev servers cannot share that UDP port. Development data stays in each worktree's `./data`.

Recommended: run `bun run db:seed` before starting development to import committed test recordings and demo records into the local development database. This gives you sessions and laps to explore without capturing or supplying your own recordings. The default development database lives in the worktree's `./data`, separate from your production installation; seeding it does not affect production data. Keep any `DATA_DIR` override pointed at development storage. Seed is idempotent; `--clean` deletes and reseeds only the selected database and its referenced capture files, so it removes any local development recordings there.

See [development guide](docs/contributing/development.md) for environment variables, disposable database seeding, and schema changes.

## Coding agent harness

We recommend OMP as the harness for AI-assisted contributions. If you use a different harness, explicitly instruct your coding agent to read and follow all repository rules in [`.omp/rules/`](.omp/rules/) before researching or changing code.

Suggested instruction:

```text
Before starting work, read and follow all rules in .omp/rules/.
```

## Contributor guides

- [Frontend development](docs/contributing/frontend.md)
- [Track curation](docs/contributing/track-curation.md)
- [Setup range data](docs/contributing/setup-range-data.md)
- [Telemetry recordings](docs/contributing/telemetry-recordings.md)
- [Adding new game support](docs/contributing/adding-new-game-support.md)
- [Test troubleshooting](docs/contributing/test-troubleshooting.md)
- [Architecture overview](docs/architecture/overview.md)

## Track and game data


Generated track geometry and metadata live under `shared/data/tracks/`; game registries live under `shared/games/`. Corner names, numbering, sectors, and segment geometry are hand-curated; read [track curation](docs/contributing/track-curation.md) before editing them. Curated data is authoritative and detector output is a fallback.

## Database changes

Drizzle schema definitions do not run production migrations. Update both `server/db/schema.ts` and the embedded migration list in `server/db/migrations.ts`. See [development guide](docs/contributing/development.md#database-changes).

## Change quality

- Follow existing architecture and naming conventions.
- Preserve game capability boundaries and avoid implicit `fm-2023` fallbacks.
- Keep shared frontend appearance in semantic component variants; keep feature composition in consumers.
- Back new or changed user-facing UI text with locale messages, including labels, tooltips, errors, empty states, and accessibility text; do not hard-code display strings. Update all supported locale catalogs, preserve interpolation/pluralization, and verify `bun run i18n:check-keys` and `bun run i18n:validate`.
- Add or update tests only for changed observable behavior.
- Add a concise entry under `## Unreleased` in `CHANGELOG.md` for each pull request.
- Complete the [PR checklist](.github/pull_request_template.md), including manual validation of the affected behavior.
