import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { GameIdSchema } from "@raceiq/shared/games/ids";
import { RacePlanInputSchema } from "@raceiq/shared/racing/live/race-plan";
import {
  createRacePlan,
  deleteRacePlan,
  getActiveRacePlan,
  InvalidRacePlanError,
  InvalidRacePlanSourceError,
  listRacePlans,
  RacePlanNotFoundError,
  RacePlanSourceNotFoundError,
  setActiveRacePlan,
  updateRacePlan,
} from "@raceiq/backend-core/db/race-plan-queries";

const PlanIdParam = z.object({ id: z.string().min(1).max(200) }).strict();
const GameQuery = z.object({ gameId: GameIdSchema }).strict();
const ActivePlanInput = z.object({ planId: z.string().min(1).max(200).nullable() }).strict();

function failure(error: unknown, c: Context) {
  if (error instanceof RacePlanNotFoundError) return c.json({ error: "Race plan not found", code: "RACE_PLAN_NOT_FOUND" }, 404);
  if (error instanceof RacePlanSourceNotFoundError) return c.json({ error: "Race plan source not found", code: "RACE_PLAN_SOURCE_NOT_FOUND" }, 404);
  if (error instanceof InvalidRacePlanError || error instanceof InvalidRacePlanSourceError) {
    return c.json({ error: "Invalid race plan", code: "INVALID_RACE_PLAN" }, 400);
  }
  throw error;
}

function validationHook(result: { success: boolean }, c: Context) {
  if (!result.success) return c.json({ error: "Invalid race plan", code: "INVALID_RACE_PLAN" }, 400);
}

export const racePlanRoutes = new Hono()
  .get("/api/race-plans/active", async (c): Promise<Response> => c.json({ plan: await getActiveRacePlan() }))
  .put("/api/race-plans/active", zValidator("json", ActivePlanInput, validationHook), async (c) => {
    try {
      return c.json({ plan: await setActiveRacePlan(c.req.valid("json").planId) });
    } catch (error) {
      return failure(error, c);
    }
  })
  .get("/api/race-plans", zValidator("query", GameQuery, validationHook), async (c) => {
    try {
      return c.json({ plans: await listRacePlans(c.req.valid("query").gameId) });
    } catch (error) {
      return failure(error, c);
    }
  })
  .post("/api/race-plans", zValidator("json", RacePlanInputSchema, validationHook), async (c) => {
    try {
      return c.json(await createRacePlan(c.req.valid("json")), 201);
    } catch (error) {
      return failure(error, c);
    }
  })
  .put("/api/race-plans/:id", zValidator("param", PlanIdParam, validationHook), zValidator("json", RacePlanInputSchema, validationHook), async (c) => {
    try {
      return c.json(await updateRacePlan(c.req.valid("param").id, c.req.valid("json")));
    } catch (error) {
      return failure(error, c);
    }
  })
  .delete("/api/race-plans/:id", zValidator("param", PlanIdParam, validationHook), async (c) => {
    const deleted = await deleteRacePlan(c.req.valid("param").id);
    return deleted ? c.json({ deleted: true }) : c.json({ error: "Race plan not found", code: "RACE_PLAN_NOT_FOUND" }, 404);
  });
