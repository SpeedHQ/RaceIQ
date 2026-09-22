import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { getLapSummariesByTrack } from "../../db/lap-read-queries";
import { fmCarSpecsCatalog } from "../../../shared/racing/cars/fm";
import { resolveCarName } from "../../../shared/racing/cars/resolve-name";
import { tryGetServerGame } from "../../games/registry";
import type { GameId } from "../../../shared/games/ids";
import { getLMUCar } from "../../../shared/games/lmu/catalog";
import { decodeTrackKey, TrackKeyParamSchema } from "./support";

export const trackLeaderboardRoutes = new Hono()

  // GET /api/tracks/:trackOrdinal/leaderboard — fastest laps grouped by PI class
  .get("/api/tracks/:trackOrdinal/leaderboard",
    zValidator("param", TrackKeyParamSchema),
    async (c) => {
      const rawTrackKey = decodeTrackKey(c.req.valid("param").trackOrdinal);
      const gameId = c.req.query("gameId") as GameId | undefined;
      if (!gameId) {
        return c.json({ error: "gameId query parameter is required" }, 400);
      }
      const trackKey = gameId === "lmu" ? rawTrackKey : Number(rawTrackKey);
      if (gameId !== "lmu" && !Number.isInteger(trackKey)) {
        return c.json({ error: "trackOrdinal must be an integer" }, 400);
      }
      const trackLaps = await getLapSummariesByTrack(trackKey, gameId);

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
          carOrdinal: lap.carOrdinal,
          carId: lap.carId ?? lap.carOrdinal,
          carName: lap.gameId === "lmu"
            ? getLMUCar(lap.carId ?? "")?.name ?? lap.carId ?? "Unknown car"
            : (tryGetServerGame(lap.gameId)?.getCarName(lap.carOrdinal) ?? resolveCarName(lap.carOrdinal, lap.gameId)),
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
    zValidator("param", TrackKeyParamSchema),
    async (c) => {
      const rawTrackKey = decodeTrackKey(c.req.valid("param").trackOrdinal);
      const gameId = c.req.query("gameId") as GameId | undefined;
      const trackKey = gameId === "lmu" ? rawTrackKey : Number(rawTrackKey);
      if (gameId !== "lmu" && !Number.isInteger(trackKey)) {
        return c.json({ error: "trackOrdinal must be an integer" }, 400);
      }
      const trackLaps = await getLapSummariesByTrack(trackKey, gameId);

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
          carId: lap.carId ?? lap.carOrdinal,
          carName: lap.gameId === "lmu"
            ? getLMUCar(lap.carId ?? "")?.name ?? lap.carId ?? "Unknown car"
            : (tryGetServerGame(lap.gameId)?.getCarName(lap.carOrdinal) ?? resolveCarName(lap.carOrdinal, lap.gameId)),
          carClass: piClass(pi),
          pi,
          createdAt: lap.createdAt,
          sessionId: lap.sessionId,
          sectorTimes: lap.sectorTimes,
          isValid: lap.isValid,
          invalidReason: lap.invalidReason,
          division: fmCarSpecsCatalog.get(lap.carOrdinal)?.division ?? null,
          notes: lap.notes,
        };
      });

      return c.json(entries);
    }
  );
