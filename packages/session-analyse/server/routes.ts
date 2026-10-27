import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { Corner } from "@raceiq/backend-core/lap-analysis/corners";
import { getLapIdentitiesByIds, getLapProcessingByIds, getLapsByIds } from "@raceiq/backend-core/db/lap-read-queries";
import type { ProcessingMetadata } from "@raceiq/shared/racing/sessions/types";
import { computeLineSpreadTrace } from "@raceiq/backend-core/lap-analysis/consistency";
import { ReviewLapsQuerySchema, ReviewLineSpreadQuerySchema } from "../contracts/requests";
import { getReviewLaps } from "./review-laps";
type ProcessingFailure = {
  status: 409 | 422;
  body: { code: "RECORDING_PROCESSING" | "RECORDING_PROCESSING_FAILED"; error: string };
};

function processingFailure(processing: readonly ProcessingMetadata[]): ProcessingFailure | undefined {
  const failed = processing.find((item) => item.state === "failed");
  if (failed) {
    return { status: 422, body: { code: "RECORDING_PROCESSING_FAILED", error: failed.error?.trim() || "Recording processing failed" } };
  }
  if (processing.some((item) => item.state === "queued" || item.state === "processing")) {
    return { status: 409, body: { code: "RECORDING_PROCESSING", error: "Recording is queued or processing" } };
  }
}

export function createSessionAnalyseRoutes(resolveLapCorners: (trackId: string | null | undefined, gameId: string | null | undefined, telemetry: TelemetryPacket[]) => Promise<Corner[]>) {
  return new Hono()
    .get("/api/laps/review", zValidator("query", ReviewLapsQuerySchema), async (c) => {
      const { gameId, sessionId, trackId, carId, limit } = c.req.valid("query");
      return c.json(await getReviewLaps(gameId, trackId ?? null, carId ?? null, limit, sessionId));
    })
    .get("/api/laps/review-line-spread", zValidator("query", ReviewLineSpreadQuerySchema), async (c) => {
      const { gameId, sessionId, lapIds } = c.req.valid("query");
      const identities = await getLapIdentitiesByIds(lapIds);
      if (identities.length !== lapIds.length || identities.some((lap) => lap.gameId !== gameId || lap.sessionId !== sessionId)) {
        return c.json({ error: "Selected laps must belong to session." }, 400);
      }
      const processingRows = await getLapProcessingByIds(lapIds);
      if (processingRows.length !== lapIds.length || processingRows.some((lap) => lap.gameId !== gameId || lap.sessionId !== sessionId)) {
        return c.json({ error: "Selected laps must belong to session." }, 400);
      }
      const blocked = processingFailure(processingRows.map((lap) => lap.processing));
      if (blocked) return c.json(blocked.body, blocked.status);
      const processingByLapId = new Map(processingRows.map((lap) => [lap.id, lap.processing] as const));

      const loaded = await getLapsByIds(lapIds, { processingByLapId });
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
