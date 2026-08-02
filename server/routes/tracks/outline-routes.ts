import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { OrdinalParamSchema, GameIdQuerySchema } from "../../../shared/schemas";
import { getLaps, getLapById } from "../../db/lap-read-queries";
import {
  deleteRecordedOutline,
  getStartYaw,
  getTrackAltitudeByOrdinal,
  recordLapTrace,
} from "../../../shared/track-data";
import {
  filterLapOutliers,
  normalizeToFixedPoints,
  averageOutlines,
  smoothOutline,
} from "../../lap-detector";
import type { GameId } from "../../../shared/types";
import { computeLapSectors } from "../../compute-lap-sectors";
import {
  requireGameId,
  resolveTrackOutline,
  TrackOrdinalParamSchema,
} from "./support";

export const trackRecomputeOutlineRoutes = new Hono()

  // POST /api/tracks/:trackOrdinal/recompute-outline — rebuild outline from stored laps
  .post("/api/tracks/:trackOrdinal/recompute-outline",
    zValidator("param", TrackOrdinalParamSchema),
    async (c) => {
      const { trackOrdinal } = c.req.valid("param");

      // Check for ?lapId= query param to use a single lap directly
      const lapIdParam = new URL(c.req.url).searchParams.get("lapId");

      if (lapIdParam) {
        // Single lap mode — use its telemetry directly as the outline
        const lapId = parseInt(lapIdParam, 10);
        const lapData = await getLapById(lapId);
        if (!lapData || !lapData.telemetry) {
          return c.json({ error: `Lap ${lapId} not found` }, 404);
        }

        let raw: { x: number; z: number }[] = [];
        for (const p of lapData.telemetry) {
          if (p.PositionX === 0 && p.PositionZ === 0) continue;
          raw.push({ x: p.PositionX, z: p.PositionZ });
        }
        if (raw.length < 50) {
          return c.json({ error: "Not enough telemetry data" }, 400);
        }

        // Light smoothing to clean up noise while preserving shape
        let outline = smoothOutline(raw, 5);

        const recomputeGameId = requireGameId(c);
        recordLapTrace(trackOrdinal, outline, null, null, recomputeGameId);
        return c.json({
          success: true,
          lapsUsed: 1,
          lapId,
          points: outline.length,
          message: `Saved outline from lap ${lapId} (${outline.length} points)`,
        });
      }

      // Multi-lap mode — average best laps
      const outlineGameId = c.req.query("gameId") as GameId | undefined;
      const allLaps = (await getLaps(outlineGameId)).filter(
        (l) => l.trackOrdinal === trackOrdinal && l.lapTime > 0
      );
      if (allLaps.length === 0) {
        return c.json({ error: "No laps found for this track" }, 404);
      }

      const sortedLaps = [...allLaps].sort((a, b) => a.lapTime - b.lapTime);
      const bestLaps = sortedLaps.slice(0, 10);

      const rawLaps: { x: number; z: number; speed: number }[][] = [];
      const startPositions: { x: number; z: number }[] = [];

      for (const lapMeta of bestLaps) {
        const lapData = await getLapById(lapMeta.id);
        if (!lapData || !lapData.telemetry || lapData.telemetry.length < 50) continue;

        let raw: { x: number; z: number; speed: number }[] = [];
        for (const p of lapData.telemetry) {
          if (p.PositionX === 0 && p.PositionZ === 0) continue;
          raw.push({ x: p.PositionX, z: p.PositionZ, speed: (p.Speed ?? 0) * 2.23694 });
        }
        raw = filterLapOutliers(raw);
        if (raw.length < 50) continue;

        rawLaps.push(raw);
        const last = raw[raw.length - 1];
        startPositions.push({ x: last.x, z: last.z });
      }

      // Normalize all laps to the same point count (max raw count) for averaging
      const maxPoints = Math.max(...rawLaps.map(l => l.length));
      const normalized = rawLaps.map(l =>
        l.length === maxPoints ? l : normalizeToFixedPoints(l, maxPoints)
      );

      if (normalized.length === 0) {
        return c.json({ error: "No usable telemetry data" }, 400);
      }

      const averaged = averageOutlines(normalized);
      let outline = smoothOutline(smoothOutline(averaged, 9), 7);

      if (startPositions.length > 0) {
        let sx = 0, sz = 0;
        for (const p of startPositions) { sx += p.x; sz += p.z; }
        const avgStart = { x: sx / startPositions.length, z: sz / startPositions.length };

        let bestIdx = 0, bestDist = Infinity;
        for (let i = 0; i < outline.length; i++) {
          const dx = outline[i].x - avgStart.x;
          const dz = outline[i].z - avgStart.z;
          const d = dx * dx + dz * dz;
          if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        if (bestIdx > 0) {
          outline = [...outline.slice(bestIdx), ...outline.slice(0, bestIdx)];
        }
      }

      const recomputeGameId = requireGameId(c);
      recordLapTrace(trackOrdinal, outline, null, null, recomputeGameId);
      return c.json({
        success: true,
        lapsUsed: normalized.length,
        points: outline.length,
        message: `Recomputed outline from ${normalized.length} laps (${outline.length} points)`,
      });
    }
  );

export const trackLapSectorRoutes = new Hono()

  // GET /api/tracks/:ordinal/lap-sectors — compute sector times for all laps on a track.
  .get("/api/tracks/:ordinal/lap-sectors",
    zValidator("param", OrdinalParamSchema),
    zValidator("query", GameIdQuerySchema),
    async (c) => {
      const { ordinal } = c.req.valid("param");

      const gameId = c.req.query("gameId") as GameId | undefined;
      const trackLaps = (await getLaps(gameId)).filter((l) => l.trackOrdinal === ordinal && l.lapTime > 0);
      if (trackLaps.length === 0) return c.json({});

      const result: Record<number, number[]> = {};

      for (const lapMeta of trackLaps) {
        const lapData = await getLapById(lapMeta.id);
        if (!lapData?.telemetry || lapData.telemetry.length < 50) continue;
        const lapGameId = lapMeta.gameId ?? gameId;
        if (!lapGameId) continue;
        const times = await computeLapSectors(
          ordinal,
          lapGameId,
          lapData.telemetry,
          lapMeta.lapTime,
        );
        if (times) result[lapMeta.id] = times;
      }

      return c.json(result);
    }
  );

export const trackOutlineRoutes = new Hono()

  // GET /api/track-outline/:ordinal — track outline coordinates.
  .get("/api/track-outline/:ordinal",
    zValidator("param", OrdinalParamSchema),
    zValidator("query", GameIdQuerySchema),
    async (c) => {
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
    }
  )

  // DELETE /api/track-outline/:ordinal — delete recorded outline for a track
  .delete("/api/track-outline/:ordinal",
    zValidator("param", OrdinalParamSchema),
    (c) => {
      const { ordinal } = c.req.valid("param");

      const deleted = deleteRecordedOutline(ordinal, requireGameId(c));
      return c.json({ success: true, hadRecorded: deleted });
    }
  );
