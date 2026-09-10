# Development

## Requirements

- [Bun](https://bun.sh)
- Windows for native ACC, AC Evo, and iRacing telemetry capture

## Install and run

```bash
bun install
cd client && bun install && cd ..
bun run dev
```

Default services:

- HTTP and WebSocket server: `http://localhost:3117`
- Vite development client: `http://localhost:5173`
- UDP telemetry listener: `5301`
- Development data: `./data`

Set `SERVER_PORT`, `UDP_PORT`, or `DATA_DIR` to override those defaults. Use `bun run dev --onboarding false` to bypass onboarding without changing persisted settings.

## Seed a disposable database

Populate `DATA_DIR` with representative committed telemetry and demo records:

```bash
bun run db:seed
```

Useful variants:

```bash
bun run db:seed --clean
bun run db:seed --reset
DATA_DIR=.data-dev bun run db:seed
DATA_DIR=.data-dev bun run db:seed --clean
bun run db:seed --games fm-2023,acc,ac-evo,iracing
bun run db:seed --force
```

Seed is idempotent. `--clean` deletes all database rows and referenced captured-session files, preserves schema migrations, then reseeds; use disposable `DATA_DIR` because it is destructive. `--reset` replaces seeded rows only. Without `--force`, seed refuses to mix demo data into a database containing captured user data.

## Database changes

`server/db/schema.ts` is the typed schema reference. Runtime migrations come from the embedded SQL list in `server/db/migrations.ts`.

1. Update `server/db/schema.ts`.
2. Append the next migration to `server/db/migrations.ts`.
3. Keep schema and migration behavior aligned.

`bun run db:push` and `bun run db:generate` are development/introspection tools; production startup uses the custom migration runner.

## Common commands

```bash
bun run dev:server
bun run dev:client
bun run build
bun run lint
bun run test
```

For telemetry captures and imports, see [Telemetry recordings](telemetry-recordings.md). For test-process leaks, see [Test troubleshooting](test-troubleshooting.md).