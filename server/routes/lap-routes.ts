import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { IdParamSchema } from "../../shared/schemas";
import { GameIdSchema } from "../../shared/types";
import type { Tune } from "../../shared/types";
import {
  getLaps,
  getLapById,
  deleteLap,
  getCorners,
  saveCorners,
  getAnalysis,
  saveAnalysis,
} from "../db/queries";
import { getTuneById as getDbTune } from "../db/tune-queries";
import { generateExport } from "../export";
import { compareLaps } from "../comparison";
import { detectCorners } from "../corner-detection";
import { getTrackSectorsByOrdinal } from "../../shared/track-data";
import { getTrackOutlineSectors } from "../db/queries";
import type { GameId } from "../../shared/types";
import { loadSettings } from "../settings";
import { buildAnalystPrompt } from "../ai/analyst-prompt";

const CompareParamsSchema = z.object({
  id1: z.string().transform(val => parseInt(val, 10)),
  id2: z.string().transform(val => parseInt(val, 10)),
});

const LapsQuerySchema = z.object({
  profileId: z.coerce.number().optional(),
  gameId: GameIdSchema.optional(),
});

const AnalyseQuerySchema = z.object({
  regenerate: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

const BulkDeleteSchema = z.object({
  ids: z.array(z.number().int()),
});

export const lapRoutes = new Hono()
  // ── List laps ────────────────────────────────────────────────
  .get("/api/laps", zValidator("query", LapsQuerySchema), async (c) => {
    const { profileId, gameId } = c.req.valid("query");
    const lapList = await getLaps(profileId, gameId);
    return c.json(lapList);
  })

  // ── Bulk-delete by IDs (must precede :id routes) ────────────
  .post(
    "/api/laps/bulk-delete",
    zValidator("json", BulkDeleteSchema),
    async (c) => {
      const { ids } = c.req.valid("json");
      let count = 0;
      for (const id of ids) {
        if (await deleteLap(id)) count++;
      }
      return c.json({ deleted: count });
    }
  )

  // ── Get single lap ──────────────────────────────────────────
  .get("/api/laps/:id", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const lap = await getLapById(id);
    if (!lap) return c.json({ error: "Lap not found" }, 404);

    // Compute sector times server-side
    let sectorTimes: { times: [number, number, number]; s1Idx: number; s2Idx: number; firstDist: number; lapDist: number } | null = null;
    const packets = lap.telemetry;
    if (packets.length >= 10 && lap.trackOrdinal != null) {
      const dbSectors = lap.gameId ? await getTrackOutlineSectors(lap.trackOrdinal, lap.gameId as GameId) : null;
      const bundled = getTrackSectorsByOrdinal(lap.trackOrdinal);
      const sectors = dbSectors ?? bundled;
      if (sectors?.s1End && sectors?.s2End) {
        const firstDist = packets[0].DistanceTraveled;
        const lastDist = packets[packets.length - 1].DistanceTraveled;
        const lapDist = lastDist - firstDist;
        if (lapDist > 0) {
          let s1Time = 0, s2Time = 0, s1Idx = -1, s2Idx = -1;
          for (let i = 0; i < packets.length; i++) {
            const frac = (packets[i].DistanceTraveled - firstDist) / lapDist;
            if (s1Idx < 0 && frac >= sectors.s1End) {
              s1Idx = i;
              s1Time = packets[i].CurrentLap - packets[0].CurrentLap;
            }
            if (s2Idx < 0 && frac >= sectors.s2End) {
              s2Idx = i;
              s2Time = packets[i].CurrentLap - (s1Idx >= 0 ? packets[s1Idx].CurrentLap : packets[0].CurrentLap);
            }
          }
          const totalLapTime = lap.lapTime || (packets[packets.length - 1].CurrentLap - packets[0].CurrentLap);
          let s3Time = totalLapTime - s1Time - s2Time;
          if (s3Time < 0) s3Time = 0;
          sectorTimes = { times: [s1Time, s2Time, s3Time], s1Idx, s2Idx, firstDist, lapDist };
        }
      }
    }

    return c.json({ ...lap, sectorTimes });
  })

  // ── Export lap telemetry as text ────────────────────────────
  .get(
    "/api/laps/:id/export",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const lap = await getLapById(id);
      if (!lap) return c.json({ error: "Lap not found" }, 404);
      const packets = lap.telemetry;
      if (packets.length === 0)
        return c.json({ error: "No telemetry data" }, 400);
      const exportText = generateExport(lap, packets);
      return c.text(exportText);
    }
  )

  // ── AI analysis ─────────────────────────────────────────────
  .post(
    "/api/laps/:id/analyse",
    zValidator("param", IdParamSchema),
    zValidator("query", AnalyseQuerySchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { regenerate } = c.req.valid("query");

      if (!regenerate) {
        const cached = await getAnalysis(id);
        if (cached) {
          return c.json({
            analysis: cached.analysis,
            cached: true,
            usage: {
              inputTokens: cached.inputTokens,
              outputTokens: cached.outputTokens,
              costUsd: cached.costUsd,
              durationMs: cached.durationMs,
              model: cached.model,
            },
          });
        }
      }

      const lap = await getLapById(id);
      if (!lap) return c.json({ error: "Lap not found" }, 404);
      if (lap.telemetry.length === 0)
        return c.json({ error: "No telemetry data" }, 400);

      const trackOrdinal = lap.trackOrdinal ?? 0;
      const corners = trackOrdinal > 0 && lap.gameId ? await getCorners(trackOrdinal, lap.gameId) : [];
      const settings = loadSettings();

      let parsedTune: Tune | undefined;
      if (lap.tuneId) {
        const dbTune = await getDbTune(lap.tuneId);
        if (dbTune) {
          parsedTune = {
            ...dbTune,
            strengths: dbTune.strengths
              ? JSON.parse(dbTune.strengths)
              : [],
            weaknesses: dbTune.weaknesses
              ? JSON.parse(dbTune.weaknesses)
              : [],
            bestTracks: dbTune.bestTracks
              ? JSON.parse(dbTune.bestTracks)
              : [],
            strategies: dbTune.strategies
              ? JSON.parse(dbTune.strategies)
              : [],
            settings: JSON.parse(dbTune.settings),
          } as Tune;
        }
      }

      const prompt = buildAnalystPrompt(
        lap,
        lap.telemetry,
        corners,
        settings.unit,
        parsedTune
      );

      try {
        const { runClaudeCli, runGemini } = await import("../ai/providers");
        const { getSecret } = await import("../keystore");
        let result;
        if (settings.aiProvider === "gemini") {
          const apiKey = await getSecret("gemini-api-key");
          if (!apiKey) return c.json({ error: "Gemini API key not set. Add it in Settings → AI Analysis." }, 400);
          result = await runGemini(prompt, apiKey, settings.aiModel || undefined);
        } else {
          result = await runClaudeCli(prompt, settings.aiModel || undefined);
        }

        await saveAnalysis(id, result.analysis, result.usage);
        return c.json({ analysis: result.analysis, cached: false, usage: result.usage });
      } catch (err: any) {
        console.error("[AI] Analysis failed:", err.message);
        return c.json({ error: err.message }, err.message.includes("timed out") ? 504 : 500);
      }
    }
  )

  // ── Delete single lap ───────────────────────────────────────
  .delete(
    "/api/laps/:id",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const deleted = await deleteLap(id);
      if (!deleted) return c.json({ error: "Lap not found" }, 404);
      return c.json({ success: true });
    }
  )

  // ── Compare two laps ───────────────────────────────────────
  .get(
    "/api/laps/:id1/compare/:id2",
    zValidator("param", CompareParamsSchema),
    async (c) => {
      const { id1, id2 } = c.req.valid("param");
      if (id1 === id2)
        return c.json({ error: "Cannot compare a lap with itself" }, 400);

      const lapA = await getLapById(id1);
      if (!lapA) return c.json({ error: `Lap ${id1} not found` }, 404);

      const lapB = await getLapById(id2);
      if (!lapB) return c.json({ error: `Lap ${id2} not found` }, 404);

      if (lapA.telemetry.length === 0 || lapB.telemetry.length === 0)
        return c.json(
          { error: "One or both laps have no telemetry data" },
          400
        );

      const trackOrdinal = lapA.trackOrdinal ?? 0;
      let corners = lapA.gameId ? await getCorners(trackOrdinal, lapA.gameId) : [];

      if (corners.length === 0 && trackOrdinal > 0) {
        corners = detectCorners(lapA.telemetry);
        if (corners.length > 0 && lapA.gameId) await saveCorners(trackOrdinal, corners, lapA.gameId, true);
      }

      const result = compareLaps(lapA.telemetry, lapB.telemetry, corners);

      return c.json({
        lapA: {
          lapNumber: lapA.lapNumber,
          lapTime: lapA.lapTime,
          isValid: lapA.isValid,
          trackOrdinal: lapA.trackOrdinal,
          carOrdinal: lapA.carOrdinal,
        },
        lapB: {
          lapNumber: lapB.lapNumber,
          lapTime: lapB.lapTime,
          isValid: lapB.isValid,
          trackOrdinal: lapB.trackOrdinal,
          carOrdinal: lapB.carOrdinal,
        },
        traces: {
          distance: result.distances,
          speedA: result.lapA.speed,
          speedB: result.lapB.speed,
          throttleA: result.lapA.throttle,
          throttleB: result.lapB.throttle,
          brakeA: result.lapA.brake,
          brakeB: result.lapB.brake,
          rpmA: result.lapA.rpm,
          rpmB: result.lapB.rpm,
          tireWearA: result.lapA.tireWear,
          tireWearB: result.lapB.tireWear,
        },
        timeDelta: result.timeDelta,
        corners: result.cornerDeltas,
        telemetryA: lapA.telemetry,
        telemetryB: lapB.telemetry,
        gameId: lapA.gameId,
      });
    }
  )

  // ── Delete ALL laps ─────────────────────────────────────────
  .delete("/api/laps", async (c) => {
    const laps = await getLaps();
    let count = 0;
    for (const lap of laps) {
      if (await deleteLap(lap.id)) count++;
    }
    return c.json({ deleted: count });
  });
