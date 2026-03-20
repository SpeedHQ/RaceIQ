# Docker Containerisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Containerise the Forza Telemetry server and client with a multi-stage Dockerfile and docker-compose profiles for dev (hot reload) and prod (single container, Coolify-ready).

**Architecture:** Multi-stage Dockerfile (`base` → `dev` → `builder` → `prod`). Dev profile runs two containers (server with `bun --watch`, client with Vite). Prod profile runs one container serving the built React app from Hono via Bun's file API.

**Tech Stack:** Bun, Hono, React/Vite, SQLite (Drizzle), Docker, Docker Compose v2

**Spec:** `docs/superpowers/specs/2026-03-20-docker-containerisation-design.md`

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `server/db/index.ts` | Modify | Read `DATA_DIR` from env for DB path |
| `server/settings.ts` | Modify | Read `DATA_DIR` from env for settings path |
| `server/index.ts` | Modify | Read `SERVER_PORT`/`UDP_PORT` from env; caffeinate guard; static file serving in prod |
| `client/vite.config.ts` | Modify | Read `PROXY_TARGET` from env for dev proxy |
| `drizzle.config.ts` | Modify | Read `DATA_DIR` from env for DB path (CLI migrations) |
| `.dockerignore` | Create | Exclude noise from Docker build context |
| `Dockerfile` | Create | Multi-stage build definition |
| `docker-compose.yml` | Create | Dev and prod service definitions with profiles |
| `.env.example` | Create | Document all environment variables |

---

## Task 1: Update `server/db/index.ts` — read DATA_DIR from env

**Files:**
- Modify: `server/db/index.ts:6-7`

- [ ] **Step 1: Edit the DB path constants**

Replace lines 6-7:
```typescript
const DB_DIR = "./data";
const DB_PATH = `${DB_DIR}/forza-telemetry.db`;
```
With:
```typescript
const DB_DIR = process.env.DATA_DIR ?? "./data";
const DB_PATH = `${DB_DIR}/forza-telemetry.db`;
```

- [ ] **Step 2: Verify the server still starts**

```bash
bun run server/index.ts
```
Expected: `[Server] Forza Telemetry Server is ready!` with no errors. Ctrl+C to stop.

- [ ] **Step 3: Commit**

```bash
git add server/db/index.ts
git commit -m "feat: read DATA_DIR env var for DB path"
```

---

## Task 2: Update `server/settings.ts` — read DATA_DIR from env

**Files:**
- Modify: `server/settings.ts:3-4`

- [ ] **Step 1: Edit the settings path constants**

Replace lines 3-4:
```typescript
const SETTINGS_DIR = "./data";
const SETTINGS_PATH = `${SETTINGS_DIR}/settings.json`;
```
With:
```typescript
const SETTINGS_DIR = process.env.DATA_DIR ?? "./data";
const SETTINGS_PATH = `${SETTINGS_DIR}/settings.json`;
```

- [ ] **Step 2: Verify the server still starts**

```bash
bun run server/index.ts
```
Expected: clean startup, no errors. Ctrl+C to stop.

- [ ] **Step 3: Commit**

```bash
git add server/settings.ts
git commit -m "feat: read DATA_DIR env var for settings path"
```

---

## Task 3: Update `drizzle.config.ts` — read DATA_DIR from env

**Files:**
- Modify: `drizzle.config.ts`

**Note:** This only affects `drizzle-kit` CLI commands (`bun run db:push`, `bun run db:generate`). The runtime DB path is handled in Task 1.

- [ ] **Step 1: Edit the DB credentials URL**

Replace:
```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./server/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "./data/forza-telemetry.db",
  },
});
```
With:
```typescript
import { defineConfig } from "drizzle-kit";

const DATA_DIR = process.env.DATA_DIR ?? "./data";

export default defineConfig({
  schema: "./server/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: `${DATA_DIR}/forza-telemetry.db`,
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add drizzle.config.ts
git commit -m "feat: read DATA_DIR env var for drizzle-kit DB path"
```

---

## Task 4: Update `server/index.ts` — env vars, caffeinate guard, static serving

**Files:**
- Modify: `server/index.ts`

This task makes four changes to `server/index.ts`:
1. Add platform guard to caffeinate block
2. Read `SERVER_PORT` from env
3. Read `UDP_PORT` from env as fallback for `settings.udpPort`
4. Add Bun-native static file serving for production

- [ ] **Step 1: Add caffeinate platform guard**

The current try/catch already handles failure gracefully, but it spawns the process on all platforms. Add a platform check. Replace the entire caffeinate block:

```typescript
// Prevent macOS sleep while the server is running (non-fatal if caffeinate unavailable)
try {
  const caffeinate = spawn("caffeinate", ["-i"], { stdio: "ignore", detached: true });
  caffeinate.unref();
  process.on("exit", () => { try { caffeinate.kill(); } catch {} });
  console.log("[Server] caffeinate started — macOS will not sleep while server is running");
} catch {
  console.log("[Server] caffeinate not available — sleep prevention disabled");
}
```
With:
```typescript
// Prevent macOS sleep while the server is running
if (process.platform === "darwin") {
  try {
    const caffeinate = spawn("caffeinate", ["-i"], { stdio: "ignore", detached: true });
    caffeinate.unref();
    process.on("exit", () => { try { caffeinate.kill(); } catch {} });
    console.log("[Server] caffeinate started — macOS will not sleep while server is running");
  } catch {
    console.log("[Server] caffeinate not available — sleep prevention disabled");
  }
}
```

- [ ] **Step 2: Read SERVER_PORT from env**

Replace:
```typescript
const HTTP_PORT = 3117;
```
With:
```typescript
const HTTP_PORT = Number(process.env.SERVER_PORT) || 3117;
```

- [ ] **Step 3: Read UDP_PORT from env as fallback**

Replace:
```typescript
// Start UDP listener with saved settings
udpListener.start(settings.udpPort);

console.log(`[Server] Forza Telemetry Server is ready!`);
console.log(`[Server] Listening for Forza UDP on port ${settings.udpPort}`);
```
With:
```typescript
// Start UDP listener — settings.udpPort takes priority, env var is the fallback
const udpPort = settings.udpPort ?? Number(process.env.UDP_PORT) || 5300;
udpListener.start(udpPort);

console.log(`[Server] Forza Telemetry Server is ready!`);
console.log(`[Server] Listening for Forza UDP on port ${udpPort}`);
```

- [ ] **Step 4: Add static file serving for production**

The Bun.serve `fetch` handler currently handles WebSocket upgrades then delegates everything else to Hono. In production, non-API routes should serve the built client. Replace the `fetch` function inside `Bun.serve<WSData>({`:

```typescript
  async fetch(req, server) {
    // Handle WebSocket upgrade
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, {
        data: { createdAt: Date.now() },
      });
      // Bun expects undefined returned on successful upgrade; cast satisfies TypeScript
      if (upgraded) return undefined as unknown as Response;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // API routes always go to Hono
    if (url.pathname.startsWith("/api")) {
      return app.fetch(req);
    }

    // In production, serve static files from built client
    if (process.env.NODE_ENV === "production") {
      const filePath = `./client/dist${url.pathname}`;
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file);
      }
      // SPA fallback: serve index.html for client-side routes
      return new Response(Bun.file("./client/dist/index.html"));
    }

    // Handle HTTP via Hono (dev mode)
    return app.fetch(req);
  },
```

- [ ] **Step 5: Verify the server still starts locally**

```bash
bun run server/index.ts
```
Expected: clean startup. Ctrl+C to stop.

- [ ] **Step 6: Commit**

```bash
git add server/index.ts
git commit -m "feat: env-configurable port/UDP, caffeinate guard, prod static serving"
```

---

## Task 5: Update `client/vite.config.ts` — proxy target from env

**Files:**
- Modify: `client/vite.config.ts`

- [ ] **Step 1: Edit the proxy targets**

Replace:
```typescript
    proxy: {
      "/api": {
        target: "http://localhost:3117",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:3117",
        ws: true,
      },
    },
```
With:
```typescript
    proxy: {
      "/api": {
        target: process.env.PROXY_TARGET ?? "http://localhost:3117",
        changeOrigin: true,
      },
      "/ws": {
        target: (process.env.PROXY_TARGET ?? "http://localhost:3117").replace(/^http/, "ws"),
        ws: true,
      },
    },
```

- [ ] **Step 2: Verify Vite still starts locally**

```bash
cd client && bun run dev
```
Expected: Vite starts on port 5173 with no errors. Ctrl+C to stop.

- [ ] **Step 3: Commit**

```bash
git add client/vite.config.ts
git commit -m "feat: read PROXY_TARGET env var for Vite dev proxy"
```

---

## Task 6: Create `.dockerignore`

**Files:**
- Create: `.dockerignore`

- [ ] **Step 1: Create the file**

```
node_modules
client/node_modules
client/dist
data/
.git
.gitignore
*.log
firebase-debug.log
docs/
test/
.superpowers/
drizzle/
```

- [ ] **Step 2: Commit**

```bash
git add .dockerignore
git commit -m "chore: add .dockerignore"
```

---

## Task 7: Create `Dockerfile`

**Files:**
- Create: `Dockerfile`

- [ ] **Step 1: Create the Dockerfile**

```dockerfile
# ── base: install dependencies ────────────────────────────────────────────────
FROM oven/bun:1 AS base
WORKDIR /app

# Install root deps (server: hono, drizzle-orm, etc.)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Install client deps (react, vite, tailwind, etc.)
# Note: client/ is an independent package with no separate bun.lock — do not use --frozen-lockfile here
COPY client/package.json ./client/
RUN cd client && bun install

# ── dev: used for both dev service containers ─────────────────────────────────
# Source is bind-mounted at runtime; node_modules come from this image layer.
FROM base AS dev
EXPOSE 3117 5173

# ── builder: build the React client ──────────────────────────────────────────
FROM base AS builder
COPY . .
RUN cd client && bun run build

# ── prod: lean single-container runtime ──────────────────────────────────────
FROM oven/bun:1-alpine AS prod
WORKDIR /app

# Only server runtime deps
COPY --from=base /app/node_modules ./node_modules

# Built client
COPY --from=builder /app/client/dist ./client/dist

# Server source and shared types
COPY server ./server
COPY shared ./shared
COPY package.json ./

EXPOSE 3117
ENV NODE_ENV=production

CMD ["bun", "run", "server/index.ts"]
```

- [ ] **Step 2: Build the prod image to verify it compiles**

```bash
docker build --target prod -t forza-telemetry:prod .
```
Expected: build completes with no errors. The `builder` stage runs `vite build` successfully.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "feat: add multi-stage Dockerfile (base/dev/builder/prod)"
```

---

## Task 8: Create `docker-compose.yml`

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: Create the file**

```yaml
services:

  # ── Production (single container) ──────────────────────────────────────────
  server:
    profiles: [prod]
    build:
      context: .
      target: prod
    ports:
      - "${SERVER_PORT:-3117}:${SERVER_PORT:-3117}"
      - "${UDP_PORT:-5300}:${UDP_PORT:-5300}/udp"
    volumes:
      - ./data:/app/data
    environment:
      SERVER_PORT: ${SERVER_PORT:-3117}
      UDP_PORT: ${UDP_PORT:-5300}
      DATA_DIR: ${DATA_DIR:-/app/data}
      NODE_ENV: production
    restart: unless-stopped

  # ── Development: server with hot reload ────────────────────────────────────
  server-dev:
    profiles: [dev]
    build:
      context: .
      target: dev
    ports:
      - "${SERVER_PORT:-3117}:${SERVER_PORT:-3117}"
      - "${UDP_PORT:-5300}:${UDP_PORT:-5300}/udp"
    volumes:
      - .:/app
      # Prevent host directory from shadowing container's installed node_modules
      - /app/node_modules
      - ./data:/app/data
    environment:
      SERVER_PORT: ${SERVER_PORT:-3117}
      UDP_PORT: ${UDP_PORT:-5300}
    command: bun --watch run server/index.ts

  # ── Development: Vite client with hot reload ────────────────────────────────
  client-dev:
    profiles: [dev]
    build:
      context: .
      target: dev
    ports:
      - "5173:5173"
    volumes:
      - .:/app
      # Preserve both sets of node_modules from the image
      - /app/node_modules
      - /app/client/node_modules
    environment:
      PROXY_TARGET: http://server-dev:${SERVER_PORT:-3117}
    command: sh -c "cd /app/client && bun run vite --host"
    depends_on:
      - server-dev
```

- [ ] **Step 2: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add docker-compose with dev and prod profiles"
```

---

## Task 9: Create `.env.example`

**Files:**
- Create: `.env.example`

- [ ] **Step 1: Create the file**

```bash
# Forza Telemetry — Docker environment variables
# Copy to .env and adjust values as needed.
# The defaults shown here match the docker-compose.yml defaults.

# HTTP/WebSocket port for the server
# Named SERVER_PORT (not PORT) to avoid conflict with Vite's PORT variable
SERVER_PORT=3117

# UDP port Forza sends telemetry to.
# Must match the "Data Out" port configured in Forza's HUD options.
# Default matches server/settings.ts default (5300).
UDP_PORT=5300

# Directory inside the container where the SQLite DB and settings.json are stored.
# The docker-compose.yml bind-mounts ./data on the host to this path.
# Only change DATA_DIR if you also update the volume spec in docker-compose.yml.
DATA_DIR=/app/data

# Vite dev proxy target — used by client/vite.config.ts in the dev container.
# Set to the server's internal Docker network address.
# For local (non-Docker) dev, leave unset; defaults to http://localhost:3117.
PROXY_TARGET=http://server-dev:3117
```

- [ ] **Step 2: Ensure `.env` is gitignored**

```bash
grep -q "^\.env$" .gitignore || echo ".env" >> .gitignore
```

- [ ] **Step 3: Commit**

```bash
git add .env.example .gitignore
git commit -m "chore: add .env.example and ensure .env is gitignored"
```

---

## Task 10: Smoke test — dev profile

- [ ] **Step 1: Start the dev stack**

```bash
docker compose --profile dev up --build
```
Expected:
- `server-dev` starts, prints `[Server] Forza Telemetry Server is ready!`
- `client-dev` starts, prints `VITE v8.x.x  ready in Xms`
- No `caffeinate` errors in server logs

- [ ] **Step 2: Verify the client loads**

Open `http://localhost:5173` in a browser.
Expected: Forza Telemetry UI loads without blank screen or console errors.

- [ ] **Step 3: Verify API proxy works**

```bash
curl http://localhost:5173/api/settings
```
Expected: JSON response from the server (not a 502 or HTML error page).

- [ ] **Step 4: Stop the stack**

```bash
docker compose --profile dev down
```

---

## Task 11: Smoke test — prod profile

- [ ] **Step 1: Start the prod stack**

```bash
docker compose --profile prod up --build
```
Expected:
- Single `server` container starts
- `[Server] Forza Telemetry Server is ready!` in logs
- `NODE_ENV=production` static serving is active

- [ ] **Step 2: Verify the app loads from the prod container**

Open `http://localhost:3117` in a browser.
Expected: Forza Telemetry UI loads (served as static files by Bun, not by Vite).

- [ ] **Step 3: Verify API still works**

```bash
curl http://localhost:3117/api/settings
```
Expected: JSON response.

- [ ] **Step 4: Verify data persists across restarts**

```bash
docker compose --profile prod down
docker compose --profile prod up
```
Expected: `./data/forza-telemetry.db` still exists on the host; app starts with existing data intact.

- [ ] **Step 5: Stop the stack**

```bash
docker compose --profile prod down
```

---

## Coolify Deployment Checklist

After the smoke tests pass:

1. Push the branch to remote
2. In Coolify: add new resource → Docker Compose → point at repo
3. Set environment variable: `COMPOSE_PROFILES=prod`
4. Set environment variable: `UDP_PORT=<your Forza data-out port>`
5. Configure a persistent volume mapped to `/app/data` inside the container
6. Ensure the Coolify host firewall allows `UDP_PORT` inbound
7. Deploy and verify the app loads at your Coolify domain
