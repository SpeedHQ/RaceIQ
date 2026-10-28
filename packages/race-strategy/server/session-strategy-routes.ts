import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { IdParamSchema } from "@raceiq/shared/platform/http/route-schemas";
import { GameIdSchema } from "@raceiq/shared/games/ids";
import { clearStrategyHistory } from "@raceiq/backend-core/telemetry/live-pipeline";
import { wsManager } from "@raceiq/backend-core/runtime/websocket-manager";
import { getStrategyStints, getStrategyLapMetrics, getPitEstimatePage, strategySessionExists, InvalidStrategyCursorError } from "./strategy-queries";
import { getStrategyBaseline } from "./strategy-baseline-queries";

const strategyValidation = (result: { success: boolean }, c: Context) => {
  if (!result.success) return c.json({ code: "INVALID_STRATEGY_REQUEST", error: "Malformed strategy request" }, 400);
};

export const strategySessionRoutes = new Hono()
  .get("/api/sessions/:id/stints", zValidator("param", IdParamSchema, strategyValidation),
    zValidator("query", z.object({ driverKey: z.string().min(1).optional() }).strict(), strategyValidation), async (c) => {
    const id = c.req.valid("param").id;
    const game = GameIdSchema.safeParse(c.req.header("X-Game-Id"));
    if (!game.success) return c.json({ code: "INVALID_STRATEGY_REQUEST", error: "Valid X-Game-Id is required" }, 400);
    try {
      if (!await strategySessionExists(id, game.data)) return c.json({ code: "STRATEGY_NOT_FOUND", error: "Session not found" }, 404);
      return c.json({ stints: await getStrategyStints(id, c.req.valid("query").driverKey) });
    } catch {
      return c.json({ code: "STRATEGY_STORAGE_UNAVAILABLE", error: "Strategy storage unavailable" }, 503);
    }
  })
  .get("/api/sessions/:id/stint-lap-metrics", zValidator("param", IdParamSchema, strategyValidation),
    zValidator("query", z.object({ driverKey: z.string().min(1).optional() }).strict(), strategyValidation), async (c) => {
    const id = c.req.valid("param").id;
    const game = GameIdSchema.safeParse(c.req.header("X-Game-Id"));
    if (!game.success) return c.json({ code: "INVALID_STRATEGY_REQUEST", error: "Valid X-Game-Id is required" }, 400);
    try {
      if (!await strategySessionExists(id, game.data)) return c.json({ code: "STRATEGY_NOT_FOUND", error: "Session not found" }, 404);
      return c.json({ laps: await getStrategyLapMetrics(id, c.req.valid("query").driverKey) });
    } catch {
      return c.json({ code: "STRATEGY_STORAGE_UNAVAILABLE", error: "Strategy storage unavailable" }, 503);
    }
  })
  .get("/api/sessions/:id/pit-estimates", zValidator("param", IdParamSchema, strategyValidation), zValidator("query", z.object({
    driverKey: z.string().min(1).optional(), before: z.string().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
  }).strict(), strategyValidation), async (c) => {
    const id = c.req.valid("param").id;
    const game = GameIdSchema.safeParse(c.req.header("X-Game-Id"));
    if (!game.success) return c.json({ code: "INVALID_STRATEGY_REQUEST", error: "Valid X-Game-Id is required" }, 400);
    try {
      if (!await strategySessionExists(id, game.data)) return c.json({ code: "STRATEGY_NOT_FOUND", error: "Session not found" }, 404);
      const { driverKey, before, limit } = c.req.valid("query");
      return c.json(await getPitEstimatePage(id, game.data, driverKey, limit, before));
    } catch (error) {
      if (error instanceof InvalidStrategyCursorError) return c.json({ code: "INVALID_STRATEGY_REQUEST", error: "Cursor is invalid or stale; refresh history" }, 400);
      return c.json({ code: "STRATEGY_STORAGE_UNAVAILABLE", error: "Strategy storage unavailable" }, 503);
    }
  })
  .delete("/api/sessions/:id/pit-estimates", zValidator("param", IdParamSchema, strategyValidation),
    zValidator("json", z.object({ driverKey: z.string().min(1) }).strict(), strategyValidation), async (c) => {
    const id = c.req.valid("param").id;
    const game = GameIdSchema.safeParse(c.req.header("X-Game-Id"));
    if (!game.success) return c.json({ code: "INVALID_STRATEGY_REQUEST", error: "Valid X-Game-Id is required" }, 400);
    try {
      if (!await strategySessionExists(id, game.data)) return c.json({ code: "STRATEGY_NOT_FOUND", error: "Session not found" }, 404);
      const driverKey = c.req.valid("json").driverKey;
      const cleared = await clearStrategyHistory(id, driverKey);
      wsManager.broadcastNotification({ type: "strategy-estimates-cleared", gameId: game.data, sessionId: id, driverKey });
      return c.json({ cleared });
    } catch {
      return c.json({ code: "STRATEGY_STORAGE_UNAVAILABLE", error: "Strategy storage unavailable" }, 503);
    }
  })
  .get("/api/sessions/:id/strategy-baseline", zValidator("param", IdParamSchema, strategyValidation),
    zValidator("query", z.object({ stintId: z.string().min(1) }).strict(), strategyValidation), async (c) => {
    const id = c.req.valid("param").id;
    const game = GameIdSchema.safeParse(c.req.header("X-Game-Id"));
    if (!game.success) return c.json({ code: "INVALID_STRATEGY_REQUEST", error: "Valid X-Game-Id is required" }, 400);
    try {
      if (!await strategySessionExists(id, game.data)) return c.json({ code: "STRATEGY_NOT_FOUND", error: "Session not found" }, 404);
      const stint = (await getStrategyStints(id)).find((summary) => summary.id === c.req.valid("query").stintId);
      if (!stint) return c.json({ code: "STRATEGY_NOT_FOUND", error: "Stint not found" }, 404);
      return c.json({ baseline: await getStrategyBaseline(stint) });
    } catch {
      return c.json({ code: "STRATEGY_STORAGE_UNAVAILABLE", error: "Strategy storage unavailable" }, 503);
    }
  })
;
