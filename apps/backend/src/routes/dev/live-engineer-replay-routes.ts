import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { GameIdSchema } from "@raceiq/shared/games/ids";
import { getSessions } from "@raceiq/backend-core/db/session-queries";
import { getSessionLaps } from "@raceiq/backend-core/db/lap-read-queries";
import { getSessionRawFile, getSessionTelemetryReplaySource } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { runLiveEngineerSessionReplay, type LiveEngineerSessionReplayInput } from "@raceiq/live-engineer/live-engineer-replay";
import { readRecordedTelemetry } from "../../session-capture/replay-packets";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ENGINEER_REPLAY_PRESETS } from "@raceiq/shared/racing/live/engineer-replay-contracts";

const Query = z.object({ gameId: GameIdSchema, sessionId: z.coerce.number().int().positive().optional(), scenario: z.enum(["fuel-warning-escalation", "critical-fuel-pit-sequence", "sufficient-fuel-control", "scheduled-pit-sequence", "f1-opponent-lap-pace", "recorded-multi-lap"]).optional() });
async function replaySource({ gameId, sessionId, scenario }: z.infer<typeof Query>): Promise<LiveEngineerSessionReplayInput> {
  const selector = scenario === "sufficient-fuel-control" ? "critical-fuel-pit-sequence" : scenario;
  const preset = ENGINEER_REPLAY_PRESETS.find(item => item.recordingGameId === gameId && item.backendScenario === selector);
  if (preset) {
    const path = resolve(process.env.RACEIQ_APP_ROOT ?? process.cwd(), preset.recordingBin);
    if (!existsSync(path)) throw new ReplaySourceError(`Recording not found: ${preset.recordingBin}`, 404);
    const { packets } = readRecordedTelemetry(gameId, path);
    if (!packets.length) throw new ReplaySourceError(`No replayable packets: ${preset.recordingBin}`, 422);
    const compactTimeline = scenario === "recorded-multi-lap" || scenario === "f1-opponent-lap-pace";
    return { session: { id: 0, gameId, trackId: packets[0]?.trackId, carId: packets[0]?.carId }, packets, laps: [], compactTimeline, scenario: scenario === "recorded-multi-lap" ? undefined : scenario,
      sourceProfile: { gameId, captureKind: "recording", limitations: compactTimeline ? ["All packets evaluated. Timeline retains periodic snapshots, lap crossings, availability transitions, and event frames."] : [], retainedPrefix: true, nativeSessionInfo: false, sourceClockCaptured: true, segmentCount: 1 + packets.reduce((count, packet, i) => count + Number(i > 0 && packet.sessionUID !== packets[i - 1]?.sessionUID), 0), skippedMalformedFrames: 0, opponentSourceCapture: null } };
  }
  if (scenario === "recorded-multi-lap") throw new ReplaySourceError(`No recorded multi-lap preset for ${gameId}`, 400);
  if (sessionId === undefined) throw new ReplaySourceError("Session ID required for persisted replay", 400);
  const session = (await getSessions(gameId)).find((candidate) => candidate.id === sessionId);
  if (!session) throw new ReplaySourceError("Session not found", 404);
  if (!await getSessionRawFile(sessionId, gameId)) throw new ReplaySourceError("Session has no replayable raw capture", 409);
  const [source, laps] = await Promise.all([getSessionTelemetryReplaySource(sessionId, gameId), getSessionLaps(gameId, sessionId)]);
  if (!source.packets.length) throw new ReplaySourceError("Session has no replayable raw capture", 409);
  return { ...source, session, laps, scenario };
}

class ReplaySourceError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 422;
  constructor(message: string, status: ReplaySourceError["status"]) {
    super(message);
    this.status = status;
  }
}
export const liveEngineerReplayRoutes = new Hono().get("/api/dev/live-engineer/session-replay", zValidator("query", Query), async (c) => {
  try {
    return c.json(runLiveEngineerSessionReplay(await replaySource(c.req.valid("query"))));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unable to replay session" }, error instanceof ReplaySourceError ? error.status : 422);
  }
});

liveEngineerReplayRoutes.get("/api/dev/live-engineer/session-replay-stream", zValidator("query", Query), async (c) => {
  const query = c.req.valid("query");
  const encoder = new TextEncoder();
  const write = (controller: ReadableStreamDefaultController<Uint8Array>, event: unknown) => {
    try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); } catch {}
  };
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        write(controller, { type: "progress", phase: "loading", processed: 0, total: 0, message: "Loading captured lap…" });
        const source = await replaySource(query);
        write(controller, { type: "progress", phase: "replaying", processed: 0, total: source.packets.length, message: `Building timeline from ${source.packets.length.toLocaleString()} frames…` });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        const replay = runLiveEngineerSessionReplay(source);
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
