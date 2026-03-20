# Docker Containerisation Design

**Date:** 2026-03-20
**Status:** Approved
**Topic:** Containerise the Forza Telemetry server and client with Docker Compose, targeting Coolify for production hosting.

---

## Goals

- Single `docker compose --profile dev up` for local development with hot reload
- Single `docker compose --profile prod up` for production (Coolify deployment)
- Full functionality including UDP telemetry ingestion in production
- SQLite database persisted via bind mount on the host
- Minimal code changes to existing application

---

## Architecture

### Development (2 containers)

```
┌─────────────────────────────┐
│  server (dev profile)       │
│  bun --watch server/index.ts│
│  port 3117 (HTTP + WS)      │
│  UDP_PORT/udp published     │
│  source bind-mounted        │
│  ./data bind-mounted        │
└─────────────────────────────┘
┌─────────────────────────────┐
│  client (dev profile)       │
│  vite --host                │
│  port 5173                  │
│  source bind-mounted        │
│  proxies /api, /ws → server │
└─────────────────────────────┘
```

### Production (1 container)

```
┌─────────────────────────────┐
│  server (prod profile)      │
│  bun server/index.ts        │
│  port 3117 (HTTP + WS)      │
│  UDP_PORT/udp published     │
│  serves /client/dist static │
│  ./data bind-mounted        │
└─────────────────────────────┘
```

---

## Dockerfile (Multi-Stage)

Four stages in a single `Dockerfile` at the repo root:

| Stage | Base | Purpose |
|---|---|---|
| `base` | `oven/bun:1` | Install all dependencies |
| `dev` | `base` | Used for dev containers; source mounted at runtime |
| `builder` | `base` | Copies full source, runs `vite build` to produce `client/dist` |
| `prod` | `oven/bun:1-alpine` | Lean image: server source + `client/dist`, no dev deps |

The `prod` stage must not include dev dependencies or source files beyond what the server needs to run.

---

## docker-compose.yml

Services and their configuration:

| Service | Profile | Image Stage | Published Ports | Volumes |
|---|---|---|---|---|
| `server` | `prod` | `prod` | `${PORT:-3117}:${PORT:-3117}`, `${UDP_PORT:-4321}:${UDP_PORT:-4321}/udp` | `./data:/app/data` |
| `server` | `dev` | `dev` | `${PORT:-3117}:${PORT:-3117}`, `${UDP_PORT:-4321}:${UDP_PORT:-4321}/udp` | `./data:/app/data`, source bind-mount, node_modules anonymous volume |
| `client` | `dev` | `dev` | `5173:5173` | source bind-mount, node_modules anonymous volume |

The `client` service depends on `server` and communicates with it via the Docker Compose internal network using the service name `server`. Both dev services use an anonymous volume at `/app/node_modules` to prevent the bind-mounted source from overwriting the container's installed modules.

---

## Environment Variables

| Variable | Default | Used By | Purpose |
|---|---|---|---|
| `PORT` | `3117` | server | HTTP/WebSocket listen port |
| `UDP_PORT` | `4321` | server, compose | Forza telemetry UDP port |
| `DATA_DIR` | `/app/data` | server | Directory for SQLite database file (server process only — does not affect the host-side bind mount path in docker-compose.yml) |
| `PROXY_TARGET` | `http://server:3117` | client (dev, vite.config.ts) | Vite proxy target read by `vite.config.ts` at Node.js config time — not a browser-injected variable. Override to `http://localhost:3117` for local non-Docker dev. |

A `.env.example` file will document all variables.

---

## Required Code Changes

### 1. `server/index.ts` — read PORT from environment

The server must use `process.env.PORT ?? 3117` instead of a hardcoded value. Verify `DATA_DIR` is also read from the environment for the SQLite file path.

### 2. `client/vite.config.ts` — proxy target from environment

Change the proxy target from the hardcoded `http://localhost:3117` to read from `process.env.PROXY_TARGET`, defaulting to `http://localhost:3117`. This is read by Vite's Node.js config process — it is not injected into the browser bundle. The dev client container sets `PROXY_TARGET=http://server:3117` so it can reach the server container via Docker's internal network.

### 3. `server/index.ts` — static file serving (verify or add)

Verify whether `server/index.ts` already serves static files via Hono's `serveStatic`. If not, this must be added as a required code change: serve files from `client/dist` (relative to the app root) when `NODE_ENV=production`. This is required for the single-container prod setup.

---

## Data Persistence

SQLite database and any settings files must reside under the `DATA_DIR` path (`/app/data` inside the container), which is bind-mounted to `./data` on the host.

- Local dev: `./data/` in repo root (gitignored)
- Coolify prod: bind-mounted to a Coolify persistent volume path configured in the dashboard

**Note:** `DATA_DIR` only tells the server process where to find the database file inside the container. The host-side mount path (`./data`) is defined separately in `docker-compose.yml`. Changing `DATA_DIR` alone without updating the compose volume spec will cause a mismatch.

**Migrations:** Verify whether `server/index.ts` runs Drizzle migrations automatically on startup. If it does, first-run on a fresh `./data` directory is safe. If not, document a manual step: run `bun run db:push` against the container before first use.

---

## Coolify Deployment

1. Point Coolify at the repository
2. Select `docker-compose.yml` as the compose file
3. Activate the prod profile by setting `COMPOSE_PROFILES=prod` in the Coolify environment variables panel
4. Configure environment variables in the Coolify dashboard:
   - `UDP_PORT` — must match Forza's configured data-out port
   - The host-side bind mount path (`./data`) maps to a Coolify persistent volume; configure the volume in Coolify's storage settings rather than via `DATA_DIR`
5. The UDP port must be exposed on the host; ensure the Coolify host's firewall allows the UDP port inbound

**Limitation:** Railway is not a suitable target because it does not support UDP port exposure, which is required for Forza telemetry ingestion. Coolify (self-hosted on a VPS or home server) is the recommended production platform.

---

## Files Created / Modified

| Path | Action |
|---|---|
| `Dockerfile` | Create |
| `docker-compose.yml` | Create |
| `.env.example` | Create |
| `.dockerignore` | Create — must exclude: `node_modules`, `.git`, `client/dist`, `data/`, `*.log`. Must include `bun.lockb` (needed for reproducible installs inside the image). |
| `server/index.ts` | Modify — read PORT/DATA_DIR from env |
| `client/vite.config.ts` | Modify — read proxy target from VITE_SERVER_URL env var |

---

## Out of Scope

- CI/CD pipeline changes
- Railway support (UDP limitation makes it unsuitable)
- Database migration automation in the container entrypoint (can be added later)
- HTTPS/TLS termination (handled by Coolify's reverse proxy)
