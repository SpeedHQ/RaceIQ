import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { GameIdQuerySchema, IdParamSchema } from "../../shared/http/route-schemas";
import { GameIdSchema } from "../../shared/games/ids";
import { getSessions, deleteSession, updateSession, countStaleSessions, getStaleSessions, getSessionRecapData } from "../db/session-queries";
import { getSessionResult } from "../db/session-result-queries";
import { reprocessSession } from "../session-capture/reprocess";
import { LAP_DETECTOR_ID } from "../lap-detection/detector";
import { LAP_DETECTOR_ACC_ID } from "../games/acc/lap-detector";
import { LAP_DETECTOR_AC_EVO_ID } from "../games/ac-evo/lap-detector";
import { LAP_DETECTOR_IRACING_ID } from "../games/iracing/lap-detector";
import { wsManager } from "../runtime/websocket-manager";
import { computeRecap } from "../lap-analysis/recap";
import { tryGetGame } from "../../shared/games/registry";
import { resolveCarName } from "../../shared/car/resolve-name";
import { resolveTrackName } from "../../shared/track/resolve-name";
import { backfillRaceResults } from "../race-results/reconcile";
import { getRaceResultAggregate, getRecentRaceResults } from "../race-results/aggregates";

const ALL_DETECTOR_IDS = [
  LAP_DETECTOR_ID,
  LAP_DETECTOR_ACC_ID,
  LAP_DETECTOR_AC_EVO_ID,
  LAP_DETECTOR_IRACING_ID,
];

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
      const carName = adapter ? adapter.getCarName(data.session.carOrdinal) : resolveCarName(data.session.carOrdinal, gameId);
      const trackName = adapter ? adapter.getTrackName(data.session.trackOrdinal) : resolveTrackName(data.session.trackOrdinal, gameId);

      const recap = computeRecap({
        session: data.session,
        laps: data.laps,
        carName,
        trackName,
        trackLengthM: data.trackLengthM,
        allTimeBestSec: data.allTimeBestSec,
        allTimeBestSectors: data.allTimeBestSectors,
        sectorStarts: data.sectorStarts,
      });
      return c.json(recap);
    },
  )

  // GET /api/sessions/:id/result
  .get(
    "/api/sessions/:id/result",
    zValidator("param", IdParamSchema),
    zValidator("query", GameIdQuerySchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { gameId } = c.req.valid("query");
      if (!gameId) return c.json({ error: "gameId is required" }, 400);
      const result = await getSessionResult(id, gameId);
      if (!result) {
        return c.json({ error: "Session result unavailable", outcomeStatus: "unavailable" as const }, 404);
      }
      return c.json(result);
    },
  )

  // POST /api/race-results/backfill
  .post(
    "/api/race-results/backfill",
    zValidator(
      "json",
      z.object({ gameId: GameIdSchema, limit: z.number().int().min(1).max(100).default(25), afterSessionId: z.number().int().optional() }),
    ),
    async (c) => c.json(await backfillRaceResults(c.req.valid("json"))),
  )
  // GET /api/race-results/summary
  .get(
    "/api/race-results/summary",
    zValidator(
      "query",
      z.object({
        gameId: GameIdSchema,
        carOrdinal: z.coerce.number().int().optional(),
        trackOrdinal: z.coerce.number().int().optional(),
      }),
    ),
    async (c) => c.json(await getRaceResultAggregate(c.req.valid("query"))),
  )


  // GET /api/race-results/recent
  .get(
    "/api/race-results/recent",
    zValidator("query", z.object({ gameId: GameIdSchema, limit: z.coerce.number().int().min(1).max(50).default(10) })),
    async (c) => c.json(await getRecentRaceResults(c.req.valid("query").gameId, c.req.valid("query").limit)),
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
