# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RaceIQ is a full-stack racing telemetry analysis app supporting multiple racing games (currently Forza Motorsport, F1 2025, and Assetto Corsa Competizione). It receives real-time UDP telemetry packets from games at 60 Hz, stores lap data in SQLite, and provides a React dashboard with live visualizations, lap comparison, AI-powered analysis, and 3D car attitude rendering.

## Commands

```bash
# Development (starts both server and client)
bun run dev

# Server only (Bun with --watch, port 3117)
bun run dev:server

# Client only (Vite with portless)
bun run dev:client

# Tests (Bun test runner)
bun test
bun test test/parser.test.ts   # single test file

# Database
bun run db:push       # sync Drizzle schema to SQLite (dev introspection only — see note below)
bun run db:generate   # generate Drizzle migration files (not used at runtime — see note below)

# Production build (client bundle + compiled server binary → dist/)
bun run build

# Run production build
bun run start

# Client-specific
cd client && bun run build   # production build (tsc + vite)
cd client && bun run lint    # ESLint

# Utility scripts
bun run extract:tracks       # extract track data from game files
bun run laps:export          # export lap data
bun run laps:import          # import lap data
bun run lighthouse           # run Lighthouse audit on local dev server
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_PORT` | `3117` | HTTP/WebSocket server port |
| `UDP_PORT` | `5300` | Game telemetry UDP listen port |
| `DATA_DIR` | `./data` | Database and settings directory |

## Architecture

### Three-layer monorepo: `server/`, `client/`, `shared/`

**Server (Bun + Hono)**
- `server/index.ts` — Entry point: Bun.serve with HTTP + WebSocket upgrade on port 3117
- `server/udp.ts` — UDP socket listening for game telemetry packets
- `server/parsers/` — Game-specific binary packet parsers (dispatched via game adapter registry)
- `server/games/` — Server game adapters (parser binding, AI prompts) — see [Adding a New Game](#adding-a-new-game)
- `server/routes.ts` — Hono app composition; individual route files live in `server/routes/` (laps, sessions, settings, cars, tracks, tunes, ACC, F1 2025, misc)
- `server/ws.ts` — WebSocket manager, broadcasts parsed packets to all connected clients
- `server/lap-detector.ts` — Detects lap boundaries from telemetry stream
- `server/corner-detection.ts` — Identifies racing corners from telemetry data (game-aware steering)
- `server/ai/analyst-prompt.ts` — Builds prompts for Claude API lap analysis
- `server/db/schema.ts` — Drizzle ORM schema (profiles, sessions, laps, corners, lapAnalyses, trackOutlines)
- `server/db/queries.ts` — Database query helpers
- `server/db/migrations.ts` — Hand-rolled migration list (SQL array, version-tracked)
- `server/db/index.ts` — Runs migrations on startup via custom runner

### Database migration approach

Drizzle is used **only as a query builder and type-safe schema reference** — NOT for runtime migrations. Schema changes are managed via a hand-rolled migration system in `server/db/migrations.ts`. The app compiles to a self-contained Windows binary (`raceiq.exe`); Drizzle's `migrate()` reads SQL files from disk at runtime, which would break single-binary distribution. The custom system embeds all migration SQL directly in the compiled binary.

**To add a schema change:**
1. Edit `server/db/schema.ts` (keeps Drizzle types in sync)
2. Add a new entry at the bottom of `server/db/migrations.ts` with the next version number and the raw SQL
3. Do NOT use `bun run db:push` to apply schema changes — it is for dev introspection only and must never drop `schema_migrations` (protected via `tablesFilter` in `drizzle.config.ts`)
- `server/pipeline.ts` — Telemetry processing pipeline (parse → broadcast → lap detect)
- `server/sector-tracker.ts` — Server-side sector timing tracker
- `server/tray.ts` — System tray integration (Windows)
- `server/update-check.ts` — Auto-update checker

**Client (React 19 + Vite + TanStack Router)**
- `client/src/main.tsx` — App entry point
- `client/src/routes/__root.tsx` — Root layout with TanStack Router
- `client/src/routeTree.gen.ts` — Auto-generated route tree (do not edit manually)
- `client/src/stores/telemetry.ts` — Zustand store for WebSocket connection state, current packet, packets/sec
- `client/src/stores/game.ts` — Zustand store for active game context (gameId → route mapping)
- Key components:
  - `LiveTelemetry.tsx` — Real-time telemetry dashboard
  - `LapAnalyse.tsx` — Lap analysis with corner data
  - `LapComparison.tsx` — Side-by-side lap comparison
  - `TrackMap.tsx` — Track visualization
  - `TelemetryChart.tsx` — Data charting (uplot)
  - `BodyAttitude.tsx` — 3D car orientation (Three.js / React Three Fiber)
  - `AiAnalysisModal.tsx` — AI-powered analysis via Claude API
  - `Settings.tsx` — App settings modal (UDP port, units)
  - `TuneCatalog.tsx` — Vehicle setup tuning

**Shared (`shared/`)**
- `shared/types.ts` — Telemetry packet types, enums, shared interfaces
- `shared/games/` — Game adapter registry and per-game adapters — see [Adding a New Game](#adding-a-new-game)
- `shared/car-data.ts` — Car model ID-to-name mapping (dispatches via game adapter)
- `shared/track-outlines/` — Track geometry data (JSON coords, sector definitions, named segments)
- `shared/tunes/` — Vehicle setup data (JSON)

### Data Flow

1. Game sends UDP packets → `server/udp.ts` receives and buffers
2. `server/parsers/index.ts` auto-detects game via `canHandle()`, decodes binary → typed telemetry object
3. `server/lap-detector.ts` tracks lap boundaries, saves completed laps to SQLite
4. `server/ws.ts` broadcasts live packet to all WebSocket clients
5. Client `telemetry.ts` Zustand store receives via WebSocket → React components re-render
6. Historical data fetched via REST API (`/api/laps`, `/api/sessions`, etc.)

### Key Conventions

- Path aliases: `@shared/*` → `./shared/*` (server/test), `@/*` → `./src/*` (client only)
- Client proxies `/api` and `/ws` requests to `localhost:3117` via Vite dev server config
- **API calls use Hono RPC**: import `client` from `@/lib/rpc.ts` (typed against `AppType` from `server/routes.ts`) — do not use raw `fetch` for API routes
- Database file: `data/forza-telemetry.db` (SQLite)
- Settings persisted to: `data/settings.json`
- UI components use shadcn (in `client/src/components/ui/`) with Tailwind CSS v4
- Client uses TanStack React Query for server state management
- 3D visualizations use React Three Fiber (Three.js wrapper for React)

### Custom Steering Wheels

The steering wheel displayed during live telemetry is file-driven. To add a custom wheel:

1. Place an image in `client/public/wheels/`
2. Supported formats: `.svg`, `.webp`, `.png`, `.jpg`
3. The filename (minus extension) becomes the display name

Example: `client/public/wheels/Logitech G Pro.png` → shows as "Logitech G Pro"

The wheel picker in Settings and Setup Wizard automatically discovers all images in that directory.

### Tech Stack Summary

| Layer | Technology |
|-------|-----------|
| Runtime | Bun |
| Server framework | Hono |
| Database | SQLite + Drizzle ORM |
| Frontend | React 19, Vite 8, TypeScript 6 |
| Routing | TanStack Router (file-based, auto-generated) |
| State | Zustand (client), TanStack Query (server state) |
| Styling | Tailwind CSS v4 + shadcn |
| Charts | uplot |
| 3D | Three.js + React Three Fiber |
| AI | Claude API (lap analysis) |

### Game Adapter System

The app uses a registry-based adapter pattern to support multiple racing games. Each game provides a `GameAdapter` (shared) and `ServerGameAdapter` (server-only) that encapsulate all game-specific behavior.

**Shared adapter** (`shared/games/types.ts` — `GameAdapter`):
- Identity: `id`, `displayName`, `shortName`, `routePrefix`
- Car/track resolution: `getCarName()`, `getTrackName()`, `getSharedTrackName()`
- Steering config: `steeringCenter`, `steeringRange` (used by corner detection)
- Coordinate system: `coordSystem` (used by track maps)
- Optional metadata: `carClassNames`, `drivetrainNames`

**Server adapter** (`server/games/types.ts` — `ServerGameAdapter`):
- Packet detection: `canHandle(buf)` — quick check if a UDP buffer belongs to this game
- Parsing: `tryParse(buf, state)` — parse buffer into `TelemetryPacket`
- Parser state: `createParserState()` — e.g. F1's multi-packet accumulator (null if stateless)
- AI analysis: `aiSystemPrompt`, `buildAiContext(packets)`

**Registries:**
- `shared/games/registry.ts` — `registerGame()`, `getGame()`, `tryGetGame()`, `getAllGames()`
- `server/games/registry.ts` — `registerServerGame()`, `getServerGame()`, `getAllServerGames()`

**Current adapters:**
- `shared/games/fm-2023/` + `server/games/fm-2023/` — Forza Motorsport 2023 (stateless parser, size-based packet detection)
- `shared/games/f1-2025/` + `server/games/f1-2025/` — F1 2025 (stateful multi-packet accumulator, magic bytes detection)
- `shared/games/acc/` + `server/games/acc/` — Assetto Corsa Competizione (shared memory reader on Windows)

### Adding a New Game

To add support for a new racing game (e.g. Gran Turismo):

1. **Add game ID** — Add `"gt7"` to `KNOWN_GAME_IDS` in `shared/types.ts`
2. **Create shared adapter** — `shared/games/gt7/index.ts` implementing `GameAdapter` (identity, car/track resolution, steering config, coord system)
3. **Create server adapter** — `server/games/gt7/index.ts` implementing `ServerGameAdapter` (`canHandle()`, `tryParse()`, `createParserState()`, AI prompts)
4. **Create UDP parser** — `server/parsers/gt7.ts` with binary parsing logic
5. **Register adapters** — Import and call `registerGame()` in `shared/games/init.ts`, `registerServerGame()` in `server/games/init.ts`
6. **Create client routes** — `client/src/routes/gt7.tsx` (layout with `<GameProvider gameId="gt7">`) and sub-routes in `client/src/routes/gt7/`
7. **Add game data** — Car/track CSVs in `shared/`, track outlines in `shared/track-outlines/gt7/`

See existing adapters (`fm-2023`, `f1-2025`, `acc`) for reference. Everything else (navigation tabs, car/track name resolution, corner detection, AI prompts, parser dispatch) is handled automatically by the registry.

### Testing

Tests live in `test/` and use Bun's native test runner (`bun:test` with `describe`/`test`/`expect`). Tests that involve packet parsing must initialize game adapters first:

```typescript
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";

initGameAdapters();
initServerGameAdapters();
```

### CI/CD

- **PR/main**: GitHub Actions runs `bun test` and client build (`.github/workflows/build-test.yml`)
- **Release tags**: Windows x64 binary compilation via `.github/workflows/release.yml` — Bun compiles server to `raceiq.exe`, bundles with Vite client output into `raceiq-windows-x64.zip`

