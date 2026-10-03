# Data scripts

Database and lap-file maintenance commands. Run from repository root; `DATA_DIR` selects database, settings, and captured-session storage. Commands can mutate or delete rows and files.

## Commands

| Command | Inputs / flags | Outputs / side effects |
| --- | --- | --- |
| `bun run apps/backend/scripts/data/seed-db.ts` | Optional `--games=fm-2023,f1-2025,acc,ac-evo,iracing,lmu` (or `--games <list>`) | Imports checked-in session fixtures, creates demo profile/tunes/experiments/analyses, marks onboarding complete, writes captured sessions under `DATA_DIR` |
| `bun run apps/backend/scripts/data/seed-db.ts --clean` | Optional `--games` | Deletes all database rows and referenced captured-session files, preserves schema migrations, then recreates seed data; destructive |
| `bun run apps/backend/scripts/data/seed-db.ts --reset` | Optional `--games`, `--force` | Deletes rows/files marked by seed marker, then recreates seed data; `--reset` is destructive |
| `bun run apps/backend/scripts/data/seed-db.ts --force` | Optional `--games` | Allows seeding database containing non-seed rows; use disposable `DATA_DIR` instead when possible |
| `bun run apps/backend/scripts/data/backfill-unknown-cars.ts` | AC Evo sessions with raw captures in `DATA_DIR` | Re-reads captures and updates unresolved car ordinals; skips unresolved/corrupt captures |
| `bun run apps/backend/scripts/data/export-laps.ts` | Optional `--ids 1,2,3`, `-o <zip>` | Writes lap archive ZIP; default `laps-export.zip` in current directory |
| `bun run apps/backend/scripts/data/import-laps.ts <zip>` | ZIP produced by export command | Replays archive sessions and reports imported/skipped laps |
| `bun run packages/tooling-data/src/data/extract-demo-lap.ts` | Lap `1337` in selected `DATA_DIR` | Writes `client/public/demo-lap.csv` |
| `bun run packages/tooling-data/src/data/reprocess-today-f1.ts` | Optional `SERVER` URL (default `http://localhost:3117`) | POSTs reprocess requests for today's F1 2025 sessions with raw captures |

Seed fixtures are listed explicitly in `seed-db-options.ts`, including LMU split recordings under `test/artifacts/laps/`. Seed initialization order remains explicit: `initDb()`, shared game adapters, server game adapters. Seed cleanup always stops telemetry maintenance and closes database client, including failures.

Playwright uses the same six-game seed list for local servers and CI artifact production. `playwright/support/server/prepare-seeded-database.ts` validates replayable captures and saved Analyse/Compare chat histories, then checkpoints both SQLite databases. Seed artifacts contain `app.db`, `chat-memory.db`, and `sessions/`; every seeded shard restores its own copies. Runtime settings and setup-home fixtures remain owned by the server launcher.

## Boundaries

These scripts own database imports, seed/reset behavior, lap archives, demo CSV extraction, and targeted maintenance. They do not own telemetry parser implementations, server API routes, checked-in fixtures, or external command callers.

## Focused verification

Use disposable storage for commands with database side effects:

```sh
DATA_DIR="$PWD/.data-script-check" bun run apps/backend/scripts/data/seed-db.ts --games=acc
DATA_DIR="$PWD/.data-script-check" bun run apps/backend/scripts/data/seed-db.ts --reset --games=acc
```

For archive checks, export known IDs to a temporary ZIP, then import into a different disposable `DATA_DIR` and compare command counts.
