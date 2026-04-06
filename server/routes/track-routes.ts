import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { IS_DEV } from "../env";
import { OrdinalParamSchema, GameIdQuerySchema } from "../../shared/schemas";
import {
  getLaps,
  getLapById,
  getCorners,
  saveCorners,
  getFirstLapIdForTrack,
  getTrackOutline as getDbTrackOutline,
  getTrackOutlineSectors,
  updateTrackOutlineSectors,
} from "../db/queries";
import {
  getTrackOutlineByOrdinal,
  getBundledOutlineByOrdinal,
  hasTrackOutline,
  hasRecordedOutline as sharedHasRecordedOutline,
  getTrackSectorsByOrdinal,
  getStartYaw,
  deleteRecordedOutline,
  getTrackBoundariesByOrdinal,
  getTrackCurbs,
  extractCurbSegments,
  recordCurbData,
  loadSharedOutline,
  loadSharedBoundary,
  loadSharedTrackMeta,
  recordLapTrace,
  getTrackAltitudeByOrdinal,
} from "../../shared/track-data";
import { trackMap, getCarName, getTrackName } from "../../shared/car-data";
import { detectCorners, type Corner } from "../corner-detection";
import {
  filterLapOutliers,
  normalizeToFixedPoints,
  averageOutlines,
  smoothOutline,
} from "../lap-detector";
import {
  getCalibrationStatus,
  transformToForzaSpace,
  computeStaticAlignment,
  refineAlignmentWithCurbs,
  clearCurbRefinement,
  calibrateFromPositions,
} from "../track-calibration";
import { getF1Tracks } from "../../shared/f1-track-data";
import { getAccTracks } from "../../shared/acc-track-data";
import { tryGetServerGame } from "../games/registry";
import { tryGetGame } from "../../shared/games/registry";
import { GameIdSchema, type GameId } from "../../shared/types";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

// ─── Param schemas ──────────────────────────────────────────────────────────

const TrackOrdinalParamSchema = z.object({
  trackOrdinal: z.string().transform(val => parseInt(val, 10)),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Extract gameId, throwing if missing. Use for endpoints that require game context. */
function requireGameId(c: { req: { query: (key: string) => string | undefined } }): GameId {
  const raw = c.req.query("gameId");
  const result = GameIdSchema.safeParse(raw);
  if (!result.success) throw new Error(`Invalid gameId: ${raw}`);
  return result.data;
}

function parseGameId(c: { req: { query: (key: string) => string | undefined } }): GameId {
  const raw = c.req.query("gameId");
  if (!raw) throw new Error("gameId query parameter is required");
  const result = GameIdSchema.safeParse(raw);
  if (!result.success) throw new Error(`Invalid gameId: ${raw}`);
  return result.data;
}

/** Resolve the shared track name for a given ordinal + gameId.
 *  Returns the shared outline file name (e.g. "silverstone") or undefined. */
function getSharedTrackName(ordinal: number, gameId?: string): string | undefined {
  if (gameId) {
    const adapter = tryGetGame(gameId);
    if (adapter?.getSharedTrackName) return adapter.getSharedTrackName(ordinal);
  }
  return undefined;
}

// ─── Track data file persistence ────────────────────────────────────────────

import { SHARED_DIR } from "../../shared/resolve-data";

// ─── Boundary helpers ───────────────────────────────────────────────────────

/**
 * Local boundary warping: for each boundary point, find the nearest curb point.
 * If within range, blend the boundary point toward the curb position.
 * Uses a Gaussian-like falloff so the warp is smooth.
 */
function warpBoundaryToCurbs(
  boundary: { x: number; z: number }[],
  curbPoints: { x: number; z: number }[],
  maxDist = 30, // max influence radius in meters
  strength = 0.7 // 0=no warp, 1=snap to curb
): void {
  if (curbPoints.length === 0) return;

  for (let i = 0; i < boundary.length; i++) {
    const bp = boundary[i];
    let nearestDist = Infinity;
    let nearestCurb: { x: number; z: number } | null = null;

    for (const cp of curbPoints) {
      const dx = bp.x - cp.x;
      const dz = bp.z - cp.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < nearestDist) {
        nearestDist = d;
        nearestCurb = cp;
      }
    }

    if (nearestCurb && nearestDist < maxDist) {
      // Gaussian falloff: full strength at 0, fades to 0 at maxDist
      const t = strength * Math.exp(-(nearestDist * nearestDist) / (2 * (maxDist / 3) ** 2));
      boundary[i] = {
        x: bp.x + (nearestCurb.x - bp.x) * t,
        z: bp.z + (nearestCurb.z - bp.z) * t,
      };
    }
  }
}

/**
 * Smooth a boundary using a moving average to remove jaggedness from warping.
 * Runs `passes` iterations of a 5-point weighted average.
 */
function smoothBoundary(boundary: { x: number; z: number }[], passes = 3): void {
  for (let p = 0; p < passes; p++) {
    const orig = boundary.map(pt => ({ ...pt }));
    for (let i = 2; i < boundary.length - 2; i++) {
      boundary[i] = {
        x: (orig[i - 2].x + orig[i - 1].x * 2 + orig[i].x * 4 + orig[i + 1].x * 2 + orig[i + 2].x) / 10,
        z: (orig[i - 2].z + orig[i - 1].z * 2 + orig[i].z * 4 + orig[i + 1].z * 2 + orig[i + 2].z) / 10,
      };
    }
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export const trackRoutes = new Hono()

  // GET /api/tracks/:trackOrdinal/corners — get stored corners or auto-detect
  .get("/api/tracks/:trackOrdinal/corners",
    zValidator("param", TrackOrdinalParamSchema),
    (c) => {
      const { trackOrdinal } = c.req.valid("param");
      const cornersGameId = requireGameId(c);

      let corners = getCorners(trackOrdinal, cornersGameId);

      // If no stored corners, try to auto-detect from a lap on this track
      if (corners.length === 0) {
        const lapId = getFirstLapIdForTrack(trackOrdinal);
        if (lapId !== null) {
          const lap = getLapById(lapId);
          if (lap && lap.telemetry.length > 0) {
            corners = detectCorners(lap.telemetry);
            if (corners.length > 0) {
              saveCorners(trackOrdinal, corners, cornersGameId, true);
            }
          }
        }
      }

      return c.json(corners);
    }
  )

  // PUT /api/tracks/:trackOrdinal/corners — save/update corner definitions
  .put("/api/tracks/:trackOrdinal/corners",
    zValidator("param", TrackOrdinalParamSchema),
    async (c) => {
      const { trackOrdinal } = c.req.valid("param");

      const body = await c.req.json<Corner[]>();

      if (!Array.isArray(body)) {
        return c.json({ error: "Body must be an array of corner definitions" }, 400);
      }

      // Validate each corner
      for (const corner of body) {
        if (
          typeof corner.index !== "number" ||
          typeof corner.label !== "string" ||
          typeof corner.distanceStart !== "number" ||
          typeof corner.distanceEnd !== "number"
        ) {
          return c.json(
            { error: "Each corner must have index, label, distanceStart, distanceEnd" },
            400
          );
        }
        if (corner.distanceEnd <= corner.distanceStart) {
          return c.json(
            { error: `Corner ${corner.label}: distanceEnd must be > distanceStart` },
            400
          );
        }
      }

      saveCorners(trackOrdinal, body, requireGameId(c), false);
      return c.json({ success: true, count: body.length });
    }
  )

  // GET /api/tracks/:ordinal (info)
  .get("/api/tracks/:ordinal",
    zValidator("param", OrdinalParamSchema),
    (c) => {
      const { ordinal } = c.req.valid("param");

      const track = trackMap.get(ordinal);
      if (!track) return c.json({ error: "Track not found" }, 404);

      return c.json({ ordinal, ...track });
    }
  )

  // GET /api/track-name/:ordinal — plain text
  .get("/api/track-name/:ordinal",
    zValidator("param", OrdinalParamSchema),
    (c) => {
      const { ordinal } = c.req.valid("param");
      const gameId = c.req.query("gameId");
      const serverAdapter = gameId ? tryGetServerGame(gameId) : undefined;
      if (serverAdapter) return c.text(serverAdapter.getTrackName(ordinal));
      return c.text(getTrackName(ordinal, gameId));
    }
  )

  // GET /api/track-sector-boundaries/:ordinal — returns s1End/s2End fractions for timing
  .get("/api/track-sector-boundaries/:ordinal",
    zValidator("param", OrdinalParamSchema),
    zValidator("query", GameIdQuerySchema),
    (c) => {
      const { ordinal } = c.req.valid("param");
      const gameId = c.req.query("gameId");
      const sharedName = getSharedTrackName(ordinal, gameId);

      // Priority: DB -> shared track meta -> bundled code -> default
      const dbSectors = gameId ? getTrackOutlineSectors(ordinal, requireGameId(c)) : null;
      const sharedMeta = sharedName ? loadSharedTrackMeta(sharedName) : null;
      const sectors = dbSectors ?? sharedMeta?.sectors ?? getTrackSectorsByOrdinal(ordinal);

      // Compute track length from outline
      let trackLength = 0;
      const outline = gameId
        ? getTrackOutlineByOrdinal(ordinal, gameId, sharedName)
        : null;
      if (outline && outline.length > 1) {
        for (let i = 1; i < outline.length; i++) {
          const dx = outline[i].x - outline[i - 1].x;
          const dz = outline[i].z - outline[i - 1].z;
          trackLength += Math.sqrt(dx * dx + dz * dz);
        }
      }

      return c.json({ ...sectors, trackLength });
    }
  )

  // PUT /api/track-sector-boundaries/:ordinal — update s1End/s2End fractions (dev only)
  .put("/api/track-sector-boundaries/:ordinal",
    zValidator("param", OrdinalParamSchema),
    async (c) => {
      if (!IS_DEV) return c.json({ error: "Not available in production" }, 403);
      const { ordinal } = c.req.valid("param");

      const body = await c.req.json();
      const { s1End, s2End } = body;
      if (typeof s1End !== "number" || typeof s2End !== "number") {
        return c.json({ error: "s1End and s2End numbers required" }, 400);
      }
      if (s1End <= 0 || s1End >= s2End || s2End >= 1) {
        return c.json({ error: "Invalid sector boundaries: need 0 < s1End < s2End < 1" }, 400);
      }

      const updated = updateTrackOutlineSectors(ordinal, { s1End, s2End }, requireGameId(c));
      if (!updated) return c.json({ error: "No outline found for track" }, 404);

      return c.json({ success: true, s1End, s2End });
    }
  )

  // GET /api/tracks — list all tracks with outline availability
  .get("/api/tracks",
    (c) => {
      const gameId = c.req.query("gameId");

      if (gameId === "f1-2025") {
        // Return F1 tracks
        const f1Tracks = getF1Tracks();
        const tracks = Array.from(f1Tracks.entries()).map(([id, info]) => {
          const hasBundled = !!getTrackOutlineByOrdinal(id, "f1-2025", info.commonTrackName);
          return {
            ordinal: id,
            name: info.name,
            location: info.location,
            country: info.country,
            variant: info.variant,
            lengthKm: info.lengthKm,
            hasOutline: hasBundled,
            outlineSource: hasBundled ? "bundled" : null,
            commonTrackName: info.commonTrackName || null,
            createdAt: null,
          };
        });
        tracks.sort((a, b) => a.name.localeCompare(b.name));
        return c.json(tracks);
      }

      if (gameId === "acc") {
        const accTracks = getAccTracks();
        const tracks = Array.from(accTracks.entries()).map(([id, info]) => {
          const hasExtracted = hasTrackOutline(id, "acc") || sharedHasRecordedOutline(id, "acc");
          const hasShared = !!info.commonTrackName && !!loadSharedOutline(info.commonTrackName);
          return {
            ordinal: id,
            name: info.name,
            location: "",
            country: "",
            variant: info.variant,
            lengthKm: 0,
            hasOutline: hasExtracted || hasShared,
            outlineSource: hasExtracted ? "recorded" : hasShared ? "tumftm" : null,
            createdAt: null,
          };
        });
        tracks.sort((a, b) => a.name.localeCompare(b.name));
        return c.json(tracks);
      }

      // Default: Forza tracks
      const forzaGameId = gameId ?? "fm-2023";
      const tracks = Array.from(trackMap.entries()).map(([ordinal, info]) => {
        const hasBundled = !!getTrackOutlineByOrdinal(ordinal, forzaGameId);
        return {
          ordinal,
          name: info.name,
          location: info.location,
          country: info.country,
          variant: info.variant,
          lengthKm: info.lengthKm,
          hasOutline: hasBundled,
          outlineSource: hasBundled ? "bundled" : null,
          createdAt: null,
        };
      });
      // Sort: tracks with outlines first, then alphabetically
      tracks.sort((a, b) => {
        if (a.hasOutline !== b.hasOutline) return a.hasOutline ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return c.json(tracks);
    }
  )

  // PUT /api/tracks/:trackOrdinal/segments — save segments to shared meta (dev only)
  .put("/api/tracks/:trackOrdinal/segments",
    zValidator("param", TrackOrdinalParamSchema),
    zValidator("query", GameIdQuerySchema),
    async (c) => {
      if (!IS_DEV) return c.json({ error: "Not available in production" }, 403);
      const { trackOrdinal } = c.req.valid("param");
      const gameId = c.req.query("gameId");

      const body = await c.req.json();
      if (!body.segments || !Array.isArray(body.segments)) {
        return c.json({ error: "segments array required" }, 400);
      }

      // Resolve shared track name for the meta file
      const sharedName = getSharedTrackName(trackOrdinal, gameId);
      if (!sharedName) {
        return c.json({ error: "No shared track name for this ordinal" }, 400);
      }

      // Update shared meta file with segments
      const meta = loadSharedTrackMeta(sharedName) ?? { name: sharedName };
      (meta as any).segments = body.segments;
      const metaDir = resolve(SHARED_DIR, "tracks", "meta");
      if (!existsSync(metaDir)) mkdirSync(metaDir, { recursive: true });
      writeFileSync(resolve(metaDir, `${sharedName}.json`), JSON.stringify(meta, null, 2));
      console.log(`[Track] Saved segments for ${sharedName} (${body.segments.length} segments)`);

      return c.json({ success: true, count: body.segments.length });
    }
  )

  // GET /api/track-sectors/:ordinal — returns user-edited, named, or auto-detected segments.
  // Optional ?source=extracted to force returning only extracted game segments.
  .get("/api/track-sectors/:ordinal",
    zValidator("param", OrdinalParamSchema),
    zValidator("query", GameIdQuerySchema),
    (c) => {
      const { ordinal } = c.req.valid("param");
      const gameId = c.req.query("gameId");
      const sharedName = getSharedTrackName(ordinal, gameId);

      // 1. Shared track meta segments (curated, cross-game)
      const sharedMeta = sharedName ? loadSharedTrackMeta(sharedName) : null;
      if (sharedMeta?.segments && sharedMeta.segments.length > 0) {
        return c.json({
          segments: sharedMeta.segments.map((s) => ({
            ...s,
            startIdx: 0,
            endIdx: 0,
            distStart: 0,
            distEnd: 0,
          })),
          totalDist: 0,
          source: "shared",
        });
      }

      // Fall back to auto-detection from outline curvature
      let outline = gameId ? getTrackOutlineByOrdinal(ordinal, gameId, sharedName) : null;
      if (!outline) {
        const recorded = gameId ? getDbTrackOutline(ordinal, gameId as GameId) : null;
        if (recorded) {
          outline = recorded.map((p: { x: number; z: number }) => ({ x: p.x, z: p.z }));
        }
      }
      if (!outline || outline.length < 20) return c.json({ segments: [] });

      const n = outline.length;

      // Compute cumulative distance
      const dists = [0];
      for (let i = 1; i < n; i++) {
        const dx = outline[i].x - outline[i - 1].x;
        const dz = outline[i].z - outline[i - 1].z;
        dists.push(dists[i - 1] + Math.sqrt(dx * dx + dz * dz));
      }
      const totalDist = dists[n - 1];

      // Compute curvature at each point using angle change over a window
      const window = Math.max(3, Math.floor(n / 80));
      const signedCurvature: number[] = [];
      const curvature: number[] = [];
      for (let i = 0; i < n; i++) {
        const prev = (i - window + n) % n;
        const next = (i + window) % n;
        const dx1 = outline[i].x - outline[prev].x;
        const dz1 = outline[i].z - outline[prev].z;
        const dx2 = outline[next].x - outline[i].x;
        const dz2 = outline[next].z - outline[i].z;
        const angle1 = Math.atan2(dz1, dx1);
        const angle2 = Math.atan2(dz2, dx2);
        let diff = angle2 - angle1;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        signedCurvature.push(diff);
        curvature.push(Math.abs(diff));
      }

      // Smooth curvature
      const smoothWindow = Math.max(2, Math.floor(n / 60));
      const smoothed: number[] = [];
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let j = -smoothWindow; j <= smoothWindow; j++) {
          sum += curvature[(i + j + n) % n];
        }
        smoothed.push(sum / (smoothWindow * 2 + 1));
      }

      // Threshold: 54th percentile
      const sorted = [...smoothed].sort((a, b) => a - b);
      const threshold = sorted[Math.floor(n * 0.54)];

      // Build segments by classifying each point
      type Seg = { type: "corner" | "straight"; startIdx: number; endIdx: number; startFrac: number; endFrac: number };
      const segments: Seg[] = [];
      let currentType: "corner" | "straight" = smoothed[0] > threshold ? "corner" : "straight";
      let segStart = 0;

      for (let i = 1; i < n; i++) {
        const type = smoothed[i] > threshold ? "corner" : "straight";
        if (type !== currentType) {
          segments.push({ type: currentType, startFrac: segStart / n, endFrac: i / n, startIdx: segStart, endIdx: i });
          currentType = type;
          segStart = i;
        }
      }
      segments.push({ type: currentType, startFrac: segStart / n, endFrac: 1, startIdx: segStart, endIdx: n - 1 });

      // Merge tiny segments (< 1.5% of track) into neighbor
      const pass1: Seg[] = [];
      for (const seg of segments) {
        if ((seg.endFrac - seg.startFrac) < 0.015 && pass1.length > 0) {
          pass1[pass1.length - 1].endFrac = seg.endFrac;
          pass1[pass1.length - 1].endIdx = seg.endIdx;
        } else {
          pass1.push({ ...seg });
        }
      }

      // Consolidate adjacent same-type segments
      const merged: Seg[] = [];
      for (const seg of pass1) {
        if (merged.length > 0 && merged[merged.length - 1].type === seg.type) {
          merged[merged.length - 1].endFrac = seg.endFrac;
          merged[merged.length - 1].endIdx = seg.endIdx;
        } else {
          merged.push({ ...seg });
        }
      }

      // Name segments with direction for corners
      let cornerNum = 1;
      let straightNum = 1;
      const namedSegs = merged.map((seg) => {
        let name: string;
        let direction: "left" | "right" | null = null;

        if (seg.type === "corner") {
          // Sum signed curvature over the segment to determine direction
          let sumCurv = 0;
          for (let i = seg.startIdx; i <= Math.min(seg.endIdx, n - 1); i++) {
            sumCurv += signedCurvature[i];
          }
          direction = sumCurv > 0 ? "right" : "left";
          name = `T${cornerNum++} ${direction === "left" ? "L" : "R"}`;
        } else {
          name = `S${straightNum++}`;
        }

        return {
          ...seg,
          name,
          direction,
          distStart: dists[seg.startIdx],
          distEnd: seg.endIdx < n ? dists[seg.endIdx] : totalDist,
        };
      });

      return c.json({ segments: namedSegs, totalDist });
    }
  )

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
        const lapData = getLapById(lapId);
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
      const allLaps = getLaps(undefined, outlineGameId).filter(
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
        const lapData = getLapById(lapMeta.id);
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
  )

  // GET /api/tracks/:trackOrdinal/leaderboard — fastest laps grouped by PI class
  .get("/api/tracks/:trackOrdinal/leaderboard",
    zValidator("param", TrackOrdinalParamSchema),
    (c) => {
      const { trackOrdinal } = c.req.valid("param");

      const profileIdParam = c.req.query("profileId");
      const profileIdParsed = profileIdParam ? parseInt(profileIdParam, 10) : undefined;
      const profileId = profileIdParsed !== undefined && !isNaN(profileIdParsed) ? profileIdParsed : undefined;

      const gameId = c.req.query("gameId") as GameId | undefined;
      const trackLaps = getLaps(profileId, gameId).filter(
        (l) => l.trackOrdinal === trackOrdinal && l.lapTime > 0
      );

      // Derive class letter from PI value
      const piClass = (pi: number): string => {
        if (pi >= 999) return "X";
        if (pi >= 900) return "P";
        if (pi >= 700) return "R";
        if (pi >= 600) return "S";
        if (pi >= 500) return "A";
        if (pi >= 400) return "B";
        if (pi >= 300) return "C";
        if (pi >= 200) return "D";
        return "E";
      };

      const entries = trackLaps.map((lap) => {
        const pi = lap.pi ?? 0;
        return {
          lapId: lap.id,
          lapNumber: lap.lapNumber,
          lapTime: lap.lapTime,
          carOrdinal: lap.carOrdinal ?? 0,
          carName: (lap.gameId ? tryGetServerGame(lap.gameId)?.getCarName(lap.carOrdinal ?? 0) : undefined) ?? getCarName(lap.carOrdinal ?? 0, lap.gameId),
          carClass: piClass(pi),
          pi,
          createdAt: lap.createdAt,
        };
      });

      const grouped: Record<string, typeof entries> = {};
      for (const e of entries) {
        const cls = piClass(e.pi);
        if (!grouped[cls]) grouped[cls] = [];
        grouped[cls].push(e);
      }

      // Sort each group by lap time, keep top 5 per class
      const result: Record<string, typeof entries> = {};
      const classOrder = ["X", "P", "R", "S", "A", "B", "C", "D", "E"];
      for (const cls of classOrder) {
        if (grouped[cls]) {
          result[cls] = grouped[cls].sort((a, b) => a.lapTime - b.lapTime).slice(0, 5);
        }
      }

      return c.json(result);
    }
  )

  // GET /api/track-calibration/:ordinal — calibration status
  .get("/api/track-calibration/:ordinal",
    zValidator("param", OrdinalParamSchema),
    (c) => {
      const { ordinal } = c.req.valid("param");
      return c.json(getCalibrationStatus(ordinal));
    }
  )

  // POST /api/track-calibration/:ordinal/from-lap — calibrate using a stored lap's positions
  .post("/api/track-calibration/:ordinal/from-lap",
    zValidator("param", OrdinalParamSchema),
    async (c) => {
      const { ordinal } = c.req.valid("param");

      const body = await c.req.json<{ lapId: number }>();
      if (!body?.lapId) return c.json({ error: "lapId required" }, 400);

      const lapData = getLapById(body.lapId);
      if (!lapData) return c.json({ error: "Lap not found" }, 404);
      if (lapData.trackOrdinal !== ordinal) return c.json({ error: "Lap is not from this track" }, 400);
      if (!lapData.telemetry || lapData.telemetry.length < 50) {
        return c.json({ error: "Lap has insufficient telemetry data" }, 400);
      }

      // Get the track outline
      const outline = getTrackOutlineByOrdinal(ordinal, requireGameId(c));
      if (!outline || outline.length === 0) return c.json({ error: "No outline available for this track" }, 400);

      // Extract positions from telemetry
      const positions = lapData.telemetry.map(p => ({ x: p.PositionX, z: p.PositionZ }));

      const success = calibrateFromPositions(ordinal, positions, outline);
      if (!success) return c.json({ error: "Calibration failed — not enough valid position points" }, 400);

      return c.json(getCalibrationStatus(ordinal));
    }
  )

  // GET /api/tracks/:ordinal/lap-sectors — compute sector times for all laps on a track.
  .get("/api/tracks/:ordinal/lap-sectors",
    zValidator("param", OrdinalParamSchema),
    zValidator("query", GameIdQuerySchema),
    (c) => {
      const { ordinal } = c.req.valid("param");

      // Get sector boundaries
      const gameId = c.req.query("gameId") as GameId | undefined;
      const dbSectors = gameId ? getTrackOutlineSectors(ordinal, gameId) : null;
      const bundled = getTrackSectorsByOrdinal(ordinal);
      const sectors = dbSectors ?? bundled;
      if (!sectors?.s1End || !sectors?.s2End) return c.json({});
      const trackLaps = getLaps(undefined, gameId).filter((l) => l.trackOrdinal === ordinal && l.lapTime > 0);
      if (trackLaps.length === 0) return c.json({});

      const result: Record<number, { s1: number; s2: number; s3: number }> = {};

      for (const lapMeta of trackLaps) {
        const lapData = getLapById(lapMeta.id);
        if (!lapData?.telemetry || lapData.telemetry.length < 50) continue;

        const packets = lapData.telemetry;
        const startDist = packets[0].DistanceTraveled;
        const endDist = packets[packets.length - 1].DistanceTraveled;
        const totalDist = endDist - startDist;
        if (totalDist < 100) continue;

        let s1Time = 0;
        let s2Time = 0;
        let currentSector = 0;
        let sectorStartTime = packets[0].CurrentLap;

        for (const p of packets) {
          const frac = (p.DistanceTraveled - startDist) / totalDist;
          const expectedSector = frac < sectors.s1End ? 0 : frac < sectors.s2End ? 1 : 2;

          if (expectedSector > currentSector) {
            const sectorTime = p.CurrentLap - sectorStartTime;
            if (currentSector === 0) s1Time = sectorTime;
            else if (currentSector === 1) s2Time = sectorTime;
            sectorStartTime = p.CurrentLap;
            currentSector = expectedSector;
          }
        }

        if (s1Time > 0 && s2Time > 0) {
          const s3Time = lapMeta.lapTime - s1Time - s2Time;
          result[lapMeta.id] = { s1: s1Time, s2: s2Time, s3: Math.max(0, s3Time) };
        }
      }

      return c.json(result);
    }
  )

  // GET /api/track-outline/:ordinal — track outline coordinates.
  .get("/api/track-outline/:ordinal",
    zValidator("param", OrdinalParamSchema),
    zValidator("query", GameIdQuerySchema),
    (c) => {
      const { ordinal } = c.req.valid("param");
      const gameId = c.req.query("gameId");
      const sharedName = getSharedTrackName(ordinal, gameId);

      const startYaw = gameId ? getStartYaw(ordinal, gameId) : null;
      const altitude = getTrackAltitudeByOrdinal(ordinal);

      // Try all sources: bundled game data → computed average → DB → TUMFTM
      if (gameId) {
        const outline = getTrackOutlineByOrdinal(ordinal, gameId, sharedName);
        if (outline) return c.json({ points: outline, recorded: true, source: "bundled", startYaw, ...(altitude && { altitude }) });
      }

      // DB-recorded outlines (legacy/ACC)
      if (gameId) {
        const dbOutline = getDbTrackOutline(ordinal, gameId as GameId);
        if (dbOutline) return c.json({ points: dbOutline, recorded: true, source: "recorded", startYaw, ...(altitude && { altitude }) });
      }

      // Shared outlines (cross-game TUMFTM) — fallback
      if (sharedName) {
        const shared = loadSharedOutline(sharedName);
        if (shared) return c.json({ points: shared, recorded: false, source: "tumftm", startYaw });
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
  )

  // GET /api/track-boundaries/:ordinal — track boundary edges (left/right + pit lane)
  .get("/api/track-boundaries/:ordinal",
    zValidator("param", OrdinalParamSchema),
    zValidator("query", GameIdQuerySchema),
    (c) => {
      const { ordinal } = c.req.valid("param");
      const gameId = c.req.query("gameId");
      const sharedName = getSharedTrackName(ordinal, gameId);

      // Try extracted boundaries first (game-specific coordinates)
      const validGameId = parseGameId(c);
      const extractedBoundaries = getTrackBoundariesByOrdinal(ordinal, validGameId);
      if (extractedBoundaries) {
        const minLen = Math.min(extractedBoundaries.leftEdge.length, extractedBoundaries.rightEdge.length);
        const centerLine: { x: number; z: number }[] = [];
        for (let i = 0; i < minLen; i++) {
          centerLine.push({
            x: (extractedBoundaries.leftEdge[i].x + extractedBoundaries.rightEdge[i].x) / 2,
            z: (extractedBoundaries.leftEdge[i].z + extractedBoundaries.rightEdge[i].z) / 2,
          });
        }
        return c.json({
          leftEdge: extractedBoundaries.leftEdge,
          rightEdge: extractedBoundaries.rightEdge,
          centerLine,
          pitLane: extractedBoundaries.pitLane,
          coordSystem: validGameId === "f1-2025" ? "f1-2025" : "forza",
        });
      }

      // Shared TUMFTM boundaries only work for Forza (has calibration transforms).
      // F1/ACC use different coordinate spaces — shared data would be misaligned.
      if (validGameId !== "fm-2023") return c.json({ error: "No boundary data available" }, 404);

      // Fall back to shared TUMFTM boundaries (need coordinate transform)
      type SharedBoundary = { leftEdge: { x: number; z: number }[]; rightEdge: { x: number; z: number }[]; pitLane: { x: number; z: number }[] | null };
      const boundaries: SharedBoundary | null = sharedName ? loadSharedBoundary(sharedName) as SharedBoundary : null;
      if (!boundaries) return c.json({ error: "No boundary data available" }, 404);

      // If we have a recorded Forza-coords outline AND a bundled TUMFTM outline,
      // compute static alignment so boundaries match without needing live driving.
      const recordedOutline = getDbTrackOutline(ordinal, requireGameId(c)) ?? (sharedHasRecordedOutline(ordinal, requireGameId(c)) ? getTrackOutlineByOrdinal(ordinal, requireGameId(c)) : null);
      const bundledOutline = getBundledOutlineByOrdinal(ordinal);
      if (recordedOutline && bundledOutline) {
        computeStaticAlignment(ordinal, bundledOutline, recordedOutline);

        // Refine alignment using curb data as boundary anchors (if available)
        const curbs = getTrackCurbs(ordinal, requireGameId(c));
        if (curbs && curbs.length > 0) {
          refineAlignmentWithCurbs(ordinal, bundledOutline, recordedOutline, boundaries, curbs);
        }
      }

      // Compute geometric center-line from midpoint of left/right edges
      const minLen = Math.min(boundaries.leftEdge.length, boundaries.rightEdge.length);
      const centerLine: { x: number; z: number }[] = [];
      for (let i = 0; i < minLen; i++) {
        centerLine.push({
          x: (boundaries.leftEdge[i].x + boundaries.rightEdge[i].x) / 2,
          z: (boundaries.leftEdge[i].z + boundaries.rightEdge[i].z) / 2,
        });
      }

      // Transform TUMFTM coords -> Forza coords (uses live calibration or static alignment)
      const leftForza = transformToForzaSpace(ordinal, boundaries.leftEdge);
      const rightForza = transformToForzaSpace(ordinal, boundaries.rightEdge);
      const centerForza = transformToForzaSpace(ordinal, centerLine);
      const pitForza = boundaries.pitLane ? transformToForzaSpace(ordinal, boundaries.pitLane) : null;

      if (leftForza && rightForza && centerForza) {
        // Local warp: nudge boundary points toward nearby curb ground-truth positions
        // Curbs are not pre-assigned to sides — correlate each curb point with the nearest boundary edge
        const curbs = getTrackCurbs(ordinal, requireGameId(c));
        if (curbs && curbs.length > 0) {
          const allCurbPts = curbs.flatMap(c => c.points);
          // For each curb point, assign to whichever boundary edge is closer
          const leftCurbs: { x: number; z: number }[] = [];
          const rightCurbs: { x: number; z: number }[] = [];
          for (const cp of allCurbPts) {
            let leftDist = Infinity;
            let rightDist = Infinity;
            for (const lp of leftForza) {
              const d = (lp.x - cp.x) ** 2 + (lp.z - cp.z) ** 2;
              if (d < leftDist) leftDist = d;
            }
            for (const rp of rightForza) {
              const d = (rp.x - cp.x) ** 2 + (rp.z - cp.z) ** 2;
              if (d < rightDist) rightDist = d;
            }
            if (leftDist <= rightDist) {
              leftCurbs.push(cp);
            } else {
              rightCurbs.push(cp);
            }
          }
          warpBoundaryToCurbs(leftForza, leftCurbs);
          warpBoundaryToCurbs(rightForza, rightCurbs);
          smoothBoundary(leftForza, 5);
          smoothBoundary(rightForza, 5);
          // Recompute center from warped boundaries
          const warpedCenter = leftForza.map((lp, i) => ({
            x: (lp.x + (rightForza[i]?.x ?? lp.x)) / 2,
            z: (lp.z + (rightForza[i]?.z ?? lp.z)) / 2,
          }));
          return c.json({
            leftEdge: leftForza,
            rightEdge: rightForza,
            centerLine: warpedCenter,
            pitLane: pitForza,
            coordSystem: "forza",
          });
        }

        return c.json({
          leftEdge: leftForza,
          rightEdge: rightForza,
          centerLine: centerForza,
          pitLane: pitForza,
          coordSystem: "forza",
        });
      }

      // No transform available — return raw TUMFTM coords
      return c.json({
        leftEdge: boundaries.leftEdge,
        rightEdge: boundaries.rightEdge,
        centerLine,
        pitLane: boundaries.pitLane,
        coordSystem: "tumftm",
      });
    }
  )

  // GET /api/track-curbs/:ordinal — curb/kerb positions detected from rumble strip data
  .get("/api/track-curbs/:ordinal",
    zValidator("param", OrdinalParamSchema),
    zValidator("query", GameIdQuerySchema),
    (c) => {
      const { ordinal } = c.req.valid("param");

      const curbs = getTrackCurbs(ordinal, requireGameId(c));
      if (!curbs) return c.json({ error: "No curb data" }, 404);
      return c.json(curbs);
    }
  )

  // POST /api/track-curbs/:ordinal/extract — extract curbs from all stored laps and recalibrate boundaries
  .post("/api/track-curbs/:ordinal/extract",
    zValidator("param", OrdinalParamSchema),
    (c) => {
      const { ordinal } = c.req.valid("param");

      // Find all laps for this track
      const curbGameId = c.req.query("gameId") as GameId | undefined;
      const trackLaps = getLaps(undefined, curbGameId).filter(l => l.trackOrdinal === ordinal && l.lapTime > 0);
      if (trackLaps.length === 0) return c.json({ error: "No laps found for this track" }, 404);

      let totalSegments = 0;
      let lapsWithCurbs = 0;

      for (const lap of trackLaps) {
        const lapData = getLapById(lap.id);
        if (!lapData?.telemetry || lapData.telemetry.length < 50) continue;

        const segments = extractCurbSegments(lapData.telemetry);
        if (segments.length > 0) {
          recordCurbData(ordinal, segments, requireGameId(c));
          totalSegments += segments.length;
          lapsWithCurbs++;
        }
      }

      const curbs = getTrackCurbs(ordinal, requireGameId(c));

      // Trigger boundary recalibration if we have curb data
      const boundaries = getTrackBoundariesByOrdinal(ordinal, requireGameId(c));
      const recordedOutline = getDbTrackOutline(ordinal, requireGameId(c)) ?? (sharedHasRecordedOutline(ordinal, requireGameId(c)) ? getTrackOutlineByOrdinal(ordinal, requireGameId(c)) : null);
      const bundledOutline = getBundledOutlineByOrdinal(ordinal);

      let calibrated = false;
      if (curbs && curbs.length > 0 && boundaries && recordedOutline && bundledOutline) {
        // Clear caches so alignment re-runs with fresh curb data
        clearCurbRefinement(ordinal);
        computeStaticAlignment(ordinal, bundledOutline, recordedOutline);
        refineAlignmentWithCurbs(ordinal, bundledOutline, recordedOutline, boundaries, curbs);
        calibrated = true;
      }

      return c.json({
        success: true,
        lapsScanned: trackLaps.length,
        lapsWithCurbs,
        totalSegments,
        curbSegments: curbs?.length ?? 0,
        calibrated,
        message: `Extracted curbs from ${lapsWithCurbs}/${trackLaps.length} laps, ${curbs?.length ?? 0} total segments. ${calibrated ? "Boundaries recalibrated." : "No boundary recalibration (missing data)."}`,
      });
    }
  );
