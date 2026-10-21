import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { GameIdQuerySchema, IdParamSchema } from "@raceiq/shared/platform/http/route-schemas";
import { GameIdSchema } from "@raceiq/shared/games/ids";
import { getSessions, deleteSession, updateSession, updateSessionCarTrack, countStaleSessions, getStaleSessions, getSessionRecapData, setSessionFavorite, SessionCaptureActiveError } from "@raceiq/backend-core/db/session-queries";
import { reprocessSession, SessionNotFoundError, SessionRawFileMissingError } from "@raceiq/backend-core/session-capture/reprocess";
import {
  getClassificationMigrationStatus,
  listClassificationMigrationRecordings,
  retryClassificationMigrationRecording,
} from "@raceiq/backend-core/session-capture/classification-migration";
import { getSessionResult, getStaleRaceResultSessionIds } from "@raceiq/backend-core/db/session-result-queries";
import { LAP_DETECTOR_ID } from "@raceiq/backend-core/lap-detection/detector";
import { LAP_DETECTOR_ACC_ID } from "@raceiq/game-acc/lap-detector";
import { LAP_DETECTOR_AC_EVO_ID } from "@raceiq/game-ac-evo/lap-detector";
import { LAP_DETECTOR_IRACING_ID } from "@raceiq/game-iracing/lap-detector";
import { getAllServerGames } from "@raceiq/backend-core/games/registry";
import { wsManager } from "@raceiq/backend-core/runtime/websocket-manager";
import { computeRecap } from "@raceiq/backend-core/lap-analysis/recap";
import { tryGetGame } from "@raceiq/shared/games/registry";
import { backfillRaceResults, reconcileSessionResult, RACE_RESULT_PROCESSOR_ID } from "@raceiq/backend-core/race-results/reconcile";
import { getRaceResultAggregate, getRecentRaceResults } from "@raceiq/backend-core/race-results/aggregates";
import { recoverDeletedSessions, clearStrategyHistory } from "@raceiq/backend-core/telemetry/live-pipeline";
import { getLapById } from "@raceiq/backend-core/db/lap-read-queries";
import { getLapReplaySource } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { resolveTelemetryReplay } from "@raceiq/backend-core/telemetry/replay";
import { loadRawCaptureIdentity } from "@raceiq/backend-core/session-capture/identity";

import { resolveCarName } from "@raceiq/game-catalogs/racing/cars/resolve-name";
import { resolveTrackName } from "@raceiq/game-catalogs/racing/tracks/resolve-name";
import { isSessionIdentityInCatalog } from "../games/session-identity";
import type { SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { getStrategyStints, getPitEstimatePage, strategySessionExists, InvalidStrategyCursorError } from "@raceiq/backend-core/db/strategy-queries";
import { getStrategyBaseline } from "@raceiq/backend-core/db/strategy-baseline-queries";
const ALL_DETECTOR_IDS = [LAP_DETECTOR_ID, LAP_DETECTOR_ACC_ID, LAP_DETECTOR_AC_EVO_ID, LAP_DETECTOR_IRACING_ID];


const strategyValidation = (result: { success: boolean }, c: Context) => {
  if (!result.success) return c.json({ code: "INVALID_STRATEGY_REQUEST", error: "Malformed strategy request" }, 400);
};

export const sessionRoutes = new Hono()
  .use("/api/sessions/:id/*", async (c, next) => {
    await next();
    if (c.res.status === 400 && /\/(stints|pit-estimates|strategy-baseline)$/.test(c.req.path)) {
      const response = await c.res.clone().json().catch(() => null);
      if (!response || typeof response !== "object" || !("code" in response)) {
        return c.json({ code: "INVALID_STRATEGY_REQUEST", error: "Malformed strategy request" }, 400);
      }
    }
  })
  .get("/api/sessions/classification-migration-status", async (c) =>
    c.json(await getClassificationMigrationStatus()))

  .get("/api/sessions/classification-migration-recordings", async (c) => {
    const query = c.req.query();
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return c.json({ error: "limit must be an integer from 1 to 100" }, 400);
    try {
      const result = await listClassificationMigrationRecordings(limit, query.cursor);
      if (!result) return c.json({ error: "stale snapshot cursor" }, 409);
      return c.json(result);
    } catch {
      return c.json({ error: "invalid cursor" }, 400);
    }
  })
  .post("/api/sessions/classification-migration-retry", zValidator("json", z.object({ recordingId: z.string().min(1) }).strict(), (result, c) => {
    if (!result.success) return c.json({ error: "Invalid retry request" }, 400);
  }), async (c) => {
    const { recordingId } = c.req.valid("json");
    const state = await retryClassificationMigrationRecording(recordingId);
    if (!state) return c.json({ error: "Recording not found" }, 404);
    const status = await getClassificationMigrationStatus();
    wsManager.setClassificationMigrationStatusNotification({ type: "classification-migration-status", ...status });
    return c.json({ recordingId, state }, 202);
  })
  .get("/api/sessions", zValidator("query", GameIdQuerySchema), async (c) => {
    const { gameId } = c.req.valid("query");
    return c.json<SessionMeta[]>(await getSessions(gameId));
  })
  .get("/api/sessions/:id/recap", zValidator("param", IdParamSchema), zValidator("query", GameIdQuerySchema), async (c) => {
    const { id } = c.req.valid("param");
    const { gameId } = c.req.valid("query");
    if (!gameId) return c.json({ error: "gameId is required" }, 400);
    const data = await getSessionRecapData(id, gameId);
    if (!data) return c.json({ error: "Session not found" }, 404);
    const adapter = tryGetGame(gameId);
    const carId = data.session.carId ?? "";
    const trackId = data.session.trackId ?? "";
    const carName = adapter ? adapter.getCarName(carId) : resolveCarName(carId, gameId);
    const trackName = adapter ? adapter.getTrackName(trackId) : resolveTrackName(trackId, gameId);
    const recap = computeRecap({ session: data.session, laps: data.laps, carName, trackName, trackLengthM: data.trackLengthM, allTimeBestSec: data.allTimeBestSec, allTimeBestSectors: data.allTimeBestSectors, sectorStarts: data.sectorStarts });
    const weatherLapId = recap.bestLapId ?? data.laps[0]?.id;
    let weather: { kind: number | null; rainPercent: number | null } | null = null;
    if (weatherLapId != null && (gameId === "f1-2025" || gameId === "iracing" || gameId === "lmu")) {
      const [lap, source] = await Promise.all([getLapById(weatherLapId), getLapReplaySource(weatherLapId)]);
      const packet = lap?.telemetry[0];
      if (packet && source && !lap?.parseError) {
        const rawCapture = gameId === "iracing" && source.rawFile ? await loadRawCaptureIdentity(source.rawFile) : undefined;
        const values = resolveTelemetryReplay(weatherLapId, source, [packet], ["weather.weather-type", "weather.rain-percent"], rawCapture).envelopes[0]?.values;
        const number = (id: string) => {
          const value = values?.find((entry) => entry.semanticId === id);
          return value?.state === "ok" && typeof value.value === "number" && Number.isFinite(value.value) ? value.value : null;
        };
        // F1 and LMU normalize their observed conditions to the six weather categories.
        const category = values?.find((entry) => entry.semanticId === "weather.weather-type");
        const kind = (gameId === "f1-2025" || gameId === "lmu") && category?.state === "ok" && typeof category.value === "string" && /^[0-5]$/.test(category.value) ? Number(category.value) : null;
        const rainPercent = number("weather.rain-percent");
        if (kind != null || rainPercent != null) weather = { kind, rainPercent };
      }
    }
    recap.weather = weather;
    return c.json(recap);
  })
  .get("/api/sessions/:id/result", zValidator("param", IdParamSchema), zValidator("query", GameIdQuerySchema), async (c) => {
    const { id } = c.req.valid("param");
    const { gameId } = c.req.valid("query");
    if (!gameId) return c.json({ error: "gameId is required" }, 400);
    const result = await getSessionResult(id, gameId);
    if (!result) return c.json({ error: "Session result unavailable", outcomeStatus: "unavailable" as const }, 404);
    return c.json(result);
  })
  .post("/api/race-results/backfill", zValidator("json", z.object({ gameId: GameIdSchema, limit: z.number().int().min(1).max(100).default(25), afterSessionId: z.number().int().optional() })), async (c) => c.json(await backfillRaceResults(c.req.valid("json"))))
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
  .get("/api/race-results/summary", zValidator("query", z.object({
    gameId: GameIdSchema,
    carId: z.string().min(1).optional(),
    trackId: z.string().min(1).optional(),
  })), async (c) => c.json(await getRaceResultAggregate(c.req.valid("query"))))
  .get("/api/race-results/recent", zValidator("query", z.object({ gameId: GameIdSchema, limit: z.coerce.number().int().min(1).max(50).default(10) })), async (c) => c.json(await getRecentRaceResults(c.req.valid("query").gameId, c.req.valid("query").limit)))
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
  .patch("/api/sessions/:id/identity", zValidator("param", IdParamSchema), zValidator("json", z.object({
    gameId: GameIdSchema,
    carId: z.string().min(1),
    trackId: z.string().min(1),
  }).strict()), async (c) => {
    const { id } = c.req.valid("param");
    const { gameId, carId, trackId } = c.req.valid("json");
    const session = (await getSessions(gameId)).find((candidate) => candidate.id === id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!isSessionIdentityInCatalog(gameId, carId, trackId)) {
      return c.json({ error: "Car or track ID is not in the selected game's catalog" }, 400);
    }
    if (!await updateSessionCarTrack(id, carId, trackId)) return c.json({ error: "Session not found" }, 404);
    return c.json({ ok: true, sessionId: id, carId, trackId });
  })
  .patch("/api/sessions/:id/notes", zValidator("param", IdParamSchema), zValidator("json", z.object({ notes: z.string().nullable() })), async (c) => {
    const { id } = c.req.valid("param");
    await updateSession(id, { notes: c.req.valid("json").notes });
    return c.json({ ok: true });
  })
  .patch("/api/sessions/:id/favorite", zValidator("param", IdParamSchema), zValidator("json", z.object({ favorite: z.boolean() }).strict()), async (c) => {
    const { id } = c.req.valid("param");
    const { favorite } = c.req.valid("json");
    if (!await setSessionFavorite(id, favorite)) return c.json({ error: "Session not found" }, 404);
    return c.json({ ok: true, sessionId: id, favorite });
  })
  .post("/api/sessions/:id/reprocess", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    try {
      const result = await reprocessSession(id);
      wsManager.broadcastNotification({ type: "lap-reprocessed", ...result });
      const remaining = await countStaleSessions(
        ALL_DETECTOR_IDS,
        getAllServerGames().map((adapter) => adapter.id),
      );
      if (remaining === 0) wsManager.setStaleSessionsNotification(null);
      return c.json(result);
    } catch (error) {
      if (error instanceof SessionRawFileMissingError) {
        return c.json({ error: error.message }, 410);
      }
      if (error instanceof SessionNotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  })
  .post("/api/sessions/reprocess-stale", async (c) => {
    const staleIds = await getStaleSessions(
      ALL_DETECTOR_IDS,
      getAllServerGames().map((adapter) => adapter.id),
    );
    const results = [];
    const skipped: { sessionId: number; reason: "raw-file-missing" }[] = [];
    for (const id of staleIds) {
      try {
        const result = await reprocessSession(id);
        wsManager.broadcastNotification({ type: "lap-reprocessed", ...result });
        results.push(result);
      } catch (error) {
        if (!(error instanceof SessionRawFileMissingError)) throw error;
        console.warn(`[Reprocess] Skipping session ${id}: ${error.message}`);
        skipped.push({ sessionId: id, reason: "raw-file-missing" });
      }
    }
    wsManager.setStaleSessionsNotification(null);
    return c.json({ reprocessed: results.length, skipped, results });
  })
  .post("/api/sessions/bulk-delete", zValidator("json", z.object({ ids: z.array(z.number().int()) })), async (c) => {
    const { ids } = c.req.valid("json");
    await recoverDeletedSessions(ids);
    let lapCount = 0;
    let deletedSessions = 0;
    try {
      for (const sessionId of ids) {
        lapCount += await deleteSession(sessionId);
        deletedSessions++;
      }
    } catch (error) {
      if (error instanceof SessionCaptureActiveError) {
        return c.json({ error: error.message, deleted: lapCount, sessions: deletedSessions }, 409);
      }
      throw error;
    }
    return c.json({ deleted: lapCount, sessions: ids.length });
  });
