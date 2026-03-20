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
