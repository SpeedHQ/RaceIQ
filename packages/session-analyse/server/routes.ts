import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { Corner } from "@raceiq/backend-core/lap-analysis/corners";
import { getLapsByIds } from "@raceiq/backend-core/db/lap-read-queries";
import { computeLineSpreadTrace } from "@raceiq/backend-core/lap-analysis/consistency";
import { ReviewLapsQuerySchema, ReviewLineSpreadQuerySchema } from "../contracts/requests";
import { getReviewLaps } from "./review-laps";

export function createSessionAnalyseRoutes(resolveLapCorners: (trackId: string | null | undefined, gameId: string | null | undefined, telemetry: TelemetryPacket[]) => Promise<Corner[]>) {
  return new Hono()
    .get("/api/laps/review", zValidator("query", ReviewLapsQuerySchema), async (c) => {
      const { gameId, sessionId, trackId, carId, limit } = c.req.valid("query");
      return c.json(await getReviewLaps(gameId, trackId ?? null, carId ?? null, limit, sessionId));
    })
    .get("/api/laps/review-line-spread", zValidator("query", ReviewLineSpreadQuerySchema), async (c) => {
      const { gameId, sessionId, lapIds } = c.req.valid("query");
      const loaded = await getLapsByIds(lapIds);
      if (loaded.length !== lapIds.length || loaded.some((lap) => lap.gameId !== gameId || lap.sessionId !== sessionId)) {
        return c.json({ error: "Selected laps must belong to session." }, 400);
      }
      const ordered = lapIds.map((id) => loaded.find((lap) => lap.id === id)!);
      const usable = ordered.filter((lap) => lap.telemetry.length >= 30);
      if (usable.length === 0) return c.json({ fracs: [], spreadM: [], perCorner: [], lowTrust: false, consistencyScore: 0, overallSpreadM: 0, lapCount: 0 });
      const first = usable[0]!;
      const corners = await resolveLapCorners(first.trackId, gameId, first.telemetry);
      const trace = computeLineSpreadTrace(usable.map((lap) => lap.telemetry), usable.map((lap) => lap.id), corners);
      if (!trace) return c.json({ fracs: [], spreadM: [], perCorner: [], lowTrust: false, consistencyScore: 0, overallSpreadM: 0, lapCount: usable.length });
      const { lapLines: _lapLines, ...compactTrace } = trace;
      return c.json(compactTrace);
    });
}
