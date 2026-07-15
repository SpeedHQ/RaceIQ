import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { GameIdQuerySchema } from "../../shared/schemas";
import { IdParamSchema } from "../../shared/schemas";
import { getSessions, deleteSession, updateSession, countStaleSessions, getStaleSessions, getSessionRecapData } from "../db/queries";
import { reprocessSession } from "../reprocess";
import { LAP_DETECTOR_ID } from "../lap-detector";
import { LAP_DETECTOR_V2_ID } from "../lap-detector-acc";
import { LAP_DETECTOR_AC_EVO_ID } from "../lap-detector-ac-evo";
import { wsManager } from "../ws";
import { computeRecap } from "../recap";
import { tryGetGame } from "../../shared/games/registry";
import { getCarName, getTrackName } from "../../shared/car-data";

const ALL_DETECTOR_IDS = [LAP_DETECTOR_ID, LAP_DETECTOR_V2_ID, LAP_DETECTOR_AC_EVO_ID];

export const sessionRoutes = new Hono()
  // GET /api/sessions
  .get("/api/sessions", zValidator("query", GameIdQuerySchema), async (c) => {
    const { gameId } = c.req.valid("query");
    const sessionList = await getSessions(gameId);
    return c.json(sessionList);
  })

  // GET /api/sessions/:id/recap
  .get(
    "/api/sessions/:id/recap",
    zValidator("param", IdParamSchema),
    zValidator("query", GameIdQuerySchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { gameId } = c.req.valid("query");
      if (!gameId) return c.json({ error: "gameId is required" }, 400);

      const data = await getSessionRecapData(id, gameId);
      if (!data) return c.json({ error: "Session not found" }, 404);

      const adapter = tryGetGame(gameId);
      const carName = adapter ? adapter.getCarName(data.session.carOrdinal) : getCarName(data.session.carOrdinal, gameId);
      const trackName = adapter ? adapter.getTrackName(data.session.trackOrdinal) : getTrackName(data.session.trackOrdinal, gameId);

      const recap = computeRecap({
        session: data.session,
        laps: data.laps,
        carName,
        trackName,
        trackLengthM: data.trackLengthM,
        allTimeBestSec: data.allTimeBestSec,
      });
      return c.json(recap);
    },
  )

  // PATCH /api/sessions/:id/notes
  .patch(
    "/api/sessions/:id/notes",
    zValidator("param", IdParamSchema),
    zValidator("json", z.object({ notes: z.string().nullable() })),
    async (c) => {
      const { id } = c.req.valid("param");
      await updateSession(id, { notes: c.req.valid("json").notes });
      return c.json({ ok: true });
    },
  )

  // POST /api/sessions/:id/reprocess
  .post(
    "/api/sessions/:id/reprocess",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const result = await reprocessSession(id);
      wsManager.broadcastNotification({ type: "lap-reprocessed", ...result });
      const remaining = await countStaleSessions(ALL_DETECTOR_IDS);
      if (remaining === 0) wsManager.setStaleSessionsNotification(null);
      return c.json(result);
    },
  )

  // POST /api/sessions/reprocess-stale — reprocess all sessions with outdated lap detector
  .post("/api/sessions/reprocess-stale", async (c) => {
    const staleIds = await getStaleSessions(ALL_DETECTOR_IDS);
    const results = [];
    for (const id of staleIds) {
      const result = await reprocessSession(id);
      wsManager.broadcastNotification({ type: "lap-reprocessed", ...result });
      results.push(result);
    }
    wsManager.setStaleSessionsNotification(null);
    return c.json({ reprocessed: results.length, results });
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
