/**
 * Thin barrel for the tune route modules.
 *
 * The former ~1960-line router chain now lives in four modules:
 *   - tune-crud-routes.ts      — /api/tunes CRUD, setup-files, place-setup,
 *                                import(-file), clone, duplicate, auto
 *   - tune-chat-routes.ts      — /api/laps/:id/issues, /api/live-analysis,
 *                                /api/experiments/:id/chat (Setup Engineer)
 *   - experiment-routes.ts — /api/experiments lifecycle, tests, bases,
 *                                capture-setup, import-laps, head, actions,
 *                                undo, lap-metrics, trailing :id GET/PATCH
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
import { tuneCrudRoutes } from "./tune-crud-routes";
import { tuneChatRoutes } from "./tune-chat-routes";
import { experimentRoutes } from "./experiment-routes";
import { tuneCatalogRoutes } from "./tune-catalog-routes";

export const tuneRoutes = new Hono()
  .route("/", tuneCrudRoutes)
  .route("/", tuneChatRoutes)
  .route("/", experimentRoutes)
  .route("/", tuneCatalogRoutes);
