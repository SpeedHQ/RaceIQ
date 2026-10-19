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
 *     resolvable `trackId`. Laps that predate telemetry capture, failed to
 *     parse, or belong to a track with no saved corner definitions return
 *     `available: false` with a `reason`.
 *   - `cornerId` (1-based, matching the `T{n}` labels) optionally narrows the
 *     result to a single corner.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getLapById } from "@raceiq/backend-core/db/lap-read-queries";
import { loadSettings } from "@raceiq/backend-core/runtime/config/settings";
import { computeCornerMetrics, type CornerMetrics } from "@raceiq/backend-core/ai/corner-data";
import { resolveLapCorners } from "../../tracks/corner-resolution";
import { AUTO_TURN_TOKEN } from "@raceiq/shared/racing/tracks/segment-label";

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

export function cornerMatchesId(corner: { index: number; label: string }, cornerId: number): boolean {
  if (AUTO_TURN_TOKEN.test(corner.label)) {
    return corner.label.slice(1).split(/[,/]/).some((part) => {
      const range = /^(\d+)-(\d+)$/.exec(part);
      return range
        ? cornerId >= Number(range[1]) && cornerId <= Number(range[2])
        : Number(part) === cornerId;
    });
  }
  // Named stored and detected definitions retain their one-based indices.
  return corner.index === cornerId;
}

export const getCornerMetricsTool = createTool({
  id: "get-corner-metrics",
  description:
    "Fetch structured, per-corner telemetry metrics for a lap: entry/min/exit speed, " +
    "gear, braking distance, time in corner, average throttle and brake, throttle-on " +
    "distance, and a balance verdict (oversteer/understeer/neutral). Pass a `cornerId` " +
    "(1-based, matching the T1/T2/... labels) to narrow to a single corner. Use this to " +
    "ground tuning suggestions in what the car actually did through each corner. If " +
    "`available` is false, report the returned reason. Do not invent corner metrics " +
    "or replace the requested measurements with other corners, lap-wide values, or heuristic tuning advice.",
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

    const trackIdentity = lap.trackId;
    if (trackIdentity === undefined || trackIdentity === null) {
      return emptyResult(lapId, "lap has no track identity");
    }
    if (lap.parseError) {
      return emptyResult(lapId, `lap telemetry failed to parse: ${lap.parseError}`);
    }
    if (lap.telemetry.length === 0) {
      return emptyResult(lapId, "lap has no telemetry");
    }

    let corners = await resolveLapCorners(trackIdentity, lap.gameId, lap.telemetry);
    if (corners.length === 0) {
      return emptyResult(lapId, `no corner definitions available for track identity ${trackIdentity}`);
    }

    // Public cornerId is the T-label number; internal indices may be zero-based.
    if (cornerId !== undefined) {
      corners = corners.filter((corner) => cornerMatchesId(corner, cornerId));
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
