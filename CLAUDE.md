# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RaceIQ is a full-stack racing telemetry analysis app for Forza Motorsport 2023, F1 25, Assetto Corsa Competizione, Assetto Corsa Evo, and iRacing. UDP and native Windows telemetry sources feed a Bun server, SQLite storage, and a React dashboard. See [architecture overview](docs/architecture/overview.md).

## Commands

```bash
# Development (starts both server and client)
bun run dev

# Server only (Bun with --watch, port 3117)
bun run dev:server

# Client only (Vite with portless)
bun run dev:client

# Tests (Bun test runner)
bun run test                        # use bun run test, not bun test (sets --timeout 60000)
bun test --timeout 60000 test/parser.test.ts   # single test file

# Database
bun run db:seed              # populate DATA_DIR with committed real-lap demo data
bun run db:seed --reset      # remove only seeded rows and regenerate demo data
bun run db:seed --games fm-2023,acc,ac-evo,iracing
bun run db:seed --force      # explicitly allow seeding alongside existing user data
bun run db:push       # sync Drizzle schema to SQLite (dev introspection only — see note below)
bun run db:generate   # generate Drizzle migration files (not used at runtime — see note below)

# Production build (client bundle + compiled server binary → dist/)
bun run build

# Run production build
bun run start

# Build Windows installer
bun run build:installer

# Client-specific
cd client && bun run build   # production build (tsc + vite)
cd client && bun run lint    # ESLint

# Dump mode (develop without a running game — captures raw packets)
bun run dev:dump:fm            # dump Forza Motorsport packets
bun run dev:dump:f1            # dump F1 2025 packets
bun run dev:dump:acc           # dump ACC packets

# AI development (Mastra agent playground)
bun run mastra:studio          # Studio UI (localhost:3000) reading the running dev server's in-process Mastra API (:3117)

# Utility scripts
bun run extract:tracks         # extract track data from game files
bun run laps:export            # export lap data
bun run laps:import            # import lap data
bun run lighthouse             # run Lighthouse audit on local dev server
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_PORT` | `3117` | HTTP/WebSocket server port |
| `UDP_PORT` | `5301` | Game telemetry UDP listen port |
| `DATA_DIR` | `./data` | Database and settings directory |

## Architecture

### Three-layer monorepo: `server/`, `client/`, `shared/`

**Server (Bun + Hono)**
- `server/index.ts` — Thin executable entry; `server/runtime/boot.ts` owns ordered startup
- `server/runtime/udp-listener.ts` — UDP socket listening for game telemetry packets
- `server/games/` — Game-owned parsers/adapters plus generic packet dispatch — see [Adding a New Game](#adding-a-new-game)
- `server/routes/index.ts` — Hono app composition; bounded route groups live in `server/routes/`
- `server/runtime/websocket-manager.ts` — WebSocket manager, 30Hz throttled broadcast to all connected clients
- `server/telemetry/live-pipeline.ts` — Telemetry processing pipeline (normalize → suspension fill → lap detect → sector track → pit track → track calibration → broadcast)
- `server/lap-detection/detector.ts` — Detects lap boundaries from telemetry stream (per-game factory via adapter)
- `server/live-strategy/` — Live sector timing and pit/fuel/tire estimates
- `server/lap-analysis/corners.ts` — Game-aware racing-corner identification
- `server/ai/` — AI analysis system (see [AI Analysis System](#ai-analysis-system))
- `server/db/schema.ts` — Drizzle ORM schema (profiles, sessions, laps, corners, lapAnalyses, compareAnalyses, trackOutlines)
- `server/db/*-queries.ts` — Responsibility-scoped database query modules
- `server/db/migrations.ts` — Hand-rolled migration list (SQL array, version-tracked)
- `server/db/index.ts` — Runs migrations on startup via custom runner
- `server/runtime/platform/tray.ts` — System tray integration (Windows)
- `server/runtime/update/check.ts` — Auto-update checker

### Database migration approach

Drizzle is used **only as a query builder and type-safe schema reference** — NOT for runtime migrations. Schema changes are managed via a hand-rolled migration system in `server/db/migrations.ts`. The app compiles to a self-contained Windows binary (`raceiq.exe`); Drizzle's `migrate()` reads SQL files from disk at runtime, which would break single-binary distribution. The custom system embeds all migration SQL directly in the compiled binary.

**To add a schema change:**
1. Edit `server/db/schema.ts` (keeps Drizzle types in sync)
2. Add a new entry at the bottom of `server/db/migrations.ts` with the next version number and the raw SQL
3. Do NOT use `bun run db:push` to apply schema changes — it is for dev introspection only and must never drop `schema_migrations` (protected via `tablesFilter` in `drizzle.config.ts`)

### Pipeline dependency injection

The pipeline uses `DbAdapter` and `WsAdapter` interfaces for testability:
- Production: `RealDbAdapter` (SQLite), plus a module-level `WsAdapter` delegating to `wsManager`
- Tests: `NullDbAdapter`/`NullWsAdapter` (no-op) or `CapturingDbAdapter`/`CapturingWsAdapter` (record calls)

### AI Analysis System

The AI system uses Mastra agents backed by Claude API with streaming and prompt caching.

**Agents** (`server/ai/agents.ts`):
- Lap Analyst — single-lap breakdown with corner-by-corner analysis
- Compare Engineer — head-to-head lap comparison (inputs-focused)
- Chat Agent — interactive Q&A about laps and comparisons
- Race Engineer (`mastra/agents/setup-engineer.ts`, id `setup-engineer`) — owns the CAR in an experiment; the only agent with `apply_changes`
- Driver Coach (`mastra/agents/driver-coach.ts`, id `driver-coach`) — owns the DRIVER; the only agent with `record_drill`

The experiment chat picks between the last two by `experiments.focus` via
`sessionAgentForFocus()` — a switch over a column the driver set, not a
coordinator agent inferring a route. Both share one session thread
(`tune-session-<id>`) so switching focus mid-conversation keeps its history,
and neither can do the other's job because the tool is simply not on it.
There is deliberately no agent-to-agent consult: handover is the driver
flipping focus. See [Experiment focus](#experiment-focus).

**Prompt files** (`server/ai/`): `analyst-prompt.ts`, `chat-prompt.ts`, `compare-engineer.ts`, `compare-chat-prompt.ts`, `inputs-compare-prompt.ts`, `corner-data.ts`, `format-tune.ts`

**Mastra directory** (`mastra/`): Agent definitions + the `mastra` instance (LibSQL default store + DuckDB observability). In dev it is mounted **in-process** onto the RaceIQ Hono app under `/studio-api` (see `server/runtime/dev-studio.ts`), so the server is the sole DuckDB writer and `bun run mastra:studio` reads its real traces over HTTP — no second `mastra dev` process, no DuckDB file lock. Excluded from the prod binary via `NODE_ENV` gating.

### Experiment focus

An experiment has a **focus** — what it is currently varying — and the driver
switches it mid-session from the workspace header (fix the balance, then work
on braking, same experiment).

| Level | Column / field | Values | Mutable? |
|-------|----------------|--------|----------|
| Experiment mode | `experiments.focus` | `car` \| `driver` | **Yes** — switchable any time |
| Arm | `experiment_versions.kind` | `setup` \| `drill` | No — fixed at creation |
| One change inside an arm | `TestChange.kind` (`shared/types.ts`) | `setup` \| `drill` | No |

⚠️ **The three levels deliberately do NOT share a vocabulary.** An earlier cut
named the mode `setup`/`driving`, which made "setup" mean a mode, an arm AND a
knob edit at once, while its opposite was "driving" at one level and "drill" at
the others. Keep the mode as `car`/`driver`. Source of truth for the mapping:
`shared/experiment-focus.ts` (`versionKindForFocus`, `focusForVersionKind`,
`headlineMetricForVersionKind`).

**Focus decides the NEXT arm; it never rewrites arms already recorded.**
Switching to `driver` does not turn v1–v3 into drills — that split is what lets
a mixed experiment be reviewed honestly, since each arm is judged on its own
metric (setup arm → best lap, drill → lap-time spread; a drill's win condition
can be a tighter spread at an unchanged best lap).

**Focus ledger** — every switch is appended to `experiment_focus_events`
(append-only; a no-op re-select writes nothing) with `from_version_id`, the head
at the moment of the switch, so the version tree can mark where each era began.
Surfaced by `FocusTimeline` (in the History panel) and an era badge in
`VersionGraph`.

Migrations: **v39** adds the column + ledger, **v40** normalises databases that
ran v39 before the `car`/`driver` rename.

**Caching**: Analysis results cached in DB (`lapAnalyses` for single laps, `compareAnalyses` for lap pairs with a `kind` discriminator).

**Client (React 19 + Vite + TanStack Router)**
- `client/src/main.tsx` — App entry point
- `client/src/routes/__root.tsx` — Root layout with TanStack Router
- `client/src/routeTree.gen.ts` — Auto-generated route tree (do not edit manually)
- `client/src/stores/telemetry.ts` — Zustand store for WebSocket connection state, current packet, packets/sec, live history arrays
- `client/src/stores/game.ts` — Zustand store for active game context (gameId → route mapping)
- `client/src/stores/ui.ts` — Zustand store for UI state (settings modal, onboarding)
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
- `shared/tracks/` — Track metadata, geometry, guides, and verification data
- `shared/tunes/` — Vehicle setup data (JSON)

### Data Flow

1. Game sends UDP packets → `server/runtime/udp-listener.ts` receives and buffers
2. `server/games/packet-dispatch.ts` auto-detects game via `canHandle()`, then its game-owned parser decodes binary → typed telemetry object
3. `server/lap-detection/detector.ts` tracks lap boundaries, saves completed laps to SQLite
4. `server/runtime/websocket-manager.ts` broadcasts live packet to all WebSocket clients
5. Client `telemetry.ts` Zustand store receives via WebSocket → React components re-render
6. Historical data fetched via REST API (`/api/laps`, `/api/sessions`, etc.)

### Key Conventions

- Path aliases: `@shared/*` → `./shared/*` (server/test), `@/*` → `./src/*` (client only)
- Client proxies `/api` and `/ws` requests to `localhost:3117` via Vite dev server config
- **API calls use Hono RPC**: import `client` from `@/lib/rpc.ts` (typed against `AppType` from `server/routes/index.ts`) — do not use raw `fetch` for API routes
- **gameId travels via `X-Game-Id` header** — not query params or effect-populated stores
- Database file: `data/forza-telemetry.db` (SQLite)
- Settings persisted to: `data/settings.json`
- UI components use shadcn (in `client/src/components/ui/`) with Tailwind CSS v4
- Client uses TanStack React Query for server state management
- 3D visualizations use React Three Fiber (Three.js wrapper for React)
- **Never fall back to "fm-2023"** when gameId is missing — make gameId required
- ⚠️ **IMPORTANT — NO DYNAMIC IMPORTS.** `await import(...)` is **banned** in this repo. Static imports at the top of the file, always. The *only* exception is a literal platform-specific switch (e.g. a Windows-only native module guarded by `process.platform === "win32"`) where the target genuinely doesn't exist on other platforms — and even then, document the reason inline. "Lazy-load to avoid startup cost", "break a circular dep", or "match the pattern in this file" are **NOT** valid reasons — fix the architecture instead. This rule has repeatedly caused test hangs (234s `isNewer` case) and opaque module-load chains; it is non-negotiable.

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
- `shared/games/fm-2023/` + `server/games/fm-2023/` — Forza Motorsport 2023
- `shared/games/f1-2025/` + `server/games/f1-2025/` — F1 25
- `shared/games/acc/` + `server/games/acc/` — Assetto Corsa Competizione
- `shared/games/ac-evo/` + `server/games/ac-evo/` — Assetto Corsa Evo
- `shared/games/iracing/` + `server/games/iracing/` — iRacing

### Adding a New Game

Follow the registry and boundary model in [architecture overview](docs/architecture/overview.md). Implement shared and server adapters, register both, then add game-specific parsing, routes, data, and focused tests. Never introduce an implicit fallback game.

### Track Segments: curated geometry is the source of truth

⚠️ **`shared/track-segment-generate.ts` (`bun run tracks:segments`) is a FALLBACK detector, not a ground truth.** It infers corner regions from a centerline polyline so that a track with *no* curated geometry still gets usable segments. It will never be 100% accurate, and that is by design.

The hierarchy:

1. **Curated geometry** (`shared/tracks/<gameId>/<slug>-segments.json` — per-game `segments` + `sectors`) — authoritative. What the app actually ships and renders.
2. **Curated facts / roster** (`shared/tracks/meta/<slug>.json` — corner numbers, names, `direction`, `group`) — authoritative. Hand-curated against real-world turn-by-turn guides.
3. **Detection** (`detectCornerRegions`) — best-effort. Only fills gaps; must never overwrite 1 or 2. `buildUpdatedMeta` deliberately keeps a committed corner's `direction` verbatim, including a *deliberate absence* (e.g. Sebring T15, a multi-apex turn with no single direction).

**Therefore: a detector miss on a track that already ships curated geometry costs nothing.** Do NOT loosen detection thresholds, re-curate a shared name list around one game's bad centerline, or reshape the roster to make the generator happy. Those changes trade a real, correct, curated fact for a cosmetically green fallback — and they break the *other* games sharing that slug.

**Where effort belongs:** getting curated geometry and rosters *accurate* (against real turn-by-turn guides, per track), not endlessly tuning `track-segment-generate.ts`. If a track looks wrong in the app, fix the curated data for that track. Touch the generator only when it is wrong in a *general* way (a bug affecting every track), never to chase one slug's alignment.

The sanctioned-gap ledgers in `test/helpers/track-known-gaps.ts` (`KNOWN_ALIGNMENT_GAPS`, `KNOWN_FUZZY_ALIGNMENTS`, `KNOWN_TURN_GAPS`) exist to record these accepted misses. They are **shrink-only**: each entry is asserted to still be broken, so a fix forces its deletion. Adding an entry is legitimate when the miss is genuinely a centerline-quality problem (each entry needs a reason comment); it is not a way to silence a real regression in curated data.

Known centerline-quality classes, already understood — don't re-litigate them: ACC tracks whose "centerline" is still the fastlane racing line (issue #98, fixed per-track by `scripts/acc-centerline-from-boundaries.ts`), ac-evo centerlines that under-detect individual corners, and Forza's Nordschleife/Watkins Glen digitised at a different corner granularity than the shared name list.

#### Curation coverage

Three separate claims, weakest to strongest — **curated is not the same as correct**:

| Column | Means |
|--------|-------|
| **Curated roster** | `shared/tracks/meta/<slug>.json` has a hand-authored non-empty `corners` array. Counting *geometry* files instead would always read ~100% — the fallback detector writes one for nearly every centerline. |
| **Meta human-verified** | A person checked that roster against a real turn-by-turn guide and signed it off. |
| **Segments human-verified** | A person checked that game's rendered geometry (`shared/tracks/<gameId>/<slug>-segments.json`, easiest via the committed `test/e2e/output/track-segments/<slug>-<gameId>.svg`) and signed it off. Kept separate from meta because a correct roster says nothing about whether the corners landed in the right *place* — f1-2025 segments in particular are known to be inaccurate. |

**Counts live in `docs/contributing/track-curation.md`, not here.** That document owns the generated per-game summary and per-track verification breakdown.

⚠️ **When you curate a track (or add a game's centerlines), refresh the stats:**

```bash
bun run tracks:coverage            # print the table
bun run tracks:coverage --write    # rewrite generated blocks in docs/contributing/track-curation.md
```

**Signing off verification** — only after actually comparing against a real source, never as a side effect of generating or regenerating anything:

```bash
bun run tracks:coverage --verify meta:suzuka --by "official circuit map"
bun run tracks:coverage --verify segments:f1-2025/spa --by "svg render vs circuit map"
bun run tracks:coverage --write    # then refresh the table
```

Signatures live in `shared/tracks/verified.json` and pin a hash of the file signed. **Edit the file and the signature goes stale** — it drops out of the verified count and shows as `+N stale`, so a human has to look again. Claude must not stamp the ledger on its own: propose it, let the user confirm what they checked. Low verified numbers are honest, not a metric to farm.

`test/track-coverage.test.ts` fails if the committed table drifts from the repo, so this cannot silently rot. Source of truth: `shared/track-coverage.ts` + `shared/track-verified.ts`.

📖 Full write-up — layer hierarchy, detector fallback, sanctioned gaps, and verification rules: **[track curation](docs/contributing/track-curation.md)**.

### Pre-commit Hooks (Lefthook)

Installed via `postinstall` script. Runs in parallel on staged client files:
- **lint** — ESLint on staged `client/src/**/*.{ts,tsx}`
- **typecheck** — full client build (`cd client && bun run build`)

### AI Evaluators

Lap Analyst and Compare Engineer outputs are gated by deterministic scorers under `mastra/evals/scorers/`. The eval harness runs real fixture laps through an eval-only agent (pinned to `google/gemini-3-flash`), scores the output, and fails the build if any score drops below its threshold in `mastra/evals/index.ts::SCORER_THRESHOLDS`.

**Scorers (all deterministic, no LLM judge):**
- `output-shape` — analyst output parses against `AnalystOutputSchema` (`server/ai/schemas.ts`). Threshold 1.0.
- `corner-coverage` — fraction of the fixture's expected slowest corners mentioned. Threshold 0.7.
- `numeric-grounding` — fraction of `tuning[]` entries citing a concrete number-with-unit. Threshold 0.8.
- `unit-consistency` — metric fixtures must not leak imperial units, and vice versa. Threshold 1.0.
- `compare-directionality` — compare output correctly names the faster lap. Threshold 0.9.
- `chat-freeform-shape` — chat output is non-empty, cites real corners, no hallucinated corner names. Threshold 0.8.
- `drill-quality` — a Driver Coach drill is LOCATED (0.3), ACTIONABLE (0.3), SINGULAR (0.3) and CONCRETE (0.1). Threshold 0.75. ⚠️ The weights are load-bearing: under equal weights a drill that bundled two changes, or named nowhere to run it, scored exactly the pass mark. Any one of located/actionable/singular missing must fail. Coaching output has no deterministic rules engine behind it, so this is the only thing stopping "be smoother" being recorded as an arm and then judged on a spread it cannot move.

**Schema source of truth:** every game adapter prompt (FM, F1, ACC, AC Evo) renders its JSON output shape via `renderAnalystSchemaForPrompt()` from `server/ai/schemas.ts`, so the scorer and the model's instructions stay in lockstep. Per-game prompts still own their own category guidelines and domain rules, but the shape is centralised.

**Running evals:**
```
bun run test:ai                  # runs test/ai-quality.test.ts
bun run ai:baseline              # snapshots scores to test/ai-fixtures/baselines/<sha>-<model>.json
```

Both commands require `GEMINI_API_KEY` (or `GOOGLE_GENERATIVE_AI_API_KEY`); they skip cleanly when absent so forks and fresh clones don't flake.

**Adding a fixture:** see `test/ai-fixtures/README.md`. In short: export a real lap via `bun run laps:export --ids <id> -o test/ai-fixtures/packets/<id>.zip`, then add a matching JSON under `test/ai-fixtures/laps/` with an `expected` block pinning _signals_ (corner names, faster lap, setup direction) — not a reference answer. Signals survive prompt iteration; reference answers do not.

**CI:** AI evals are local-dev only. Not gated in CI and not required before shipping.

### Testing

Tests live in `test/` and use Bun's native test runner (`bun:test` with `describe`/`test`/`expect`). Tests that involve packet parsing must initialize game adapters first:

```typescript
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";

initGameAdapters();
initServerGameAdapters();
```

**Known issue**: ACC shared memory tests fail on macOS due to `@libsql/client` module resolution (Windows-only feature).

### CI/CD

- **PR/main**: GitHub Actions runs `bun test` and client build (`.github/workflows/build-test.yml`)
- **Release tags**: Windows x64 binary compilation via `.github/workflows/release.yml` — Bun compiles server to `raceiq.exe`, bundles with Vite client output into `raceiq-windows-x64.zip`

### Memory

Project memory is stored in `.claude/memory/` in the repo root (not the default `~/.claude/projects/` path). This is version-controlled so all contributors share context. Read and write memory files there.

### Documentation

Use [docs landing page](docs/README.md) for maintained documentation and [architecture overview](docs/architecture/overview.md) for current service, adapter, and data-flow boundaries.

