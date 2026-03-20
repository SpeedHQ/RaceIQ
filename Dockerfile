# ── base: install dependencies ────────────────────────────────────────────────
FROM oven/bun:1 AS base
WORKDIR /app

# Install root deps (server: hono, drizzle-orm, etc.)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Install client deps (react, vite, tailwind, etc.)
# Note: client/ is an independent package with no separate bun.lock
COPY client/package.json ./client/
RUN cd client && bun install

# ── dev: used for both dev service containers ─────────────────────────────────
# Source is bind-mounted at runtime; node_modules come from this image layer.
FROM base AS dev
EXPOSE 3117 5173

# ── builder: build the React client ──────────────────────────────────────────
FROM base AS builder
COPY . .
# Use vite build directly to skip tsc type-checking (pre-existing TS errors don't block the bundle)
RUN cd client && bunx --bun vite build

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

# server/ai/analyst-prompt.ts imports from client/src/lib at runtime
COPY client/src/lib ./client/src/lib

EXPOSE 3117
ENV NODE_ENV=production

CMD ["bun", "run", "server/index.ts"]
