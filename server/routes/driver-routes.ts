/**
 * Driver profiling routes.
 *
 * `GET /api/drivers/profile` — deterministic fingerprint, no model call.
 * `GET /api/drivers/profile/runs` — run history and provider status.
 * `POST /api/drivers/profile/runs` — explicit run or retry.
 *
 * Driver Profile is global per selected game. There is no driver id: this app
 * is single-driver by design (issue #118), so "the driver" is whoever owns
 * the database.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { GameIdSchema } from "../../shared/types";
import { loadDriverProfile } from "../driver-profile/load";
import {
  getDriverProfileRunStatus,
  resolveDriverProfileScopeNames,
  runDriverProfile,
  type DriverProfileScope,
} from "../driver-profile/runner";

const ProfileQuerySchema = z.object({});
const RunsQuerySchema = z.object({
  runNow: z.coerce.boolean().optional().default(false),
  retry: z.coerce.boolean().optional().default(false),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

type Scope = DriverProfileScope;

export const driverRoutes = new Hono()
  .get("/api/drivers/profile", zValidator("query", ProfileQuerySchema), async (c) => {
    const gameId = c.req.header("x-game-id");
    const parsedGame = GameIdSchema.safeParse(gameId);
    if (!parsedGame.success) return c.json({ error: "Missing or unknown X-Game-Id header" }, 400);

    const scope: Scope = { gameId: parsedGame.data };
    const fingerprint = await loadDriverProfile(scope);
    const { gameName } = resolveDriverProfileScopeNames(scope);
    return c.json({ fingerprint, gameName });
  })
  .get("/api/drivers/profile/runs", zValidator("query", RunsQuerySchema), async (c) => {
    const gameId = c.req.header("x-game-id");
    const parsedGame = GameIdSchema.safeParse(gameId);
    if (!parsedGame.success) return c.json({ error: "Missing or unknown X-Game-Id header" }, 400);

    const { limit } = c.req.valid("query");
    const scope: Scope = { gameId: parsedGame.data };
    const { gameName } = resolveDriverProfileScopeNames(scope);
    return c.json({ scope, gameName, ...(await getDriverProfileRunStatus(scope, limit)) });
  })
  .post("/api/drivers/profile/runs", zValidator("query", RunsQuerySchema), async (c) => {
    const gameId = c.req.header("x-game-id");
    const parsedGame = GameIdSchema.safeParse(gameId);
    if (!parsedGame.success) return c.json({ error: "Missing or unknown X-Game-Id header" }, 400);

    const { runNow, retry } = c.req.valid("query");
    const scope: Scope = { gameId: parsedGame.data };
    if (!runNow && !retry) {
      return c.json({ error: "Specify runNow=true or retry=true.", state: "not-configured" }, 400);
    }
    const result = await runDriverProfile(scope, { force: true, trigger: retry ? "retry" : "manual" });
    const { gameName } = resolveDriverProfileScopeNames(scope);
    return c.json({
      scope,
      gameName,
      state: result.status,
      run: result.run,
      ...(result.summary ? { summary: result.summary } : {}),
      ...(result.fingerprint ? { fingerprint: result.fingerprint } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  });
