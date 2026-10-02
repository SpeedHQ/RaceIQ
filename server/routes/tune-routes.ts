/**
 * Thin barrel for the tune route modules.
 *
 * The former ~1960-line router chain now lives in four modules:
 *   - tunes/                  — /api/tunes CRUD, setup-files, place-setup,
 *                               import(-file), clone, duplicate, auto
 *   - tune-chat-routes.ts      — /api/laps/:id/issues, /api/live-analysis,
 *                                /api/experiments/:id/chat (Setup Engineer)
 *   - experiments/            — /api/experiments lifecycle, versions, laps,
 *                                history, comparison, trailing :id GET/PATCH
 *   - tune-catalog-routes.ts   — /api/catalog/tunes, community refresh,
 *                                laptimes, tune-assignments, /api/laps/:id/tune
 * Shared helpers/schemas live in tune-shared.ts.
 *
 * Mount order preserves the original registration order so literal routes
 * (e.g. /api/tunes/setup-files) keep matching before param routes
 * (/api/tunes/:id), and /api/experiments/:id/chat before the trailing
 * /api/experiments/:id. The `.route("/", …)` chain keeps the combined
 * type flowing for Hono RPC client inference.
 */
import { Hono } from "hono";
import { tuneCrudRoutes } from "./tunes";
import { tuneChatRoutes } from "./tune-chat-routes";
import { experimentRoutes } from "./experiments";
import { tuneCatalogRoutes } from "./tune-catalog-routes";

export const tuneRoutes = new Hono()
  .route("/", tuneCrudRoutes)
  .route("/", tuneChatRoutes)
  .route("/", experimentRoutes)
  .route("/", tuneCatalogRoutes);
