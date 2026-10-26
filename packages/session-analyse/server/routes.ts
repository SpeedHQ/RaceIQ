import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { computeLineSpreadTrace } from "@raceiq/backend-core/lap-analysis/consistency";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { Corner } from "@raceiq/backend-core/lap-analysis/corners";
import { isPaceLap } from "@raceiq/shared/racing/lap-classification";
import { resolveTrack } from "@raceiq/backend-core/tracks/info";
import type { GameId } from "@raceiq/shared/games/ids";
import { getLapById, getLapIdentitiesByIds, getLapProcessingByIds, getLapsByIds, getSessionLaps } from "@raceiq/backend-core/db/lap-read-queries";
import { getSessionProcessingById } from "@raceiq/backend-core/db/session-queries";
import { getOrComputeLapInsightsForLap } from "@raceiq/backend-core/lap-analysis/metrics-store";
import { alignLapSet, prepareLapSetAlignmentIndex, type AlignmentLapInput } from "@raceiq/analysis-core/racing/laps/alignment/build";
import { encodeAlignedLapSet } from "@raceiq/analysis-core/racing/laps/alignment/codec";
import type { EncodedAlignedLapSet } from "@raceiq/analysis-core/racing/laps/alignment/types";
import type { ProcessingMetadata } from "@raceiq/shared/racing/sessions/types";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { GameIdSchema as HeaderGameIdSchema } from "@raceiq/shared/games/ids";
import { ReviewLapsQuerySchema, ReviewLineSpreadQuerySchema, ThreeToImproveSessionParamSchema } from "../contracts/requests";
import { ThreeToImproveEvidenceQuerySchema, type ThreeToImproveResponse } from "../contracts/coaching";
import { getReviewLaps } from "./review-laps";
import { selectCoachingPriorities, type CoachingLap } from "./coaching-selection";

function processingFailure(processing: readonly ProcessingMetadata[]) {
  const failed = processing.find((item) => item.state === "failed");
  if (failed) return { status: 422 as const, body: { code: "RECORDING_PROCESSING_FAILED", error: failed.error?.trim() || "Recording processing failed" } };
  if (processing.some((item) => item.state === "queued" || item.state === "processing")) return { status: 409 as const, body: { code: "RECORDING_PROCESSING", error: "Recording is queued or processing" } };
}
function alignmentInput(lap: { id: number; lapNumber: number; lapTime: number; isValid: boolean; telemetry: TelemetryPacket[]; sectorTimes?: number[] | null }): AlignmentLapInput {
  return { lapId: lap.id, lapNumber: lap.lapNumber, lapTime: lap.lapTime, isValid: lap.isValid, telemetry: lap.telemetry, sectorTimes: lap.sectorTimes ?? null, sectorStarts: null };
}
export function createSessionAnalyseRoutes(resolveLapCorners: (trackId: string | null | undefined, gameId: string | null | undefined, telemetry: TelemetryPacket[]) => Promise<Corner[]>) {
  const routes = new Hono()
    .get("/api/laps/review", zValidator("query", ReviewLapsQuerySchema), async (c) => {
      const { gameId, sessionId, trackId, carId, limit } = c.req.valid("query");
      return c.json(await getReviewLaps(gameId, trackId ?? null, carId ?? null, limit, sessionId));
    })
    .get("/api/laps/review-line-spread", zValidator("query", ReviewLineSpreadQuerySchema), async (c) => {
      const { gameId, sessionId, lapIds } = c.req.valid("query");
      const identities = await getLapIdentitiesByIds(lapIds);
      if (identities.length !== lapIds.length || identities.some((lap) => lap.gameId !== gameId || lap.sessionId !== sessionId)) return c.json({ error: "Selected laps must belong to session." }, 400);
      const processingRows = await getLapProcessingByIds(lapIds);
      if (processingRows.length !== lapIds.length || processingRows.some((lap) => lap.gameId !== gameId || lap.sessionId !== sessionId)) return c.json({ error: "Selected laps must belong to session." }, 400);
      const blocked = processingFailure(processingRows.map((lap) => lap.processing));
      if (blocked) return c.json(blocked.body, blocked.status);
      const processingByLapId = new Map(processingRows.map((lap) => [lap.id, lap.processing] as const));
      const loaded = await getLapsByIds(lapIds, { processingByLapId });
      if (loaded.length !== lapIds.length || loaded.some((lap) => lap.gameId !== gameId || lap.sessionId !== sessionId)) return c.json({ error: "Selected laps must belong to session." }, 400);
      const ordered = lapIds.map((id) => loaded.find((lap) => lap.id === id)!);
      const usable = ordered.filter((lap) => lap.telemetry.length >= 30);
      if (usable.length === 0) return c.json({ fracs: [], spreadM: [], perCorner: [], lowTrust: false, consistencyScore: 0, overallSpreadM: 0, lapCount: 0 });
      const first = usable[0]!;
      const corners = await resolveLapCorners(first.trackId, gameId, first.telemetry);
      const trace = computeLineSpreadTrace(usable.map((lap) => lap.telemetry), usable.map((lap) => lap.id), corners);
      if (!trace) return c.json({ fracs: [], spreadM: [], perCorner: [], lowTrust: false, consistencyScore: 0, overallSpreadM: 0, lapCount: usable.length });
      const { lapLines: _lapLines, ...compactTrace } = trace;
      return c.json(compactTrace);
    })
    .get("/api/sessions/:sessionId/3-to-improve/evidence", zValidator("param", ThreeToImproveSessionParamSchema), zValidator("query", ThreeToImproveEvidenceQuerySchema), async (c) => {
      const gameId = HeaderGameIdSchema.safeParse(c.req.header("X-Game-Id"));
      if (!gameId.success) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
      const { sessionId } = c.req.valid("param");
      const { lapId, sourceFrameIndex } = c.req.valid("query");
      const sessionProcessing = await getSessionProcessingById(sessionId, gameId.data);
      if (!sessionProcessing) return c.json({ error: "Session not found" }, 404);
      const sessionBlocked = processingFailure([sessionProcessing]);
      if (sessionBlocked) return c.json(sessionBlocked.body, sessionBlocked.status);
      const processingRows = await getLapProcessingByIds([lapId]);
      const lapProcessing = processingRows[0];
      if (!lapProcessing || lapProcessing.gameId !== gameId.data || lapProcessing.sessionId !== sessionId) return c.json({ error: "Lap not found" }, 404);
      const blocked = processingFailure([lapProcessing.processing]);
      if (blocked) return c.json(blocked.body, blocked.status);
      const lap = await getLapById(lapId, lapProcessing.processing);
      if (!lap || lap.gameId !== gameId.data || lap.sessionId !== sessionId || (lap.parseError && lap.parseErrorKind === "missing-capture") || (!lap.parseError && lap.telemetry.length === 0)) return c.json({ error: "Lap not found" }, 404);
      if (lap.parseError) throw new Error(`Lap ${lapId} telemetry load failed: ${lap.parseError}`);
      const summary = await buildSummary(sessionId, gameId.data, lap);
      if ("status" in summary) return c.json(summary.body, summary.status);
      const item = summary.items.find((candidate) => candidate.representative.lapId === lapId && candidate.representative.sourceFrameIndex === sourceFrameIndex);
      if (!item) return c.json({ code: "COACHING_EVIDENCE_CHANGED", error: "Session evidence changed. Refresh the insights." }, 409);
      const input = alignmentInput(lap);
      const track = resolveTrack(gameId.data, lap.trackId);
      const alignmentIndex = prepareLapSetAlignmentIndex([input], { gridStepMeters: 1, trackLengthMeters: track.lengthMeters });
      const distances = alignmentIndex.distancesByLapId.get(lap.id);
      const span = alignmentIndex.nominalSpanMeters;
      const fraction = distances && Number.isFinite(distances[sourceFrameIndex]) && span > 0 ? distances[sourceFrameIndex]! / span : null;
      if (fraction == null || fraction < 0 || fraction > 1) return c.json({ code: "COACHING_EVIDENCE_CHANGED", error: "Session evidence changed. Refresh the insights." }, 409);
      const start = Math.max(0, fraction - 0.02) * span;
      const end = Math.min(1, fraction + 0.02) * span;
      const aligned = encodeAlignedLapSet(alignLapSet([input], { gridStepMeters: Math.max(0.1, (end - start) / 599), trackLengthMeters: track.lengthMeters, distanceRangeMeters: { start, end }, preparedIndex: alignmentIndex })) as EncodedAlignedLapSet;
      return c.json({ sessionId, gameId: gameId.data, representative: item.representative, fraction, aligned });
    })
    .get("/api/sessions/:sessionId/3-to-improve", zValidator("param", ThreeToImproveSessionParamSchema), async (c) => {
      const gameId = HeaderGameIdSchema.safeParse(c.req.header("X-Game-Id"));
      if (!gameId.success) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
      const { sessionId } = c.req.valid("param");
      const sessionProcessing = await getSessionProcessingById(sessionId, gameId.data);
      if (!sessionProcessing) return c.json({ error: "Session not found" }, 404);
      const blocked = processingFailure([sessionProcessing]);
      if (blocked) return c.json(blocked.body, blocked.status);
      const summary = await buildSummary(sessionId, gameId.data);
      if ("status" in summary) return c.json(summary.body, summary.status);
      return c.json(summary);
    });
  return routes;

  async function buildSummary(sessionId: number, gameId: GameId, preloadedLap?: (LapMeta & { telemetry: TelemetryPacket[]; parseError?: string; parseErrorKind?: "missing-capture" | "failure" }) | null): Promise<ThreeToImproveResponse | { status: 409 | 422; body: { code: string; error: string } }> {
    const metadata = await getSessionLaps(gameId, sessionId);
    const eligible = metadata.filter((lap) => lap.isValid && isPaceLap(lap.classification) && Number.isFinite(lap.lapTime) && lap.lapTime > 0 && !lap.experimentExcluded);
    const excludedLapCount = metadata.length - eligible.length;
    const processingRows = await getLapProcessingByIds(eligible.map((lap) => lap.id));
    if (processingRows.length !== eligible.length) throw new Error("Session lap processing metadata changed during coaching analysis");
    const blocked = processingFailure(processingRows.map((lap) => lap.processing));
    if (blocked) return { status: blocked.status, body: blocked.body };
    const processingByLapId = new Map(processingRows.map((lap) => [lap.id, lap.processing] as const));
    const coachingLaps: CoachingLap[] = [];
    let analyzedLapCount = 0;
    for (const meta of eligible) {
      const processing = processingByLapId.get(meta.id)!;
      const lap = preloadedLap?.id === meta.id ? preloadedLap : await getLapById(meta.id, processing);
      if (!lap) {
        if (meta.telemetryAvailable) throw new Error(`Lap ${meta.id} disappeared during coaching analysis`);
        continue;
      }
      if (lap.parseError) {
        if (lap.parseErrorKind === "missing-capture") continue;
        throw new Error(`Lap ${meta.id} telemetry load failed: ${lap.parseError}`);
      }
      if (lap.telemetry.length < 30) continue;
      const insights = await getOrComputeLapInsightsForLap(lap);
      if (!insights) continue;
      analyzedLapCount++;
      const input = alignmentInput(lap);
      const track = resolveTrack(gameId, lap.trackId);
      const alignmentIndex = prepareLapSetAlignmentIndex([input], { gridStepMeters: 1, trackLengthMeters: track.lengthMeters });
      const distances = alignmentIndex.distancesByLapId.get(lap.id);
      const span = alignmentIndex.nominalSpanMeters;
      const sourceFractions = new Map<number, number>();
      for (const insight of insights) {
        for (const sourceFrameIndex of insight.frameIndices) {
          const distance = distances?.[sourceFrameIndex];
          if (Number.isFinite(distance) && span > 0) sourceFractions.set(sourceFrameIndex, distance! / span);
        }
      }
      const corners = track.segments.filter((segment) => segment.type === "corner");
      coachingLaps.push({
        lapId: lap.id,
        lapNumber: lap.lapNumber,
        insights,
        fractionAtSourceFrame: (index) => sourceFractions.get(index) ?? null,
        cornerAtFraction: (fraction) => corners.find((segment) => fraction >= segment.startFrac && fraction <= segment.endFrac)?.name ?? null,
      });
    }
    const selection = selectCoachingPriorities(coachingLaps);
    const state = selection.items.length > 0 ? "ready" : analyzedLapCount === 0 || selection.unlocatedEvidenceCount > 0 ? "insufficient-data" : "no-actionable-findings";
    return { sessionId, gameId, state, eligibleLapCount: eligible.length, analyzedLapCount, excludedLapCount, unlocatedEvidenceCount: selection.unlocatedEvidenceCount, items: selection.items };
  }
}
