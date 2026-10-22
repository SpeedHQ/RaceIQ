import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { TrackIdParamSchema, GameIdQuerySchema } from "@raceiq/shared/platform/http/route-schemas";
import { getLapById } from "@raceiq/backend-core/db/lap-read-queries";
import { getTrackOutline as getDbTrackOutline } from "@raceiq/backend-core/db/track-queries";
import { getBundledOutlineByOrdinal } from "@raceiq/game-catalogs/racing/tracks/geometry/outlines";
import { getTrackBoundariesById } from "@raceiq/game-catalogs/racing/tracks/geometry/extracted";
import {
  getTrackOutlineById,
  getTrackRacelineById,
  hasRecordedOutlineById,
} from "@raceiq/game-catalogs/racing/tracks/recording/outlines";
import { loadSharedBoundary } from "@raceiq/shared/racing/tracks/geometry/shared";
import { getLMUTrackBoundaries } from "@raceiq/game-lmu-metadata/track-boundaries";
import {
  calibrateFromPositions,
  computeStaticAlignment,
  getCalibrationComparison,
  getCalibrationStatus,
  transformToSourceSpace,
} from "@raceiq/backend-core/tracks/calibration";
import { getSharedTrackName, requireGameId, resolveTrackOutline } from "./support";

export const trackCalibrationRoutes = new Hono()

  // GET /api/track-calibration/:trackId — calibration status
  .get("/api/track-calibration/:trackId",
    zValidator("param", TrackIdParamSchema),
    (c) => {
      const { trackId } = c.req.valid("param");
      return c.json(getCalibrationStatus(trackId));
    }
  )
  .get("/api/track-calibration/:trackId/comparison",
    zValidator("param", TrackIdParamSchema),
    (c) => c.json(getCalibrationComparison(c.req.valid("param").trackId))
  )

  // POST /api/track-calibration/:trackId/from-lap — calibrate using a stored lap's positions
  .post("/api/track-calibration/:trackId/from-lap",
    zValidator("param", TrackIdParamSchema),
    async (c) => {
      const { trackId } = c.req.valid("param");

      const body = await c.req.json<{ lapId: number }>();
      if (!body?.lapId) return c.json({ error: "lapId required" }, 400);

      const lapData = await getLapById(body.lapId);
      if (!lapData) return c.json({ error: "Lap not found" }, 404);
      if (lapData.trackId !== trackId) return c.json({ error: "Lap is not from this track" }, 400);
      if (!lapData.telemetry || lapData.telemetry.length < 50) {
        return c.json({ error: "Lap has insufficient telemetry data" }, 400);
      }

      // Get the track geometry
      const gameId = requireGameId(c);
      const outline = (await resolveTrackOutline(trackId, gameId))?.points;
      if (!outline || outline.length === 0) return c.json({ error: "No outline available for this track" }, 400);

      // Extract positions from telemetry
      const positions = lapData.telemetry.map(p => ({ x: p.PositionX, z: p.PositionZ }));

      const success = calibrateFromPositions(
        trackId,
        positions,
        outline,
        getTrackBoundariesById(trackId, gameId) ?? undefined
      );
      if (!success) return c.json({ error: "Calibration failed — not enough valid position points" }, 400);

      return c.json(getCalibrationStatus(trackId));
    }
  );

export const trackGeometryRoutes = new Hono()

  // GET /api/track-boundaries/:trackId — track boundary edges (left/right + pit lane)
  .get("/api/track-boundaries/:trackId",
    zValidator("param", TrackIdParamSchema),
    zValidator("query", GameIdQuerySchema),
    async (c) => {
      const { trackId } = c.req.valid("param");
      const { gameId: validGameId } = c.req.valid("query");
      if (!validGameId) return c.json({ error: "gameId query parameter is required" }, 400);
      if (validGameId === "lmu") {
        const boundaries = getLMUTrackBoundaries(trackId);
        return c.json(boundaries ? { ...boundaries, coordSystem: "lmu" } : null);
      }
      const sharedName = getSharedTrackName(trackId, validGameId);
      const extractedBoundaries = getTrackBoundariesById(trackId, validGameId);
      if (extractedBoundaries) {
        let leftEdge = extractedBoundaries.leftEdge;
        let rightEdge = extractedBoundaries.rightEdge;
        let centerLine = extractedBoundaries.centerLine;
        let pitLane = extractedBoundaries.pitLane;
        if (!centerLine?.length) {
          const minLen = Math.min(leftEdge.length, rightEdge.length);
          centerLine = [];
          for (let i = 0; i < minLen; i++) {
            centerLine.push({
              x: (leftEdge[i].x + rightEdge[i].x) / 2,
              z: (leftEdge[i].z + rightEdge[i].z) / 2,
            });
          }
        }

        return c.json({
          leftEdge,
          rightEdge,
          centerLine,
          // Game reference racing line, if the game shipped one (ACC/AC Evo only).
          // A driving line, not track geometry — the analyse map may draw it as an
          // overlay on top of leftEdge/rightEdge. Null for every other game.
          raceLine: getTrackRacelineById(trackId, validGameId),
          pitLane,
          ...(extractedBoundaries.additionalSections ? { additionalSections: extractedBoundaries.additionalSections } : {}),
          coordSystem: validGameId === "ams2" ? "ams2-world" : validGameId === "f1-2025" ? "f1-2025" : (validGameId === "acc" || validGameId === "ac-evo") ? "acc" : "forza",
        });
      }

      // Shared TUMFTM boundaries only work for Forza (has calibration transforms).
      // F1/ACC use different coordinate spaces — shared data would be misaligned.
      if (validGameId !== "fm-2023") return c.json(null);

      // Fall back to shared TUMFTM boundaries (need coordinate transform)
      type SharedBoundary = { leftEdge: { x: number; z: number }[]; rightEdge: { x: number; z: number }[]; pitLane: { x: number; z: number }[] | null };
      const boundaries: SharedBoundary | null = sharedName ? loadSharedBoundary(sharedName) as SharedBoundary : null;
      if (!boundaries) return c.json(null);

      // If we have a recorded Forza-coords outline AND a bundled TUMFTM outline,
      // compute static alignment so boundaries match without needing live driving.
      const recordedOutline = (await getDbTrackOutline(trackId, validGameId)) ?? (hasRecordedOutlineById(trackId, validGameId) ? getTrackOutlineById(trackId, validGameId) : null);
      const bundledOutline = getBundledOutlineByOrdinal(Number(trackId));
      if (recordedOutline && bundledOutline) {
        computeStaticAlignment(trackId, bundledOutline, recordedOutline);
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
      const leftForza = transformToSourceSpace(trackId, boundaries.leftEdge);
      const rightForza = transformToSourceSpace(trackId, boundaries.rightEdge);
      const centerForza = transformToSourceSpace(trackId, centerLine);
      const pitForza = boundaries.pitLane ? transformToSourceSpace(trackId, boundaries.pitLane) : null;

      if (leftForza && rightForza && centerForza) {
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
  );
