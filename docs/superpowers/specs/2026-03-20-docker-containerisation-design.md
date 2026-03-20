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
| `base` | `oven/bun:1` | Install root deps (`bun install` in `/app`) |
| `dev` | `base` | Used for dev containers; source mounted at runtime |
| `builder` | `base` | Runs `bun install` in `/app/client`, then `vite build` to produce `client/dist` |
| `prod` | `oven/bun:1-alpine` | Lean image: server source + `client/dist` + root `node_modules`, no client deps |

**Dependency split:** The root `package.json` and `client/package.json` are independent (no Bun workspaces). The `base` stage installs root deps; the `builder` stage must also `bun install` inside `client/` before running the build. The `prod` stage only needs root `node_modules` (server deps) — `client/node_modules` is not copied.

The `prod` stage must not include dev dependencies or source files beyond what the server needs to run.

---

## docker-compose.yml

Services and their configuration:

| Service | Profile | Image Stage | Published Ports | Volumes |
|---|---|---|---|---|
| `server` | `prod` | `prod` | `${SERVER_PORT:-3117}:${SERVER_PORT:-3117}`, `${UDP_PORT:-4321}:${UDP_PORT:-4321}/udp` | `./data:/app/data` |
| `server` | `dev` | `dev` | `${SERVER_PORT:-3117}:${SERVER_PORT:-3117}`, `${UDP_PORT:-4321}:${UDP_PORT:-4321}/udp` | `./data:/app/data`, source bind-mount, `/app/node_modules` anonymous volume |
| `client` | `dev` | `dev` | `5173:5173` | source bind-mount, `/app/node_modules` anonymous volume, `/app/client/node_modules` anonymous volume |

The `client` service depends on `server` and communicates with it via the Docker Compose internal network using the service name `server`. Anonymous volumes at `/app/node_modules` and `/app/client/node_modules` prevent the bind-mounted source from overwriting the container's installed modules.

**Port variable naming:** `SERVER_PORT` (not `PORT`) is used for the server's HTTP port to avoid conflicting with Vite, which also reads `process.env.PORT` to set its own listen port. Setting `PORT` in the client container would cause Vite to listen on the wrong port.

---

## Environment Variables

| Variable | Default | Used By | Purpose |
|---|---|---|---|
| `SERVER_PORT` | `3117` | server, compose | HTTP/WebSocket listen port — named `SERVER_PORT` to avoid clash with Vite's `PORT` |
| `UDP_PORT` | `4321` | server, compose | Forza telemetry UDP port — must be read from env in `server/index.ts` (currently driven by persisted settings; requires code change) |
| `DATA_DIR` | `/app/data` | server | Directory for SQLite DB and settings files — requires code change to read from env (currently hardcoded) |
| `PROXY_TARGET` | `http://server:3117` | client (dev, vite.config.ts) | Vite proxy target read by `vite.config.ts` at Node.js config time — **not** a browser-injected variable. Override to `http://localhost:3117` for local non-Docker dev. |

A `.env.example` file will document all variables.

---

## Required Code Changes

### 1. `server/index.ts` — read SERVER_PORT from environment

Replace the hardcoded port with `process.env.SERVER_PORT ?? 3117`.

### 2. `server/index.ts` — read UDP_PORT from environment

The UDP listener currently starts with `settings.udpPort` from persisted settings. Add fallback to `process.env.UDP_PORT` so the port can be configured at container startup without requiring saved settings. Suggested: `settings.udpPort ?? Number(process.env.UDP_PORT) ?? 4321`.

### 3. `server/index.ts` and `server/settings.ts` — read DATA_DIR from environment

The SQLite DB path is currently hardcoded as `./data/forza-telemetry.db`. This must read from `process.env.DATA_DIR` (defaulting to `./data`). The `drizzle.config.ts` file also hardcodes this path — it must be updated to use the same env var for consistency. Any settings JSON file path should also be derived from `DATA_DIR`.

### 4. `client/vite.config.ts` — proxy target from environment

Change the proxy target from the hardcoded `http://localhost:3117` to read from `process.env.PROXY_TARGET`, defaulting to `http://localhost:3117`. This is read by Vite's Node.js config process — it is **not** injected into the browser bundle. The dev client container sets `PROXY_TARGET=http://server:3117`.

### 5. `server/index.ts` — static file serving (verify or add)

Verify whether Hono's `serveStatic` is already configured. If not, add it: serve files from `./client/dist` when `NODE_ENV=production`. Required for the single-container prod setup.

### 6. `server/index.ts` — caffeinate on non-macOS (known behaviour)

The server spawns `caffeinate` (macOS-only) at startup. This will fail silently on Linux containers but may produce noisy log output. Add a platform guard (`process.platform === 'darwin'`) around the `caffeinate` spawn.

---

## Data Persistence

SQLite database and settings files must reside under the `DATA_DIR` path (`/app/data` inside the container), which is bind-mounted to `./data` on the host.

- Local dev: `./data/` in repo root (gitignored)
- Coolify prod: bind-mounted to a Coolify persistent volume path configured in the dashboard

**Note:** `DATA_DIR` controls what the server process reads. The host-side mount path (`./data`) is defined separately in `docker-compose.yml`. Changing one without the other causes a mismatch.

**Migrations:** The server runs Drizzle schema creation on startup (confirmed via the DB import on boot). First-run on a fresh `./data` directory is safe — no manual migration step is required.

---

## Coolify Deployment

1. Point Coolify at the repository
2. Select `docker-compose.yml` as the compose file
3. Activate the prod profile by setting `COMPOSE_PROFILES=prod` in the Coolify environment variables panel
4. Configure environment variables in the Coolify dashboard:
   - `UDP_PORT` — must match Forza's configured data-out port
   - The host-side bind mount path (`./data`) maps to a Coolify persistent volume; configure the volume path in Coolify's storage settings
5. Ensure the Coolify host's firewall allows the UDP port inbound

**Limitation:** Railway is not a suitable target because it does not support UDP port exposure, which is required for Forza telemetry ingestion. Coolify (self-hosted on a VPS or home server) is the recommended production platform.

---

## Files Created / Modified

| Path | Action |
|---|---|
| `Dockerfile` | Create |
| `docker-compose.yml` | Create |
| `.env.example` | Create |
| `.dockerignore` | Create — exclude: `node_modules`, `.git`, `client/dist`, `data/`, `*.log`. Include `bun.lock` (text lock file, needed for reproducible installs). |
| `server/index.ts` | Modify — read `SERVER_PORT`, `UDP_PORT` from env; add platform guard for `caffeinate`; verify/add static file serving |
| `server/settings.ts` | Modify — derive file paths from `DATA_DIR` env var |
| `drizzle.config.ts` | Modify — read DB path from `DATA_DIR` env var |
| `client/vite.config.ts` | Modify — read proxy target from `PROXY_TARGET` env var |

---

## Out of Scope

- CI/CD pipeline changes
- Railway support (UDP limitation makes it unsuitable)
- HTTPS/TLS termination (handled by Coolify's reverse proxy)
