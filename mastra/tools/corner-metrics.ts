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
import { getLapById, getCorners } from "../../server/db/queries";
import { loadSettings } from "../../server/settings";
import { computeCornerMetrics, type CornerMetrics } from "../../server/ai/corner-data";

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
    "(1-based, matching the T1/T2/... labels) to narrow to a single corner. Use this to " +
    "ground tuning suggestions in what the car actually did through each corner. If " +
    "`available` is false, the lap has no telemetry or no corner definitions — skip " +
    "corner analysis and rely on general heuristics.",
  inputSchema: z.object({
    lapId: z
      .number()
      .int()
      .positive()
      .describe("Database ID of the lap to analyse."),
    // NOTE: keep optional (not `.default()`) — Mastra + LM Studio mishandle a
    // field that is both `required` and defaulted, rejecting calls that omit it.
    cornerId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("1-based corner number (matching the T{n} label) to narrow the result to a single corner. Omit for all corners."),
  }),
  outputSchema: z.object({
    available: z.boolean(),
    reason: z.string().optional().describe("Why metrics are unavailable, if they are."),
    lapId: z.number(),
    speedUnit: z.enum(["mph", "kmh"]).optional(),
    corners: z.array(
      z.object({
        label: z.string(),
        entrySpeed: z.number(),
        minSpeed: z.number(),
        exitSpeed: z.number(),
        gear: z.number(),
        brakingDistance: z.number(),
        timeInCorner: z.number(),
        avgThrottle: z.number(),
        avgBrake: z.number(),
        throttleOnDist: z.number(),
        balance: z.enum(["oversteer", "understeer", "neutral"]),
      })
    ),
  }),
  execute: async (inputData) => {
    const { lapId, cornerId } = inputData;

    const lap = await getLapById(lapId);
    if (!lap) {
      return emptyResult(lapId, "lap not found");
    }

    const trackOrdinal = lap.trackOrdinal;
    if (trackOrdinal === undefined || trackOrdinal === null) {
      return emptyResult(lapId, "lap has no trackOrdinal");
    }
    if (lap.parseError) {
      return emptyResult(lapId, `lap telemetry failed to parse: ${lap.parseError}`);
    }
    if (lap.telemetry.length === 0) {
      return emptyResult(lapId, "lap has no telemetry");
    }

    let corners = await getCorners(trackOrdinal, lap.gameId as Parameters<typeof getCorners>[1]);
    if (corners.length === 0) {
      return emptyResult(lapId, `no corner definitions saved for track ordinal ${trackOrdinal}`);
    }

    // Optional narrowing to a single corner. `cornerId` is the 1-based ordinal,
    // which matches `CornerDef.index` (T1 -> index 1). Filter the corner list
    // before computing so the metric math only runs over the requested corner.
    if (cornerId !== undefined) {
      corners = corners.filter((c) => c.index === cornerId);
      if (corners.length === 0) {
        return emptyResult(lapId, `corner ${cornerId} not found for this track`);
      }
    }

    const speedUnit: "mph" | "kmh" = loadSettings().unit === "metric" ? "kmh" : "mph";
    const metrics = computeCornerMetrics(lap.telemetry, corners, speedUnit);

    if (metrics.length === 0) {
      return emptyResult(lapId, "no telemetry packets fell within the corner distance ranges");
    }

    return {
      available: true,
      lapId,
      speedUnit,
      corners: metrics,
    };
  },
});
