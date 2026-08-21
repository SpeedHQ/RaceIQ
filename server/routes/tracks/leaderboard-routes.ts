import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { getLaps, getLapSummariesByTrack } from "../../db/lap-read-queries";
import { fmCarSpecsCatalog } from "../../../shared/racing/cars/fm";
import { resolveCarName } from "../../../shared/racing/cars/resolve-name";
import { tryGetServerGame } from "../../games/registry";
import type { GameId } from "../../../shared/games/ids";
import { isTimedLapEligibilityUsable } from "../../../shared/racing/quality/policies";
import { TrackOrdinalParamSchema } from "./support";

export const trackLeaderboardRoutes = new Hono()

  // GET /api/tracks/:trackOrdinal/leaderboard — fastest laps grouped by PI class
  .get("/api/tracks/:trackOrdinal/leaderboard",
    zValidator("param", TrackOrdinalParamSchema),
    async (c) => {
      const { trackOrdinal } = c.req.valid("param");

      const gameId = c.req.query("gameId") as GameId | undefined;
      if (!gameId) {
        return c.json({ error: "gameId query parameter is required" }, 400);
      }
      // Hard-filter by gameId even though getLaps() already scopes its query:
      // belt-and-braces so cross-game ordinal collisions (Forza track 2 ≠ AC
      // Evo track 2) can never leak into the wrong tracks page.
      const trackLaps = (await getLaps(gameId)).filter(
        (lap) => lap.trackOrdinal === trackOrdinal && isTimedLapEligibilityUsable(lap) && lap.gameId === gameId
      );

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
          lapId: lap.id,
          lapNumber: lap.lapNumber,
          lapTime: lap.lapTime,
          carOrdinal: lap.carOrdinal ?? 0,
          carName: (lap.gameId ? tryGetServerGame(lap.gameId)?.getCarName(lap.carOrdinal ?? 0) : undefined) ?? resolveCarName(lap.carOrdinal ?? 0, lap.gameId),
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

  // GET /api/tracks/:trackOrdinal/all-laps — all laps for a track (ungrouped, for detail view)
  .get("/api/tracks/:trackOrdinal/all-laps",
    zValidator("param", TrackOrdinalParamSchema),
    async (c) => {
      const { trackOrdinal } = c.req.valid("param");
      const gameId = c.req.query("gameId") as GameId | undefined;
      const trackLaps = await getLapSummariesByTrack(trackOrdinal, gameId);

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
          carOrdinal: lap.carOrdinal,
          carName: (lap.gameId ? tryGetServerGame(lap.gameId)?.getCarName(lap.carOrdinal) : undefined) ?? resolveCarName(lap.carOrdinal, lap.gameId),
          carClass: piClass(pi),
          pi,
          createdAt: lap.createdAt,
          sessionId: lap.sessionId,
          sectorTimes: lap.sectorTimes,
          isValid: lap.isValid,
          phase: lap.phase,
          conditions: lap.conditions,
          paceEligibility: lap.paceEligibility,
          eligibility: lap.eligibility,
          quality: lap.quality,
          qualityGeneration: lap.qualityGeneration,
          qualityStale: lap.qualityStale,
          source: lap.source,
          invalidReason: lap.invalidReason,
          division: fmCarSpecsCatalog.get(lap.carOrdinal)?.division ?? null,
          notes: lap.notes,
        };
      });

      return c.json(entries);
    }
  );
