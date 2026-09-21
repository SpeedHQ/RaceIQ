import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { GameIdSchema } from "../../../shared/games/ids";
import { getSessions } from "../../db/session-queries";
import { getSessionLaps } from "../../db/lap-read-queries";
import { getSessionRawFile, getSessionTelemetryReplaySource } from "../../db/telemetry-replay-storage";
import { runLiveEngineerSessionReplay, type LiveEngineerReplayScenario } from "../../live-strategy/live-engineer-replay";
import type { TelemetryPacket } from "../../../shared/telemetry/types";

const progressivePacketSample = (packets: readonly TelemetryPacket[], gameId: string): TelemetryPacket[] => {
  if (gameId !== "f1-2025" || packets.length <= 2_000) return [...packets];
  const selected = new Set<number>([0, packets.length - 1]);
  const step = Math.max(1, Math.floor(packets.length / 2_000));
  for (let index = 0; index < packets.length; index += step) selected.add(index);
  for (let index = 1; index < packets.length; index++) {
    if (packets[index]!.LapNumber !== packets[index - 1]!.LapNumber) {
      selected.add(index - 1);
      selected.add(index);
    }
  }
  return [...selected].sort((left, right) => left - right).map((index) => packets[index]!);
};
const Query = z.object({ gameId: GameIdSchema, sessionId: z.coerce.number().int().positive(), scenario: z.enum(["fuel-warning-escalation", "critical-fuel-pit-sequence", "scheduled-pit-sequence", "f1-opponent-lap-pace"]).optional() });
export const liveEngineerReplayRoutes = new Hono().get("/api/dev/live-engineer/session-replay", zValidator("query", Query), async (c) => {
  const { gameId, sessionId, scenario } = c.req.valid("query");
  const session = (await getSessions(gameId)).find((candidate) => candidate.id === sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  const rawFile = await getSessionRawFile(sessionId, gameId);
  if (!rawFile) return c.json({ error: "Session has no replayable raw capture" }, 409);
  try {
    const [{ packets, sourceProfile }, laps] = await Promise.all([getSessionTelemetryReplaySource(sessionId, gameId), getSessionLaps(gameId, sessionId)]);
    if (packets.length === 0) return c.json({ error: "Session has no replayable raw capture" }, 409);
    return c.json(runLiveEngineerSessionReplay({ session, laps, packets, sourceProfile, scenario: scenario as LiveEngineerReplayScenario | undefined }));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unable to replay session" }, 422);
  }
});

liveEngineerReplayRoutes.get("/api/dev/live-engineer/session-replay-stream", zValidator("query", Query), async (c) => {
  const { gameId, sessionId, scenario } = c.req.valid("query");
  const encoder = new TextEncoder();
  const write = (controller: ReadableStreamDefaultController<Uint8Array>, event: unknown) => {
    try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); } catch {}
  };
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        write(controller, { type: "progress", phase: "loading", processed: 0, total: 0, message: "Loading captured lap…" });
        const session = (await getSessions(gameId)).find((candidate) => candidate.id === sessionId);
        if (!session) throw new Error("Session not found");
        const rawFile = await getSessionRawFile(sessionId, gameId);
        if (!rawFile) throw new Error("Session has no replayable raw capture");
        const [{ packets, sourceProfile }, laps] = await Promise.all([getSessionTelemetryReplaySource(sessionId, gameId), getSessionLaps(gameId, sessionId)]);
        if (packets.length === 0) throw new Error("Session has no replayable raw capture");
        const replayPackets = scenario === "f1-opponent-lap-pace" ? progressivePacketSample(packets, gameId) : packets;
        write(controller, { type: "progress", phase: "replaying", processed: 0, total: replayPackets.length, message: `Building timeline from ${replayPackets.length.toLocaleString()} frames…` });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        const replay = runLiveEngineerSessionReplay({ session, laps, packets: replayPackets, sourceProfile, scenario: scenario as LiveEngineerReplayScenario | undefined });
        write(controller, { type: "result", replay });
      } catch (error) {
        write(controller, { type: "error", message: error instanceof Error ? error.message : "Unable to replay session" });
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });
  return new Response(readable, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "Transfer-Encoding": "chunked" } });
});
