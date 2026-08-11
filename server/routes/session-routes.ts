import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { GameIdQuerySchema, IdParamSchema } from "@shared/platform/http/route-schemas";
import { GameIdSchema } from "../../shared/games/ids";
import { getSessions, deleteSession, updateSession, countStaleSessions, getStaleSessions, getSessionRecapData } from "../db/session-queries";
import { getSessionResult, getStaleRaceResultSessionIds } from "../db/session-result-queries";
import { reprocessSession } from "../session-capture/reprocess";
import { LAP_DETECTOR_ID } from "../lap-detection/detector";
import { LAP_DETECTOR_ACC_ID } from "../games/acc/lap-detector";
import { LAP_DETECTOR_AC_EVO_ID } from "../games/ac-evo/lap-detector";
import { LAP_DETECTOR_IRACING_ID } from "../games/iracing/lap-detector";
import { wsManager } from "../runtime/websocket-manager";
import { computeRecap } from "../lap-analysis/recap";
import { tryGetGame } from "../../shared/games/registry";
import { resolveCarName } from "../../shared/racing/cars/resolve-name";
import { resolveTrackName } from "../../shared/racing/tracks/resolve-name";
import { backfillRaceResults, reconcileSessionResult, RACE_RESULT_PROCESSOR_ID } from "../race-results/reconcile";
import { getRaceResultAggregate, getRecentRaceResults } from "../race-results/aggregates";
import { getQualityRebuildStatus, rebuildSessionEligibility, type QualityRebuildStatus } from "../lap-analysis/quality-rebuild";
import { assessEvidenceRetention } from "../lap-analysis/evidence-retention";
import { getSessionCanonicalAvailability } from "../lap-analysis/canonical-archive-availability";
import { getLapsForSession } from "../db/lap-reprocessing-queries";

const ALL_DETECTOR_IDS = [LAP_DETECTOR_ID, LAP_DETECTOR_ACC_ID, LAP_DETECTOR_AC_EVO_ID, LAP_DETECTOR_IRACING_ID];

export const sessionRoutes = new Hono()
  .get("/api/sessions", zValidator("query", GameIdQuerySchema), async (c) => {
    const { gameId } = c.req.valid("query");
    return c.json(await getSessions(gameId));
  })
  .get("/api/sessions/:id/recap", zValidator("param", IdParamSchema), zValidator("query", GameIdQuerySchema), async (c) => {
    const { id } = c.req.valid("param");
    const { gameId } = c.req.valid("query");
    if (!gameId) return c.json({ error: "gameId is required" }, 400);
    const data = await getSessionRecapData(id, gameId);
    if (!data) return c.json({ error: "Session not found" }, 404);
    const adapter = tryGetGame(gameId);
    const carName = adapter ? adapter.getCarName(data.session.carOrdinal) : resolveCarName(data.session.carOrdinal, gameId);
    const trackName = adapter ? adapter.getTrackName(data.session.trackOrdinal) : resolveTrackName(data.session.trackOrdinal, gameId);
    return c.json(
      computeRecap({
        session: data.session,
        laps: data.laps,
        carName,
        trackName,
        trackLengthM: data.trackLengthM,
        allTimeBestSec: data.allTimeBestSec,
        allTimeBestSectors: data.allTimeBestSectors,
        sectorStarts: data.sectorStarts,
      }),
    );
  })
  .get("/api/sessions/:id/result", zValidator("param", IdParamSchema), zValidator("query", GameIdQuerySchema), async (c) => {
    const { id } = c.req.valid("param");
    const { gameId } = c.req.valid("query");
    if (!gameId) return c.json({ error: "gameId is required" }, 400);
    const result = await getSessionResult(id, gameId);
    if (!result) return c.json({ error: "Session result unavailable", outcomeStatus: "unavailable" as const }, 404);
    return c.json(result);
  })
  .post(
    "/api/race-results/backfill",
    zValidator("json", z.object({ gameId: GameIdSchema, limit: z.number().int().min(1).max(100).default(25), afterSessionId: z.number().int().optional() })),
    async (c) => c.json(await backfillRaceResults(c.req.valid("json"))),
  )
  .post("/api/race-results/reconcile-stale", async (c) => {
    const staleIds = await getStaleRaceResultSessionIds(RACE_RESULT_PROCESSOR_ID);
    const total = staleIds.length;
    const results = [];
    let failed = false;
    for (let index = 0; index < staleIds.length; index += 1) {
      const sessionId = staleIds[index]!;
      try {
        const session = (await getSessions()).find((candidate) => candidate.id === sessionId);
        if (!session?.gameId) throw new Error(`Session ${sessionId} has no game`);
        const result = await reconcileSessionResult(sessionId, session.gameId);
        results.push(result);
        if (result.status === "error") failed = true;
        wsManager.broadcastNotification({ type: "race-result-reconciled", sessionId, done: index + 1, total, status: result.status });
      } catch (error) {
        failed = true;
        results.push({ sessionId, status: "error" as const, eventCount: 0, reasons: [error instanceof Error ? error.message : "unknown-error"] });
        wsManager.broadcastNotification({ type: "race-result-reconciled", sessionId, done: index + 1, total, status: "error" });
      }
    }
    if (!failed) wsManager.setStaleRaceResultsNotification(null);
    return c.json({ reprocessed: results.filter((result) => result.status !== "error").length, results });
  })
  .get(
    "/api/race-results/summary",
    zValidator("query", z.object({ gameId: GameIdSchema, carOrdinal: z.coerce.number().int().optional(), trackOrdinal: z.coerce.number().int().optional() })),
    async (c) => c.json(await getRaceResultAggregate(c.req.valid("query"))),
  )
  .get("/api/race-results/recent", zValidator("query", z.object({ gameId: GameIdSchema, limit: z.coerce.number().int().min(1).max(50).default(10) })), async (c) =>
    c.json(await getRecentRaceResults(c.req.valid("query").gameId, c.req.valid("query").limit)),
  )
  .get("/api/sessions/:id/evidence-retention", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const canonicalArchive = await getSessionCanonicalAvailability(id);
    if (!canonicalArchive) return c.json({ error: "Session not found" }, 404);

    const status = await getQualityRebuildStatus(id, ALL_DETECTOR_IDS);
    return c.json(
      await assessEvidenceRetention(id, {
        rawCapture: status.rawAvailable,
        canonicalArchive,
      }),
    );
  })
  .get("/api/sessions/:id/quality", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    let status: QualityRebuildStatus;
    try {
      status = await getQualityRebuildStatus(id, ALL_DETECTOR_IDS);
    } catch {
      return c.json({ error: "Session not found" }, 404);
    }
    const laps = await getLapsForSession(id);
    return c.json({
      ...status,
      laps: laps.map((lap) => ({
        id: lap.id,
        lapNumber: lap.lapNumber,
        quality: lap.quality,
        eligibility: lap.eligibility,
        qualityGeneration: lap.qualityGeneration,
      })),
    });
  })
  .post("/api/sessions/:id/quality/rebuild", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const status = await getQualityRebuildStatus(id, ALL_DETECTOR_IDS);
    if (status.action === "unavailable") {
      return c.json({ error: "Source recording unavailable", status }, 409);
    }
    if (status.action === "reprocess") {
      const result = await reprocessSession(id);
      wsManager.broadcastNotification({ type: "quality-updated", sessionId: id });
      return c.json({ strategy: "reprocess" as const, status: await getQualityRebuildStatus(id, ALL_DETECTOR_IDS), result });
    }
    const rebuilt = await rebuildSessionEligibility(id);
    wsManager.broadcastNotification({ type: "quality-updated", sessionId: id });
    return c.json({ strategy: status.action === "current" ? ("none" as const) : ("eligibility" as const), status: rebuilt });
  })
  .patch("/api/sessions/:id/notes", zValidator("param", IdParamSchema), zValidator("json", z.object({ notes: z.string().nullable() })), async (c) => {
    const { id } = c.req.valid("param");
    await updateSession(id, { notes: c.req.valid("json").notes });
    return c.json({ ok: true });
  })
  .post("/api/sessions/:id/reprocess", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const result = await reprocessSession(id);
    wsManager.broadcastNotification({ type: "lap-reprocessed", ...result });
    const remaining = await countStaleSessions(ALL_DETECTOR_IDS);
    if (remaining === 0) wsManager.setStaleSessionsNotification(null);
    return c.json(result);
  })
  .post("/api/sessions/reprocess-stale", async (c) => {
    const staleIds = await getStaleSessions(ALL_DETECTOR_IDS);
    const results = [];
    for (const id of staleIds) {
      const status = await getQualityRebuildStatus(id, ALL_DETECTOR_IDS);
      if (status.action === "reprocess") {
        const result = await reprocessSession(id);
        wsManager.broadcastNotification({ type: "lap-reprocessed", ...result });
        results.push({ sessionId: id, strategy: "reprocess" as const, result });
      } else if (status.action === "rebuild_eligibility") {
        const result = await rebuildSessionEligibility(id);
        wsManager.broadcastNotification({ type: "quality-updated", sessionId: id });
        results.push({ sessionId: id, strategy: "eligibility" as const, result });
      } else {
        results.push({ sessionId: id, strategy: status.action, result: status });
      }
    }
    wsManager.setStaleSessionsNotification(null);
    return c.json({ reprocessed: results.filter(({ strategy }) => strategy === "reprocess").length, results });
  })
  .post("/api/sessions/bulk-delete", zValidator("json", z.object({ ids: z.array(z.number().int()) })), async (c) => {
    const { ids } = c.req.valid("json");
    let lapCount = 0;
    for (const sessionId of ids) lapCount += await deleteSession(sessionId);
    return c.json({ deleted: lapCount, sessions: ids.length });
  });
