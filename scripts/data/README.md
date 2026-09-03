# Data scripts

Database and lap-file maintenance commands. Run from repository root; `DATA_DIR` selects database, settings, and captured-session storage. Commands can mutate or delete rows and files.

## Commands

| Command | Inputs / flags | Outputs / side effects |
| --- | --- | --- |
| `bun run scripts/data/seed-db.ts` | Optional `--games=fm-2023,f1-2025,acc,ac-evo,iracing` (or `--games <list>`) | Imports checked-in session fixtures, creates demo profile/tunes/experiments/analyses, marks onboarding complete, writes captured sessions under `DATA_DIR` |
| `bun run scripts/data/seed-db.ts --clean` | Optional `--games` | Deletes the database file, SQLite sidecars, and referenced captured-session files, then creates a fresh database and reseeds; destructive |
| `bun run scripts/data/seed-db.ts --reset` | Optional `--games`, `--force` | Deletes rows/files marked by seed marker, then recreates seed data; `--reset` is destructive |
| `bun run scripts/data/seed-db.ts --force` | Optional `--games` | Allows seeding database containing non-seed rows; use disposable `DATA_DIR` instead when possible |
| `bun run scripts/data/backfill-unknown-cars.ts` | AC Evo sessions with raw captures in `DATA_DIR` | Re-reads captures and updates unresolved car ordinals; skips unresolved/corrupt captures |
| `bun run scripts/data/export-laps.ts` | Optional `--ids 1,2,3`, `-o <zip>` | Writes lap archive ZIP; default `laps-export.zip` in current directory |
| `bun run scripts/data/import-laps.ts <zip>` | ZIP produced by export command | Replays archive sessions and reports imported/skipped laps |
| `bun run scripts/data/extract-demo-lap.ts` | Lap `1337` in selected `DATA_DIR` | Writes `client/public/demo-lap.csv` |
| `bun run scripts/data/reprocess-today-f1.ts` | Optional `SERVER` URL (default `http://localhost:3117`) | POSTs reprocess requests for today's F1 2025 sessions with raw captures |

Seed fixtures are read from `test/artifacts/sessions/`. Seed initialization order remains explicit: `initDb()`, shared game adapters, server game adapters. Seed cleanup always stops telemetry maintenance and closes database client, including failures.

## Boundaries

These scripts own database imports, seed/reset behavior, lap archives, demo CSV extraction, and targeted maintenance. They do not own telemetry parser implementations, server API routes, checked-in fixtures, or external command callers.

## Focused verification

Use disposable storage for commands with database side effects:

```sh
DATA_DIR="$PWD/.data-script-check" bun run scripts/data/seed-db.ts --games=acc
DATA_DIR="$PWD/.data-script-check" bun run scripts/data/seed-db.ts --reset --games=acc
```

For archive checks, export known IDs to a temporary ZIP, then import into a different disposable `DATA_DIR` and compare command counts.
