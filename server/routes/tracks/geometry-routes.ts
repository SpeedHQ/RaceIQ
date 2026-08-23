import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { OrdinalParamSchema, GameIdQuerySchema } from "@shared/platform/http/route-schemas";
import { getLaps, getLapById } from "../../db/lap-read-queries";
import { getTrackOutline as getDbTrackOutline } from "../../db/track-queries";
import { extractCurbSegments, getTrackCurbs, recordCurbData } from "../../../shared/racing/tracks/recording/curbs";
import { getBundledOutlineByOrdinal } from "../../../shared/racing/tracks/geometry/outlines";
import { getTrackBoundariesByOrdinal } from "../../../shared/racing/tracks/geometry/extracted";
import { getTrackOutlineByOrdinal, getTrackRacelineByOrdinal, hasRecordedOutline as sharedHasRecordedOutline } from "../../../shared/racing/tracks/recording/outlines";
import { loadSharedBoundary } from "../../../shared/racing/tracks/geometry/shared";
import { calibrateFromPositions, clearCurbRefinement, computeStaticAlignment, getCalibrationStatus, refineAlignmentWithCurbs, transformToSourceSpace } from "../../tracks/calibration";
import type { GameId } from "../../../shared/games/ids";
import { getSharedTrackName, requireGameId } from "./support";

export const trackCalibrationRoutes = new Hono()

  // GET /api/track-calibration/:ordinal — calibration status
  .get("/api/track-calibration/:ordinal", zValidator("param", OrdinalParamSchema), (c) => {
    const { ordinal } = c.req.valid("param");
    return c.json(getCalibrationStatus(ordinal));
  })

  // POST /api/track-calibration/:ordinal/from-lap — calibrate using a stored lap's positions
  .post("/api/track-calibration/:ordinal/from-lap", zValidator("param", OrdinalParamSchema), async (c) => {
    const { ordinal } = c.req.valid("param");

    const body = await c.req.json<{ lapId: number }>();
    if (!body?.lapId) return c.json({ error: "lapId required" }, 400);

    const lapData = await getLapById(body.lapId);
    if (!lapData) return c.json({ error: "Lap not found" }, 404);
    if (lapData.trackOrdinal !== ordinal) return c.json({ error: "Lap is not from this track" }, 400);
    if (!lapData.telemetry || lapData.telemetry.length < 50) {
      return c.json({ error: "Lap has insufficient telemetry data" }, 400);
    }

    // Get the track outline
    const outline = getTrackOutlineByOrdinal(ordinal, requireGameId(c));
    if (!outline || outline.length === 0) return c.json({ error: "No outline available for this track" }, 400);

    // Extract positions from telemetry
    const positions = lapData.telemetry.map((p) => ({ x: p.PositionX, z: p.PositionZ }));

    const success = calibrateFromPositions(ordinal, positions, outline);
    if (!success) return c.json({ error: "Calibration failed — not enough valid position points" }, 400);

    return c.json(getCalibrationStatus(ordinal));
  });

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
  strength = 0.7, // 0=no warp, 1=snap to curb
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
    const orig = boundary.map((pt) => ({ ...pt }));
    for (let i = 2; i < boundary.length - 2; i++) {
      boundary[i] = {
        x: (orig[i - 2].x + orig[i - 1].x * 2 + orig[i].x * 4 + orig[i + 1].x * 2 + orig[i + 2].x) / 10,
        z: (orig[i - 2].z + orig[i - 1].z * 2 + orig[i].z * 4 + orig[i + 1].z * 2 + orig[i + 2].z) / 10,
      };
    }
  }
}

export const trackGeometryRoutes = new Hono()

  // GET /api/track-boundaries/:ordinal — track boundary edges (left/right + pit lane)
  .get("/api/track-boundaries/:ordinal", zValidator("param", OrdinalParamSchema), zValidator("query", GameIdQuerySchema), async (c) => {
    const { ordinal } = c.req.valid("param");
    const gameId = c.req.query("gameId");
    const sharedName = getSharedTrackName(ordinal, gameId);

    // Try extracted boundaries first (game-specific coordinates)
    const { gameId: validGameId } = c.req.valid("query");

    if (!validGameId) return c.json({ error: "gameId query parameter is required" }, 400);

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
        // Game reference racing line, if the game shipped one (ACC/AC Evo only).
        // A driving line, not track geometry — the analyse map may draw it as an
        // overlay on top of leftEdge/rightEdge. Null for every other game.
        raceLine: getTrackRacelineByOrdinal(ordinal, validGameId),
        pitLane: extractedBoundaries.pitLane,
        coordSystem: validGameId === "f1-2025" ? "f1-2025" : validGameId === "acc" || validGameId === "ac-evo" ? "acc" : "forza",
      });
    }

    // Shared TUMFTM boundaries only work for Forza (has calibration transforms).
    // F1/ACC use different coordinate spaces — shared data would be misaligned.
    if (validGameId !== "fm-2023") return c.json(null);

    // Fall back to shared TUMFTM boundaries (need coordinate transform)
    type SharedBoundary = { leftEdge: { x: number; z: number }[]; rightEdge: { x: number; z: number }[]; pitLane: { x: number; z: number }[] | null };
    const boundaries: SharedBoundary | null = sharedName ? (loadSharedBoundary(sharedName) as SharedBoundary) : null;
    if (!boundaries) return c.json(null);

    // If we have a recorded Forza-coords outline AND a bundled TUMFTM outline,
    // compute static alignment so boundaries match without needing live driving.
    const recordedOutline = (await getDbTrackOutline(ordinal, requireGameId(c))) ?? (sharedHasRecordedOutline(ordinal, requireGameId(c)) ? getTrackOutlineByOrdinal(ordinal, requireGameId(c)) : null);
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
    const leftForza = transformToSourceSpace(ordinal, boundaries.leftEdge);
    const rightForza = transformToSourceSpace(ordinal, boundaries.rightEdge);
    const centerForza = transformToSourceSpace(ordinal, centerLine);
    const pitForza = boundaries.pitLane ? transformToSourceSpace(ordinal, boundaries.pitLane) : null;

    if (leftForza && rightForza && centerForza) {
      // Local warp: nudge boundary points toward nearby curb ground-truth positions
      // Curbs are not pre-assigned to sides — correlate each curb point with the nearest boundary edge
      const curbs = getTrackCurbs(ordinal, requireGameId(c));
      if (curbs && curbs.length > 0) {
        const allCurbPts = curbs.flatMap((c) => c.points);
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
  })

  // GET /api/track-curbs/:ordinal — curb/kerb positions detected from rumble strip data
  .get("/api/track-curbs/:ordinal", zValidator("param", OrdinalParamSchema), zValidator("query", GameIdQuerySchema), (c) => {
    const { ordinal } = c.req.valid("param");

    const curbs = getTrackCurbs(ordinal, requireGameId(c));
    return c.json(curbs ?? null);
  })

  // POST /api/track-curbs/:ordinal/extract — extract curbs from all stored laps and recalibrate boundaries
  .post("/api/track-curbs/:ordinal/extract", zValidator("param", OrdinalParamSchema), async (c) => {
    const { ordinal } = c.req.valid("param");

    // Find all laps for this track
    const curbGameId = c.req.query("gameId") as GameId | undefined;
    const trackLaps = (await getLaps(curbGameId)).filter((l) => l.trackOrdinal === ordinal && l.lapTime > 0);
    if (trackLaps.length === 0) return c.json({ error: "No laps found for this track" }, 404);

    let totalSegments = 0;
    let lapsWithCurbs = 0;

    for (const lap of trackLaps) {
      const lapData = await getLapById(lap.id);
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
    const recordedOutline = (await getDbTrackOutline(ordinal, requireGameId(c))) ?? (sharedHasRecordedOutline(ordinal, requireGameId(c)) ? getTrackOutlineByOrdinal(ordinal, requireGameId(c)) : null);
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
  });
