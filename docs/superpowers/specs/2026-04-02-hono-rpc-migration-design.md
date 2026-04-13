# Hono RPC Migration Design

**Date:** 2026-04-02
**Topic:** Migrate API layer to Hono RPC with end-to-end type safety

## Goal

Replace the manually-typed `api.ts` fetch wrapper layer and scattered `fetch()` calls with Hono's built-in RPC client (`hono/client`). Add Zod validation to all route inputs. Define proper TypeScript types for all API responses. The result: compile-time type safety from server handler to client component, zero codegen.

## Current State

- **78 route handlers** across `server/routes.ts` (66) and `server/routes/tune-routes.ts` (12)
- **`client/src/lib/api.ts`** — ~40 manually typed fetch wrappers with a generic `fetchJson<T>` helper
- **`client/src/hooks/queries.ts`** — TanStack Query hooks referencing `api.*` functions
- **Scattered raw `fetch()`** calls in Settings.tsx, TuneForm.tsx, Onboarding.tsx
- **Minimal input validation** — only 2 Zod schemas (`GameIdSchema`, `PartialSettingsSchema`), rest is manual `parseInt`/`isNaN`
- **Several `unknown` response types** — track sectors, outlines, grip/fuel/telemetry history, tracks list

## Architecture

### Server: Chained Sub-Routers with Zod Validation

Split `routes.ts` into domain-specific sub-routers. Each sub-router chains its routes (required for Hono RPC type inference) and uses `zValidator` for input validation.

**Sub-router structure:**

```
server/routes/
  lap-routes.ts         — /api/laps/*, /api/stats, /api/laps/:id/compare/:otherId
  session-routes.ts     — /api/sessions/*
  track-routes.ts       — /api/track-*/*,  /api/tracks/*
  settings-routes.ts    — /api/settings, /api/status, /api/wheels
  profile-routes.ts     — /api/profiles/*
  analysis-routes.ts    — /api/laps/:id/analyse, /api/laps/:id/analysis
  tune-routes.ts        — /api/tunes/*, /api/catalog/*, /api/tune-assignments/* (already exists, refactor)
  car-routes.ts         — /api/car-name/*, /api/cars
  misc-routes.ts        — /api/export, /api/forza-install, /api/grip-history, /api/fuel-history, /api/telemetry-history
```

**Main routes.ts chains sub-routers and exports AppType:**

```ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { lapRoutes } from "./routes/lap-routes";
// ...

const app = new Hono()
  .use("/*", cors())
  .route("/", lapRoutes)
  .route("/", sessionRoutes)
  .route("/", trackRoutes)
  .route("/", settingsRoutes)
  .route("/", profileRoutes)
  .route("/", analysisRoutes)
  .route("/", tuneRoutes)
  .route("/", carRoutes)
  .route("/", miscRoutes);

export type AppType = typeof app;
export { app };
```

**Sub-router pattern:**

```ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { IdParamSchema, GameIdQuerySchema } from "../../shared/schemas";

export const lapRoutes = new Hono()
  .get("/api/laps",
    zValidator("query", GameIdQuerySchema.extend({ profileId: z.coerce.number().optional() })),
    (c) => {
      const { profileId, gameId } = c.req.valid("query");
      return c.json(getLaps(profileId, gameId));
    }
  )
  .get("/api/laps/:id",
    zValidator("param", IdParamSchema),
    (c) => {
      const { id } = c.req.valid("param");
      const lap = getLapById(id);
      if (!lap) return c.json({ error: "Lap not found" }, 404);
      return c.json(lap);
    }
  )
  // ... chain all lap routes
```

### Shared Schemas

**`shared/schemas.ts`** — Common Zod schemas for input validation:

```ts
import { z } from "zod";
import { GameIdSchema } from "./types";

export const IdParamSchema = z.object({
  id: z.string().pipe(z.coerce.number().int().positive()),
});

export const OrdinalParamSchema = z.object({
  ord: z.string().pipe(z.coerce.number().int()),
});

export const GameIdQuerySchema = z.object({
  gameId: GameIdSchema.optional(),
});
```

Route-specific schemas live inline in the route file when only used once.

### Response Types

Define proper types in `shared/types.ts` for all currently-`unknown` responses. Exact shapes derived from server handler return values:

- `TrackOutlineData` — track outline points + metadata
- `TrackBoundaries` — left/right edges, centerline, pit lane
- `TrackCurb` — curb points with side
- `TrackSectorBoundaries` — s1End, s2End
- `AppStats` — aggregate statistics
- `TrackInfo` — track list entries
- `GripHistoryEntry`, `FuelHistoryEntry`, `TelemetryHistoryEntry` — history endpoints

Existing types (`LapMeta`, `SessionMeta`, `Tune`, `TuneAssignment`, `ComparisonData`, `TelemetryPacket`) are already well-defined and stay as-is.

### Client: RPC Client Replaces api.ts

**New `client/src/lib/rpc.ts`:**

```ts
import { hc } from "hono/client";
import type { AppType } from "../../server/routes";

export const client = hc<AppType>("/");
```

**Hooks migrate from `api.*` to `client.api.*`:**

```ts
// queries.ts
import { client } from "../lib/rpc";

export function useUserTunes() {
  return useQuery({
    queryKey: queryKeys.userTunes,
    queryFn: async () => {
      const res = await client.api.tunes.$get();
      if (!res.ok) throw new Error(res.statusText);
      return res.json();
    },
  });
}
```

**Query keys stay unchanged** — already well-structured in `queryKeys` object.

**Scattered `fetch()` calls** in Settings.tsx, TuneForm.tsx, Onboarding.tsx replaced with typed `client.api.*` calls.

**`api.ts` is deleted** after all references are migrated.

### What Doesn't Change

- API response shapes, URLs, and HTTP status codes stay identical
- WebSocket connection for live telemetry is unaffected
- TanStack Query cache keys and invalidation patterns stay the same
- CORS middleware stays
- Database layer untouched

## Dependencies

- `@hono/zod-validator` — new server dependency for `zValidator`
- `hono/client` — already available (part of `hono` package)

## Migration Phases

**Phase 1 — Foundation:** Create `shared/schemas.ts`, add missing response types to `shared/types.ts`

**Phase 2 — Server routes:** Split and migrate each sub-router with chaining + zValidator. Verify: `bun test` after each.

**Phase 3 — Client:** Create `rpc.ts`, migrate hooks and components, delete `api.ts`. Verify: `tsc` + `vite build`.

**Phase 4 — Cleanup:** Remove dead code, lint.

## Caveats

- **IDE performance:** 78 chained routes can slow TypeScript inference. Sub-routers mitigate this since each file's types resolve independently.
- **Path params are strings:** Zod validators coerce them, but the RPC client must pass strings. Use `z.coerce.number()` on the server side.
- **No `c.notFound()`:** Hono RPC can't infer types from `c.notFound()`. Use explicit `c.json({ error: "..." }, 404)` instead (already the pattern used).
- **Strict mode required:** Both server and client `tsconfig.json` must have `"strict": true` for RPC type inference.
