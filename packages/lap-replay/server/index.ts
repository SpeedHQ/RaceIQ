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
import { resolveTelemetryReplay, visitTelemetryReplayFrames } from "@raceiq/backend-core/telemetry/replay";
import { canonicalizeTelemetryScalar } from "@raceiq/telemetry-core/telemetry/replay/canonicalize";
import { createLmuContextEncoder } from "@raceiq/shared/telemetry/lmu-context";
import { createSemanticReplayEncoder, SEMANTIC_REPLAY_MEDIA_TYPE } from "../contracts/replay-wire";
import type { SemanticLapTelemetry } from "../contracts/replay";
const IRACING_TRACK_MAP_SEMANTIC_IDS: Record<string, true> = {
  "identity.track.latitude": true,
  "identity.track.longitude": true,
  "motion.latitude": true,
  "motion.longitude": true,
  "timing.lap-fraction": true,
};
import type { ProcessingMetadata } from "@raceiq/shared/racing/sessions/types";

export function semanticReplayIds(gameId: GameId): readonly string[] {
  return analyseSemanticIds(getGame(gameId));
}
const timestampMilliseconds = (timestamp: { domain: string; milliseconds?: number; nanoseconds?: bigint }) =>
  timestamp.domain === "monotonic" ? Number(timestamp.nanoseconds ?? 0n) / 1_000_000 : timestamp.milliseconds ?? 0;

function processingFailure(processing: ProcessingMetadata) {
  if (processing.state === "queued" || processing.state === "processing") {
    return { code: "RECORDING_PROCESSING", error: "Recording is queued or processing", status: 409 as const };
  }
  if (processing.state === "failed") {
    return { code: "RECORDING_PROCESSING_FAILED", error: processing.error, status: 422 as const };
  }
  return null;
}

export const replayRoutes = new Hono()
  .get("/api/laps/:id/semantic-telemetry", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const gameIdResult = GameIdSchema.safeParse(c.req.header("X-Game-Id"));
    if (!gameIdResult.success) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
    c.header("Vary", "Accept");
    try {
      const meta = await getLapMetaById(id);
      if (!meta || meta.gameId !== gameIdResult.data) return c.json({ error: "Lap not found" }, 404);
      const source = await getLapReplaySource(id);
      if (!source) return c.json({ error: "Lap not found" }, 404);
      const live = source.captureLayoutVersion === 3 ? await getLiveLapCaptureSnapshot(source.sessionId, id) : null;
      if (!(source.captureLayoutVersion === 3 && !live) && meta.processing.stage !== "opponent-index") {
        const blocked = processingFailure(meta.processing);
        if (blocked) return c.json({ code: blocked.code, error: blocked.error }, blocked.status);
      }
      const lap = await getLapById(id, meta.processing);
      if (!lap) return c.json({ error: "Lap not found" }, 404);
      const trackMapView = c.req.query("view") === "track-map";
      if (trackMapView && gameIdResult.data !== "iracing") return c.json({ error: "Track map replay is only available for iRacing" }, 400);
      if (lap.parseError) {
        if (trackMapView) return c.json({ lapId: id, trackOrigin: null, samples: [], parseError: lap.parseError });
        return c.json({
          lapId: id, requestedSemanticIds: [], sectorTimes: meta.sectorTimes ?? null,
          sectorStarts: null, insights: [], detectorCoverage: INSIGHT_DETECTORS.map((detector) => ({ ...detector, status: "unavailable" as const, reason: "Lap telemetry could not be parsed" })), parseError: lap.parseError, envelopes: [],
        } satisfies SemanticLapTelemetry);
      }
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
      if (trackMapView) {
        const trackMapSemanticIds = semanticReplayIds("iracing").filter((semanticId) => IRACING_TRACK_MAP_SEMANTIC_IDS[semanticId] === true);
        const trackMapReplay = resolveTelemetryReplay(id, replaySource, lap.telemetry, trackMapSemanticIds, rawCapture);
        const readNumber = (values: typeof trackMapReplay.envelopes[number]["values"], semanticId: string) => {
          const value = values.find((entry) => entry.semanticId === semanticId);
          return value
            && (value.state === undefined || value.state === "ok")
            && (value.freshness === undefined || value.freshness === "fresh")
            && typeof value.value === "number"
            && Number.isFinite(value.value)
            ? value.value
            : null;
        };
        const firstNumber = (semanticId: string) => {
          for (const envelope of trackMapReplay.envelopes) {
            const value = readNumber(envelope.values, semanticId);
            if (value !== null) return value;
          }
          return null;
        };
        const latitude = firstNumber("identity.track.latitude");
        const longitude = firstNumber("identity.track.longitude");
        return c.json({
          lapId: trackMapReplay.lapId,
          trackOrigin: latitude !== null && longitude !== null ? { latitude, longitude } : null,
          samples: trackMapReplay.envelopes.map(({ values }) => ({
            latitude: readNumber(values, "motion.latitude"),
            longitude: readNumber(values, "motion.longitude"),
            fraction: readNumber(values, "timing.lap-fraction"),
          })),
        });
      }
      const semanticIds = meta.gameId === "lmu" ? [...new Set([...semanticReplayIds(meta.gameId), ...liveSemanticIds("lmu")])] : semanticReplayIds(meta.gameId);
      const compact = c.req.header("Accept")?.split(",").some((value) => value.trim() === SEMANTIC_REPLAY_MEDIA_TYPE) ?? false;
      const encoder = compact ? createSemanticReplayEncoder() : undefined;
      const encodeContext = createLmuContextEncoder();
      const requestedSemanticIds = encoder
        ? visitTelemetryReplayFrames(id, replaySource, lap.telemetry, semanticIds, (frame, _resolver, slots) => {
            encoder.addFrame({
              sequence: frame.sequence,
              observedAt: { domain: "wall-clock", milliseconds: timestampMilliseconds(frame.observedAt) },
              receivedAt: { domain: "wall-clock", milliseconds: timestampMilliseconds(frame.receivedAt) },
              simulator: source.gameId,
              values: slots.map((slot) => {
                const sample = frame.view.resolveSample(slot);
                sample.value = canonicalizeTelemetryScalar(sample.value, sample.semanticId);
                return sample;
              }),
              ...(meta.gameId === "lmu" && frame.packet.lmuContext ? { lmu: encodeContext(frame.packet.lmuContext) } : {}),
            });
          }, rawCapture)
        : undefined;
      const replay = encoder ? undefined : resolveTelemetryReplay(id, replaySource, lap.telemetry, semanticIds, rawCapture);
      const nativeLayout = getGame(meta.gameId).getNativeSectorLayout?.(lap.telemetry[0]);
      const processed = processLap(lap.telemetry, meta.gameId);
      const analysis = runInsightScanWithCoverage(processed.packets, meta.gameId, resolveLapAnalysisContext(meta.gameId, meta.trackId, processed.packets));
      restoreFrameIndices(analysis.insights, processed.sourceIndices);
      const metadata = {
        lapId: id, requestedSemanticIds: requestedSemanticIds ?? replay!.requestedSemanticIds,
        sectorTimes: meta.sectorTimes ?? null, sectorStarts: nativeLayout?.starts ?? null,
        insights: analysis.insights, detectorCoverage: analysis.detectorCoverage, parseError: lap.parseError ?? null,
      };
      if (encoder) {
        return c.body(JSON.stringify(encoder.finish(metadata)), 200, { "Content-Type": SEMANTIC_REPLAY_MEDIA_TYPE });
      }
      return c.json({
        ...metadata,
        envelopes: replay!.envelopes.map((envelope) => ({
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
    const { id } = c.req.valid("param");
    const meta = await getLapMetaById(id);
    if (!meta) return c.json({ error: "Lap not found or has no telemetry" }, 404);
    const blocked = processingFailure(meta.processing);
    if (blocked) return c.json({ code: blocked.code, error: blocked.error }, blocked.status);
    const insights = await recomputeLapInsights(id);
    return insights ? c.json({ insights }) : c.json({ error: "Lap not found or has no telemetry" }, 404);
  })
  .get("/api/laps/:id/insights", zValidator("param", IdParamSchema), async (c) => {
    const gameId = GameIdSchema.safeParse(c.req.header("X-Game-Id"));
    if (!gameId.success) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
    const { id } = c.req.valid("param");
    const meta = await getLapMetaById(id);
    if (!meta || meta.gameId !== gameId.data) return c.json({ error: "Lap not found" }, 404);
    const blocked = processingFailure(meta.processing);
    if (blocked) return c.json({ code: blocked.code, error: blocked.error }, blocked.status);
    return c.json({ insights: await getOrComputeLapInsights(id) ?? [] });
  })
  .route("/", opponentRoutes);
