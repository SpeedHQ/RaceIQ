import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { GameIdSchema } from "../../../shared/games/ids";
import { getSessions } from "../../db/session-queries";
import { getSessionLaps } from "../../db/lap-read-queries";
import { getSessionRawFile, getSessionTelemetryReplaySource } from "../../db/telemetry-replay-storage";
import { runLiveEngineerSessionReplay } from "../../live-strategy/live-engineer-replay";

const Query = z.object({ gameId: GameIdSchema, sessionId: z.coerce.number().int().positive() });
export const liveEngineerReplayRoutes = new Hono().get("/api/dev/live-engineer/session-replay", zValidator("query", Query), async (c) => {
  const { gameId, sessionId } = c.req.valid("query");
  const session = (await getSessions(gameId)).find((candidate) => candidate.id === sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  const rawFile = await getSessionRawFile(sessionId, gameId);
  if (!rawFile) return c.json({ error: "Session has no replayable raw capture" }, 409);
  try {
    const [{ packets, sourceProfile }, laps] = await Promise.all([getSessionTelemetryReplaySource(sessionId, gameId), getSessionLaps(gameId, sessionId)]);
    if (packets.length === 0) return c.json({ error: "Session has no replayable raw capture" }, 409);
    return c.json(runLiveEngineerSessionReplay({ session, laps, packets, sourceProfile }));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unable to replay session" }, 422);
  }
});
