# Hono RPC Migration Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Replace manual fetch wrappers with Hono RPC typed client — end-to-end type safety, zero codegen.

**Architecture:** Chain all Hono routes in sub-routers with zValidator, export AppType, client uses `hc<AppType>` typed proxy.

**Tech Stack:** Hono RPC, @hono/zod-validator, Zod, hono/client

**Spec:** `docs/superpowers/specs/2026-04-02-hono-rpc-migration-design.md`

---

## File Structure

**Create:**
- `shared/schemas.ts` — Common Zod schemas (IdParam, OrdinalParam, GameIdQuery)
- `client/src/lib/rpc.ts` — Typed RPC client
- `server/routes/lap-routes.ts` — Lap CRUD + bulk ops + comparison + export + analysis
- `server/routes/session-routes.ts` — Session list + bulk delete
- `server/routes/track-routes.ts` — Track outline, boundaries, sectors, curbs, calibration, extraction
- `server/routes/settings-routes.ts` — Settings, status, wheels, profiles
- `server/routes/car-routes.ts` — Car list, car name, car model configs
- `server/routes/acc-routes.ts` — ACC setups, recording, replay, debug
- `server/routes/misc-routes.ts` — Fuel/grip/telemetry history, game detection

**Modify:**
- `server/routes.ts` — Slim down to just chaining sub-routers + exporting AppType
- `server/routes/tune-routes.ts` — Refactor to chained pattern with zValidator
- `client/src/hooks/queries.ts` — Use RPC client instead of api module
- `client/src/lib/api.ts` — Delete after migration
- ~15 component files with scattered fetch() calls
- `shared/types.ts` — Add missing response types

---

### Task 1: Foundation — Schemas

**Files:**
- Create: `shared/schemas.ts`

- [ ] Create common Zod schemas used across multiple routes
- [ ] Verify: `bun test` passes

---

### Task 2: Server — Split routes into sub-routers with chaining + zValidator

**Files:**
- Create: All sub-router files listed above
- Modify: `server/routes.ts` — chain sub-routers, export AppType
- Modify: `server/routes/tune-routes.ts` — chain pattern

For each sub-router:
1. Create the file with `new Hono()` chained routes
2. Add `zValidator` for all param/query/json inputs
3. Use explicit `c.json()` return types (no `any`)

The main `server/routes.ts` becomes:
```ts
const app = new Hono()
  .use("/*", cors())
  .route("/", lapRoutes)
  .route("/", sessionRoutes)
  // ... etc

export type AppType = typeof app
export default app
```

- [ ] Split and chain all routes
- [ ] Verify: `bun test` passes
- [ ] Verify: `bun run dev:server` starts without errors

---

### Task 3: Client — RPC client + migrate hooks + delete api.ts

**Files:**
- Create: `client/src/lib/rpc.ts`
- Modify: `client/src/hooks/queries.ts`
- Modify: ~15 component files with scattered fetch()
- Delete: `client/src/lib/api.ts`

- [ ] Create `rpc.ts` with `hc<AppType>("/")`
- [ ] Migrate all hooks in `queries.ts` to use RPC client
- [ ] Migrate scattered `fetch("/api/...")` calls in components
- [ ] Delete `api.ts`
- [ ] Verify: `cd client && bun run build` succeeds (tsc catches type errors)

---

### Task 4: Cleanup + Final Verification

- [ ] Remove dead code (withGameId helper, fetchJson, CatalogTune redefinition)
- [ ] `bun test` passes
- [ ] `bun run dev` — both server and client start
- [ ] Lint: `cd client && bun run lint`
