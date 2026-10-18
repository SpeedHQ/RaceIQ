# Development

## Requirements

- [Bun](https://bun.sh)
- Windows for native ACC, AC Evo, and iRacing telemetry capture

## Install and run

Development retains its existing network listeners, including Vite and the configured Portless proxy mode. See [network access](../installation/network-access.md) for browser origin restrictions and optional passwords. UDP telemetry is unaffected.

```bash
bun install
cd client && bun install && cd ..
bun run dev
```

`bun run dev` shares one Portless proxy at `http://raceiq.localhost:1355` (main checkout). Linked Git worktrees get URLs of form `http://<branch>.raceiq-<worktree-id>.localhost:1355` (Portless prints exact URL); stable path-derived ID keeps even detached worktrees or branches with same short name distinct. Run `bun run dev` in each worktree concurrently. Backend HTTP ports are allocated per invocation; all dev servers listen for UDP telemetry on `5301` by default, matching Forza's default Data Out port. Vite also uses a Portless-assigned port. Each worktree stores development data in its own `./data` directory.

Standalone `bun run dev:server` defaults to HTTP/WebSocket port `3117`, Vite alone defaults to `5173`, and UDP telemetry defaults to persisted settings (`5301` initially). `bun run dev` overrides persisted UDP settings with port `5301`; set `RACEIQ_DEV_UDP_PORT` to override it. Multiple concurrent dev servers cannot all bind the same UDP port.

Set `SERVER_PORT` to override automatic backend port selection or `DATA_DIR` to override development data location. Use `bun run dev --onboarding false` to bypass onboarding without changing persisted settings.

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

Seed is idempotent. Seeded sessions retain live `source` metadata (`NULL`); seed ownership is tracked in notes for `--reset`. Stop the server before running `--clean`: it deletes the database, SQLite sidecars, and dashboard access marker, then recreates the schema and reseeds. This resets dashboard passwords, network settings, and login sessions; configure dashboard access again on startup. Other files in `DATA_DIR` remain intact. Use a disposable `DATA_DIR` because this is destructive. `--reset` replaces seeded rows only. Without `--force`, seed refuses to mix demo data into a database containing captured user data.

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
bun run test:all
```

Backend type checking uses `bun run --cwd apps/backend typecheck`. It forces a full composite check rather than trusting incremental state: TypeScript 7.0.2 produced a locationless TS2589 on incremental runs while fresh checks passed. No diagnostics are disabled.

## Effect scheduled work

Effect 4 is used by backend-core for scheduled recording maintenance and by backend tests for virtual-clock coverage. Dependencies are declared in the workspace: `effect` in `server` (runtime), `effect` in `apps/backend` (test-only `TestClock` usage), and root `@effect/tsgo` for compiler diagnostics. Install or refresh workspace dependencies with:

```bash
bun install
```

The workspace dependency commands used to introduce or update this setup are:

```bash
bun add --cwd server effect
bun add --cwd apps/backend --dev effect
bun add --dev @effect/tsgo
```

Review the resolved versions and lockfile when updating; examples must match the installed major version.

Installed versions: Effect 4.0.5, TypeScript 7.0.2, and `@effect/tsgo` 0.53.0. The inherited `tsconfig.base.json` plugin entry `{ "name": "@effect/language-service" }` is the plugin identifier consumed by `@effect/tsgo`; it is not the legacy language-service package.

Run both Effect diagnostics and the repository's native TypeScript checks:

```bash
bun run effect:check
bun run typecheck
```

The compiler patch integration was not retained: patched TypeScript 7 build mode produced TS2589. `effect:check` uses standalone `effect-tsgo diagnostics --project server/tsconfig.json`; native typecheck remains enabled. Root `postinstall` continues to run `lefthook install`.

Do not treat the old Effect language-service compiler patcher or the local v4-beta reference checkout as installed API authority. Check examples against dependencies resolved by this repository. Optional editor integration is documented in the [official tsgo guide](https://github.com/Effect-TS/tsgo); no editor-specific configuration is required here.

For scheduler ownership, retention ordering, and rewrite invariants, see [Scheduled recording maintenance](scheduled-recording-maintenance.md).

For telemetry captures and imports, see [Telemetry recordings](telemetry-recordings.md). For test-process leaks, see [Test troubleshooting](test-troubleshooting.md).
