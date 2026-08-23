/**
 * Mastra tool: getCornerMetrics
 *
 * Lets the Lap Analyst agent pull structured, per-corner telemetry metrics for
 * a lap — entry/min/exit speed, gear, braking distance, time in corner, throttle
 * and brake averages, throttle-on distance, and a rough balance verdict
 * (oversteer / understeer / neutral). Backed by the same pure
 * `computeCornerMetrics` used by the prompt-string `buildCornerData`, so the
 * structured tool output and the human-readable prompt table never diverge.
 *
 * Scope:
 *   - Requires the lap to have telemetry (`rawByteOffset`/`rawFrameCount`) and a
 *     resolvable `trackOrdinal`. Laps that predate telemetry capture, failed to
 *     parse, or belong to a track with no saved corner definitions return
 *     `available: false` with a `reason`.
 *   - `cornerId` (1-based, matching the `T{n}` labels) optionally narrows the
 *     result to a single corner.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getLapMetaById } from "../../server/db/lap-read-queries";
import { loadSettings } from "../../server/runtime/config/settings";
import { computeCornerMetrics, type CornerMetrics } from "../../server/ai/corner-data";
import { queryLapTelemetryBySemanticId } from "../../server/telemetry/replay";
import { semanticFixedNumbers, semanticNumber, semanticSamplesFromReplay } from "../../server/telemetry/semantic-samples";
import { resolveSemanticLapCorners } from "../../server/tracks/corner-resolution";
import { CANONICAL_LAP_ANALYSIS_SEMANTIC_IDS } from "../../shared/racing/analysis/laps/semantic-frame";
import { GameIdSchema } from "../../shared/games/ids";

interface CornerMetricsResult {
  available: boolean;
  reason?: string;
  lapId: number;
  speedUnit?: "mph" | "kmh";
  corners: CornerMetrics[];
}

function emptyResult(lapId: number, reason: string): CornerMetricsResult {
  return { available: false, reason, lapId, corners: [] };
}

export const getCornerMetricsTool = createTool({
  id: "get-corner-metrics",
  description:
    "Fetch structured, per-corner telemetry metrics for a lap: entry/min/exit speed, " +
    "gear, braking distance, time in corner, average throttle and brake, throttle-on " +
    "distance, and a balance verdict (oversteer/understeer/neutral). Pass a `cornerId` " +
    "(1-based, matching T1/T2/... labels) to narrow result. If `available` is false, " +
    "skip corner analysis and rely on general heuristics.",
  inputSchema: z.object({
    lapId: z.number().int().positive().describe("Database ID of lap to analyse."),
    gameId: GameIdSchema.describe("Game owning lap; must match persisted lap game."),
    cornerId: z.number().int().positive().optional().describe("1-based corner number (matching T{n}) to narrow result. Omit for all corners."),
  }),
  outputSchema: z.object({
    available: z.boolean(),
    reason: z.string().optional().describe("Why metrics are unavailable, if they are."),
    lapId: z.number(),
    speedUnit: z.enum(["mph", "kmh"]).optional(),
    corners: z.array(
      z.object({
        label: z.string(),
        entrySpeed: z.number().nullable(),
        minSpeed: z.number().nullable(),
        exitSpeed: z.number().nullable(),
        gear: z.number().nullable(),
        brakingDistance: z.number().nullable(),
        timeInCorner: z.number().nullable(),
        avgThrottle: z.number().nullable(),
        avgBrake: z.number().nullable(),
        throttleOnDist: z.number().nullable(),
        balance: z.enum(["oversteer", "understeer", "neutral"]).nullable(),
      }),
    ),
  }),
  execute: async (inputData) => {
    const { lapId, cornerId, gameId } = inputData;
    const lap = await getLapMetaById(lapId);
    if (!lap) return emptyResult(lapId, "lap not found");
    if (lap.gameId !== gameId) return emptyResult(lapId, "lap belongs to a different game");
    const trackOrdinal = lap.trackOrdinal;
    if (trackOrdinal == null) return emptyResult(lapId, "lap has no trackOrdinal");

    let replay;
    try {
      replay = await queryLapTelemetryBySemanticId(lapId, CANONICAL_LAP_ANALYSIS_SEMANTIC_IDS);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === `Lap ${lapId} has no replayable telemetry`) return emptyResult(lapId, "lap has no semantic telemetry");
      throw error;
    }
    const samples = replay ? semanticSamplesFromReplay(replay) : [];
    const usableSamples = samples.filter(
      (sample) =>
        semanticNumber(sample, "timing.distance-traveled") != null &&
        semanticNumber(sample, "motion.velocity-x") != null &&
        semanticNumber(sample, "motion.velocity-y") != null &&
        semanticNumber(sample, "motion.velocity-z") != null &&
        semanticNumber(sample, "inputs.gear") != null &&
        semanticNumber(sample, "inputs.accel") != null &&
        semanticNumber(sample, "inputs.brake") != null &&
        semanticFixedNumbers(sample, "tires.tire-slip-angle", 4) != null,
    );
    if (usableSamples.length === 0) return emptyResult(lapId, "lap has no complete semantic corner telemetry");

    let corners = await resolveSemanticLapCorners(trackOrdinal, gameId, usableSamples);
    if (corners.length === 0) return emptyResult(lapId, `no corner definitions available for track ordinal ${trackOrdinal}`);
    if (cornerId !== undefined) {
      corners = corners.filter((corner) => corner.label === `T${cornerId}` || corner.index === cornerId || corner.index + 1 === cornerId);
      if (corners.length === 0) return emptyResult(lapId, `corner ${cornerId} not found for this track`);
    }

    const speedUnit: "mph" | "kmh" = loadSettings().unit === "metric" ? "kmh" : "mph";
    const metrics = computeCornerMetrics(usableSamples, corners, speedUnit);
    if (metrics.length === 0) return emptyResult(lapId, "no semantic telemetry samples fell within corner distance ranges");
    return { available: true, lapId, speedUnit, corners: metrics };
  },
});
