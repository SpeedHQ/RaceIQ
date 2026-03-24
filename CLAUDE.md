# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Forza Telemetry is a full-stack racing telemetry analysis app for Forza Motorsport. It receives real-time UDP telemetry packets from the game at 60 Hz, stores lap data in SQLite, and provides a React dashboard with live visualizations, lap comparison, AI-powered analysis, and 3D car attitude rendering.

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
bun run db:push       # push schema changes to SQLite
bun run db:generate   # generate migration files

# Production build (client bundle + compiled server binary → dist/)
bun run build

# Run production build
bun run start

# Client-specific
cd client && bun run build   # production build (tsc + vite)
cd client && bun run lint    # ESLint
```

## Architecture

### Three-layer monorepo: `server/`, `client/`, `shared/`

**Server (Bun + Hono)**
- `server/index.ts` — Entry point: Bun.serve with HTTP + WebSocket upgrade on port 3117
- `server/udp.ts` — UDP socket listening for Forza telemetry packets
- `server/parser.ts` — Binary packet parsing (Forza data-out format)
- `server/routes.ts` — All Hono API routes under `/api` (laps, sessions, settings, analysis, export, compare, profiles, corners)
- `server/ws.ts` — WebSocket manager, broadcasts parsed packets to all connected clients
- `server/lap-detector.ts` — Detects lap boundaries from telemetry stream
- `server/corner-detection.ts` — Identifies racing corners from telemetry data
- `server/ai/analyst-prompt.ts` — Builds prompts for Claude API lap analysis
- `server/db/schema.ts` — Drizzle ORM schema (profiles, sessions, laps, corners, lapAnalyses, trackOutlines)
- `server/db/queries.ts` — Database query helpers

**Client (React 19 + Vite + TanStack Router)**
- `client/src/main.tsx` — App entry point
- `client/src/routes/__root.tsx` — Root layout with TanStack Router
- `client/src/routeTree.gen.ts` — Auto-generated route tree (do not edit manually)
- `client/src/stores/telemetry.ts` — Zustand store for WebSocket connection state, current packet, packets/sec
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
- `shared/car-data.ts` — Car model ID-to-name mapping
- `shared/track-outlines/` — Track geometry data (JSON coords, sector definitions, named segments)
- `shared/tunes/` — Vehicle setup data (JSON)

### Data Flow

1. Forza game sends UDP packets → `server/udp.ts` receives and buffers
2. `server/parser.ts` decodes binary → typed telemetry object
3. `server/lap-detector.ts` tracks lap boundaries, saves completed laps to SQLite
4. `server/ws.ts` broadcasts live packet to all WebSocket clients
5. Client `telemetry.ts` Zustand store receives via WebSocket → React components re-render
6. Historical data fetched via REST API (`/api/laps`, `/api/sessions`, etc.)

### Key Conventions

- Path alias: `@shared/*` maps to `./shared/*` (used in server/test imports via tsconfig paths)
- Client proxies `/api` requests to `localhost:3117` via Vite dev server config
- Database file: `data/forza-telemetry.db` (SQLite)
- Settings persisted to: `data/settings.json`
- UI components use shadcn (in `client/src/components/ui/`) with Tailwind CSS v4
- Client uses TanStack React Query for server state management
- 3D visualizations use React Three Fiber (Three.js wrapper for React)

### Tech Stack Summary

| Layer | Technology |
|-------|-----------|
| Runtime | Bun |
| Server framework | Hono |
| Database | SQLite + Drizzle ORM |
| Frontend | React 19, Vite 8, TypeScript 5.9 |
| Routing | TanStack Router (file-based, auto-generated) |
| State | Zustand (client), TanStack Query (server state) |
| Styling | Tailwind CSS v4 + shadcn |
| Charts | uplot |
| 3D | Three.js + React Three Fiber |
| AI | Claude API (lap analysis) |
