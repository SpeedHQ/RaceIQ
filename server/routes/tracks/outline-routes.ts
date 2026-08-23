import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { OrdinalParamSchema, GameIdQuerySchema } from "@shared/platform/http/route-schemas";
import { eligibilityDecisionText } from "@shared/racing/quality/display";
import { isEligibilityUsable, isTimedLapEligibilityUsable, resolveEligibilityDecision } from "@shared/racing/quality/policies";
import { getLaps, getLapMetaById } from "../../db/lap-read-queries";
import { deleteRecordedOutline, getStartYaw, recordLapTrace } from "../../../shared/racing/tracks/recording/outlines";
import { getTrackAltitudeByOrdinal } from "../../../shared/racing/tracks/geometry/extracted";
import { filterLapOutliers, normalizeToFixedPoints, averageOutlines, smoothOutline } from "../../lap-detection/detector";
import type { GameId } from "../../../shared/games/ids";
import { CANONICAL_LAP_ANALYSIS_SEMANTIC_IDS } from "../../../shared/racing/analysis/laps/semantic-frame";
import { computeLapSectors } from "../../lap-analysis/sectors";
import { queryLapTelemetryBySemanticId } from "../../telemetry/replay";
import { semanticNumber, semanticSamplesFromReplay } from "../../telemetry/semantic-samples";
import { requireGameId, resolveTrackOutline, TRACK_OUTLINE_SEMANTIC_IDS, TrackOrdinalParamSchema } from "./support";

export const trackRecomputeOutlineRoutes = new Hono()

  // POST /api/tracks/:trackOrdinal/recompute-outline — rebuild outline from stored laps
  .post("/api/tracks/:trackOrdinal/recompute-outline", zValidator("param", TrackOrdinalParamSchema), async (c) => {
    const { trackOrdinal } = c.req.valid("param");
    const gameId = requireGameId(c);

    // Check for ?lapId= query param to use a single lap directly
    const lapIdParam = new URL(c.req.url).searchParams.get("lapId");

    if (lapIdParam) {
      // Single lap mode — use its telemetry directly as the outline
      const lapId = parseInt(lapIdParam, 10);
      const lapData = await getLapMetaById(lapId);
      if (!lapData || lapData.gameId !== gameId || lapData.trackOrdinal !== trackOrdinal || lapData.ownership !== "mine" || lapData.lapTime <= 0) {
        return c.json({ error: `Lap ${lapId} not found` }, 404);
      }
      const decision = resolveEligibilityDecision(lapData, "corner-trace");
      if (!isEligibilityUsable(decision)) {
        return c.json({ error: eligibilityDecisionText(decision), decision }, 422);
      }

      const replay = await queryLapTelemetryBySemanticId(lapData.id, TRACK_OUTLINE_SEMANTIC_IDS);
      if (!replay) return c.json({ error: "Lap telemetry not found" }, 404);
      const raw: { x: number; z: number }[] = [];
      for (const sample of semanticSamplesFromReplay(replay)) {
        const x = semanticNumber(sample, "motion.position-x");
        const z = semanticNumber(sample, "motion.position-z");
        if (x != null && z != null && (x !== 0 || z !== 0)) raw.push({ x, z });
      }
      if (raw.length < 50) {
        return c.json({ error: "Not enough telemetry data" }, 400);
      }

      // Light smoothing to clean up noise while preserving shape
      const outline = smoothOutline(raw, 5);

      recordLapTrace(trackOrdinal, outline, null, null, gameId);
      return c.json({
        success: true,
        lapsUsed: 1,
        lapId,
        points: outline.length,
        message: `Saved outline from lap ${lapId} (${outline.length} points)`,
      });
    }

    // Multi-lap mode — average best laps
    const allLaps = (await getLaps(gameId)).filter((lap) => lap.gameId === gameId && lap.trackOrdinal === trackOrdinal && lap.ownership === "mine" && isTimedLapEligibilityUsable(lap, "corner-trace"));
    if (allLaps.length === 0) {
      return c.json({ error: "No laps found for this track" }, 404);
    }

    const sortedLaps = [...allLaps].sort((a, b) => a.lapTime - b.lapTime);
    const bestLaps = sortedLaps.slice(0, 10);

    const rawLaps: { x: number; z: number; speed: number }[][] = [];
    const startPositions: { x: number; z: number }[] = [];

    for (const lapMeta of bestLaps) {
      const lapData = await getLapMetaById(lapMeta.id);
      if (!lapData || lapData.gameId !== gameId || lapData.trackOrdinal !== trackOrdinal || lapData.ownership !== "mine" || !isTimedLapEligibilityUsable(lapData, "corner-trace")) {
        continue;
      }
      const replay = await queryLapTelemetryBySemanticId(lapData.id, TRACK_OUTLINE_SEMANTIC_IDS);
      if (!replay) continue;
      const raw: { x: number; z: number; speed: number }[] = [];
      for (const sample of semanticSamplesFromReplay(replay)) {
        const x = semanticNumber(sample, "motion.position-x");
        const z = semanticNumber(sample, "motion.position-z");
        const speed = semanticNumber(sample, "motion.speed");
        if (x != null && z != null && speed != null && (x !== 0 || z !== 0)) raw.push({ x, z, speed });
      }
      const filtered = filterLapOutliers(raw);
      if (filtered.length < 50) continue;
      rawLaps.push(filtered);
      const last = filtered[filtered.length - 1];
      startPositions.push({ x: last.x, z: last.z });
    }

    // Normalize all laps to the same point count (max raw count) for averaging
    const maxPoints = Math.max(...rawLaps.map((l) => l.length));
    const normalized = rawLaps.map((l) => (l.length === maxPoints ? l : normalizeToFixedPoints(l, maxPoints)));

    if (normalized.length === 0) {
      return c.json({ error: "No usable telemetry data" }, 400);
    }

    const averaged = averageOutlines(normalized);
    let outline = smoothOutline(smoothOutline(averaged, 9), 7);

    if (startPositions.length > 0) {
      let sx = 0,
        sz = 0;
      for (const p of startPositions) {
        sx += p.x;
        sz += p.z;
      }
      const avgStart = { x: sx / startPositions.length, z: sz / startPositions.length };

      let bestIdx = 0,
        bestDist = Infinity;
      for (let i = 0; i < outline.length; i++) {
        const dx = outline[i].x - avgStart.x;
        const dz = outline[i].z - avgStart.z;
        const d = dx * dx + dz * dz;
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      if (bestIdx > 0) {
        outline = [...outline.slice(bestIdx), ...outline.slice(0, bestIdx)];
      }
    }

    recordLapTrace(trackOrdinal, outline, null, null, gameId);
    return c.json({
      success: true,
      lapsUsed: normalized.length,
      points: outline.length,
      message: `Recomputed outline from ${normalized.length} laps (${outline.length} points)`,
    });
  });

export const trackLapSectorRoutes = new Hono()

  // GET /api/tracks/:ordinal/lap-sectors — compute sector times for all laps on a track.
  .get("/api/tracks/:ordinal/lap-sectors", zValidator("param", OrdinalParamSchema), zValidator("query", GameIdQuerySchema), async (c) => {
    const { ordinal } = c.req.valid("param");

    const gameId = c.req.query("gameId") as GameId | undefined;
    const trackLaps = (await getLaps(gameId)).filter((l) => l.trackOrdinal === ordinal && l.lapTime > 0);
    if (trackLaps.length === 0) return c.json({});

    const result: Record<number, number[]> = {};

    for (const lapMeta of trackLaps) {
      const lapData = await getLapMetaById(lapMeta.id);
      if (!lapData) continue;
      const lapGameId = lapMeta.gameId ?? gameId;
      if (!lapGameId) continue;
      const replay = await queryLapTelemetryBySemanticId(lapData.id, CANONICAL_LAP_ANALYSIS_SEMANTIC_IDS);
      if (!replay) continue;
      const times = await computeLapSectors(ordinal, lapGameId, semanticSamplesFromReplay(replay), lapMeta.lapTime);
      if (times) result[lapMeta.id] = times;
    }

    return c.json(result);
  });

export const trackOutlineRoutes = new Hono()

  // GET /api/track-outline/:ordinal — track outline coordinates.
  .get("/api/track-outline/:ordinal", zValidator("param", OrdinalParamSchema), zValidator("query", GameIdQuerySchema), async (c) => {
    const { ordinal } = c.req.valid("param");
    const gameId = c.req.query("gameId");
    const startYaw = gameId ? getStartYaw(ordinal, gameId) : null;
    const altitude = getTrackAltitudeByOrdinal(ordinal);

    const flipX = gameId === "acc" || gameId === "ac-evo";

    if (gameId) {
      const resolved = await resolveTrackOutline(ordinal, gameId);
      if (resolved) {
        return c.json({
          ...resolved,
          startYaw,
          flipX,
          ...(altitude && { altitude }),
        });
      }
    }

    return c.json({ error: "No outline available" }, 404);
  })

  // DELETE /api/track-outline/:ordinal — delete recorded outline for a track
  .delete("/api/track-outline/:ordinal", zValidator("param", OrdinalParamSchema), (c) => {
    const { ordinal } = c.req.valid("param");

    const deleted = deleteRecordedOutline(ordinal, requireGameId(c));
    return c.json({ success: true, hadRecorded: deleted });
  });
