import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { IdParamSchema } from "@raceiq/shared/platform/http/route-schemas";
import { GameIdSchema, type GameId } from "@raceiq/shared/games/ids";
import { getGame } from "@raceiq/shared/games/registry";
import { analyseSemanticIds } from "@raceiq/shared/games/metric-contracts";
import { liveSemanticIds } from "@raceiq/telemetry-core/telemetry/live/semantics";
import { runInsightScanWithCoverage } from "@raceiq/analysis-core/racing/analysis/laps/insights/scan";
import { processLap, restoreFrameIndices } from "@raceiq/analysis-core/racing/analysis/laps/insights/process";
import { INSIGHT_DETECTORS } from "@raceiq/analysis-core/racing/analysis/laps/insights/types";
import { resolveLapAnalysisContext } from "@raceiq/backend-core/lap-analysis/insights";
import { getOrComputeLapInsights, recomputeLapInsights } from "@raceiq/backend-core/lap-analysis/metrics-store";
import { getLapMetaById, getLapById } from "@raceiq/backend-core/db/lap-read-queries";
import { getLapReplaySource } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { loadSessionCapture, resolveLapCaptureArtifact, resolveLiveLapCaptureArtifact } from "@raceiq/backend-core/session-capture/source-loader";
import { createRawCaptureIdentity, loadRawCaptureIdentity } from "@raceiq/backend-core/session-capture/identity";
import { getLiveLapCaptureSnapshot } from "@raceiq/backend-core/db/live-capture-queries";
import { opponentRoutes } from "./opponent-routes";
import { resolveTelemetryReplay } from "@raceiq/backend-core/telemetry/replay";
import type { SemanticLapTelemetry } from "../contracts/replay";

export function semanticReplayIds(gameId: GameId): readonly string[] {
  return analyseSemanticIds(getGame(gameId));
}
const timestampMilliseconds = (timestamp: { domain: string; milliseconds?: number; nanoseconds?: bigint }) =>
  timestamp.domain === "monotonic" ? Number(timestamp.nanoseconds ?? 0n) / 1_000_000 : timestamp.milliseconds ?? 0;

export const replayRoutes = new Hono()
  .get("/api/laps/:id/semantic-telemetry", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const gameIdResult = GameIdSchema.safeParse(c.req.header("X-Game-Id"));
    if (!gameIdResult.success) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
    try {
      const meta = await getLapMetaById(id);
      if (!meta || meta.gameId !== gameIdResult.data) return c.json({ error: "Lap not found" }, 404);
      const lap = await getLapById(id);
      if (!lap) return c.json({ error: "Lap not found" }, 404);
      if (lap.parseError) {
        return c.json({
          lapId: id, requestedSemanticIds: [], sectorTimes: meta.sectorTimes ?? null,
          sectorStarts: null, insights: [], detectorCoverage: INSIGHT_DETECTORS.map((detector) => ({ ...detector, status: "unavailable" as const, reason: "Lap telemetry could not be parsed" })), parseError: lap.parseError, envelopes: [],
        } satisfies SemanticLapTelemetry);
      }
      const source = await getLapReplaySource(id);
      if (!source) return c.json({ error: "Lap not found" }, 404);
      const live = source.captureLayoutVersion === 3 ? await getLiveLapCaptureSnapshot(source.sessionId, id) : null;
      const artifact = source.captureLayoutVersion === 3
        ? live ? resolveLiveLapCaptureArtifact(live.archivePath, live.snapshot) : undefined
        : (source.captureLayoutVersion === 1 || source.captureLayoutVersion === 2) && source.captureManifestFile && source.captureChunkId
          ? await resolveLapCaptureArtifact(source.captureManifestFile, source.captureChunkId, id, source)
          : undefined;
      if (source.captureLayoutVersion === 3 && !artifact) return c.json({ error: "Live lap capture member is not committed" }, 409);
      const replaySource = artifact
        ? { ...source, rawByteOffset: artifact.chunk.ownedFrameByteOffset!, rawFrameCount: artifact.chunk.ownedFrameCount! }
        : source;
      const rawCapture = source.gameId === "iracing"
        ? artifact
          ? createRawCaptureIdentity(
              await loadSessionCapture({ rawFile: artifact.path, artifact: artifact.artifact, source: null, gameId: source.gameId, carId: meta.carId, trackId: meta.trackId }),
              artifact.artifact ? "gzip" : "identity",
            )
          : source.rawFile ? await loadRawCaptureIdentity(source.rawFile) : undefined
        : undefined;
      const semanticIds = meta.gameId === "lmu" ? [...new Set([...semanticReplayIds(meta.gameId), ...liveSemanticIds("lmu")])] : semanticReplayIds(meta.gameId);
      const replay = resolveTelemetryReplay(id, replaySource, lap.telemetry, semanticIds, rawCapture);
      const nativeLayout = getGame(meta.gameId).getNativeSectorLayout?.(lap.telemetry[0]);
      const processed = processLap(lap.telemetry, meta.gameId);
      const analysis = runInsightScanWithCoverage(processed.packets, meta.gameId, resolveLapAnalysisContext(meta.gameId, meta.trackId, processed.packets));
      restoreFrameIndices(analysis.insights, processed.sourceIndices);
      return c.json({
        lapId: replay.lapId, requestedSemanticIds: replay.requestedSemanticIds,
        sectorTimes: meta.sectorTimes ?? null, sectorStarts: nativeLayout?.starts ?? null,
        insights: analysis.insights, detectorCoverage: analysis.detectorCoverage, parseError: lap.parseError ?? null,
        envelopes: replay.envelopes.map((envelope) => ({
          sequence: Number(envelope.sequence),
          observedAt: { domain: "wall-clock", milliseconds: timestampMilliseconds(envelope.observedAt) },
          receivedAt: { domain: "wall-clock", milliseconds: timestampMilliseconds(envelope.receivedAt) },
          simulator: envelope.simulator,
          values: envelope.values.map(({ semanticId, value, unit, state, freshness }) => ({ semanticId, value, unit, state, freshness })),
          ...(envelope.lmu ? { lmu: envelope.lmu } : {}),
        })),
      } satisfies SemanticLapTelemetry);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to replay telemetry" }, 422);
    }
  })
  .post("/api/laps/:id/insights/rerun", zValidator("param", IdParamSchema), async (c) => {
    const insights = await recomputeLapInsights(c.req.valid("param").id);
    return insights ? c.json({ insights }) : c.json({ error: "Lap not found or has no telemetry" }, 404);
  })
  .get("/api/laps/:id/insights", zValidator("param", IdParamSchema), async (c) => {
    const gameId = GameIdSchema.safeParse(c.req.header("X-Game-Id"));
    if (!gameId.success) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
    const { id } = c.req.valid("param");
    const meta = await getLapMetaById(id);
    if (!meta || meta.gameId !== gameId.data) return c.json({ error: "Lap not found" }, 404);
    return c.json({ insights: await getOrComputeLapInsights(id) ?? [] });
  })
  .route("/", opponentRoutes);
