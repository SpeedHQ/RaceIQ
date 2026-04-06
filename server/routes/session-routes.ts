import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { GameIdQuerySchema } from "../../shared/schemas";
import { getSessions, deleteSession } from "../db/queries";

export const sessionRoutes = new Hono()
  // GET /api/sessions
  .get("/api/sessions", zValidator("query", GameIdQuerySchema), async (c) => {
    const { gameId } = c.req.valid("query");
    const sessionList = await getSessions(gameId);
    return c.json(sessionList);
  })

  // POST /api/sessions/bulk-delete
  .post(
    "/api/sessions/bulk-delete",
    zValidator("json", z.object({ ids: z.array(z.number().int()) })),
    async (c) => {
      const { ids } = c.req.valid("json");
      let lapCount = 0;
      for (const sessionId of ids) {
        lapCount += await deleteSession(sessionId);
      }
      return c.json({ deleted: lapCount, sessions: ids.length });
    },
  );
