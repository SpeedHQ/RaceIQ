import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { getLapSummariesByTrack } from "@raceiq/backend-core/db/lap-read-queries";
import { fmCarSpecsCatalog } from "@raceiq/game-fm-2023-metadata/racing/cars/fm";
import { resolveCarName } from "@raceiq/game-catalogs/racing/cars/resolve-name";
import { tryGetServerGame } from "@raceiq/backend-core/games/registry";
import { TrackIdParamSchema, requireGameId } from "./support";

export const trackLeaderboardRoutes = new Hono()

  // GET /api/tracks/:trackId/leaderboard — fastest laps grouped by PI class
  .get("/api/tracks/:trackId/leaderboard",
    zValidator("param", TrackIdParamSchema),
    async (c) => {
      const { trackId } = c.req.valid("param");
      const gameId = requireGameId(c);
      const trackLaps = await getLapSummariesByTrack(trackId, gameId);
      // Derive class letter from PI value
      const piClass = (pi: number): string => {
        if (pi >= 999) return "X";
        if (pi >= 901) return "P";
        if (pi >= 801) return "R";
        if (pi >= 701) return "S";
        if (pi >= 601) return "A";
        if (pi >= 501) return "B";
        if (pi >= 401) return "C";
        if (pi >= 301) return "D";
        return "E";
      };

      const entries = trackLaps.map((lap) => {
        const pi = lap.pi ?? 0;
        return {
          lapId: lap.lapId,
          lapNumber: lap.lapNumber,
          lapTime: lap.lapTime,
          carId: lap.carId,
          carName: tryGetServerGame(lap.gameId)?.getCarName(lap.carId) ?? resolveCarName(lap.carId, lap.gameId),
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

  // GET /api/tracks/:trackId/all-laps — all laps for a track (ungrouped, for detail view)
  .get("/api/tracks/:trackId/all-laps",
    zValidator("param", TrackIdParamSchema),
    async (c) => {
      const { trackId } = c.req.valid("param");
      const gameId = requireGameId(c);
      const trackLaps = await getLapSummariesByTrack(trackId, gameId);

      const piClass = (pi: number): string => {
        if (pi >= 999) return "X";
        if (pi >= 901) return "P";
        if (pi >= 801) return "R";
        if (pi >= 701) return "S";
        if (pi >= 601) return "A";
        if (pi >= 501) return "B";
        if (pi >= 401) return "C";
        if (pi >= 301) return "D";
        return "E";
      };

      const entries = trackLaps.map((lap) => {
        const pi = lap.pi ?? 0;
        return {
          lapId: lap.lapId,
          lapNumber: lap.lapNumber,
          lapTime: lap.lapTime,
          carId: lap.carId,
          carName: tryGetServerGame(lap.gameId)?.getCarName(lap.carId) ?? resolveCarName(lap.carId, lap.gameId),
          carClass: piClass(pi),
          pi,
          createdAt: lap.createdAt,
          sessionId: lap.sessionId,
          sectorTimes: lap.sectorTimes,
          isValid: lap.isValid,
          invalidReason: lap.invalidReason,
          division: lap.gameId === "fm-2023" ? fmCarSpecsCatalog.get(Number(lap.carId))?.division ?? null : null,
          notes: lap.notes,
        };
      });

      return c.json(entries);
    }
  );
