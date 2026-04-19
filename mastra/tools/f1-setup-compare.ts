/**
 * Mastra tool: compareF1SetupToCatalog
 *
 * Lets the Lap Analyst agent pull the current lap's F1 25 car setup AND the
 * top-N fastest community setups for the same track, pre-diffed, in one
 * call. The agent then reasons over the diff and makes tuning suggestions
 * that are grounded in what fast drivers actually run.
 *
 * Scope:
 *   - F1 2025 only (other games return `available: false`)
 *   - Requires the lap to have a saved setup (`laps.carSetup`); older laps
 *     predate setup capture and will also return `available: false`
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getLapById } from "../../server/db/queries";
import {
  topCatalogReferences,
  getCatalogFolderForTrack,
  getCatalogDisplayName,
  normalizePacketSetup,
  type F1Setup,
} from "../../server/ai/f1-setup-catalog";

const SetupRecord = z.record(z.string(), z.number());

export const compareF1SetupToCatalogTool = createTool({
  id: "compare-f1-setup-to-catalog",
  description:
    "For an F1 2025 lap, fetch the driver's current car setup and compare it against " +
    "the top-N fastest community setups (via f1laps) for the same track. Returns the " +
    "current setup, each reference setup, and the per-field delta (reference - current). " +
    "Use this before making tuning recommendations so suggestions are grounded in what " +
    "fast drivers actually run. If `available` is false, skip the comparison and rely " +
    "on general F1 tuning heuristics.",
  inputSchema: z.object({
    lapId: z
      .number()
      .int()
      .positive()
      .describe("Database ID of the F1 2025 lap being analysed."),
    // NOTE: Don't combine `.default()` with the surrounding JSON-schema
    // emission — Mastra + LM Studio marked the field as `required` while
    // also declaring a default, which made the validator reject calls that
    // omit `limit` with "expected number, received undefined". Keep it
    // optional and apply the default inside execute.
    limit: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("How many reference setups to return, ranked by lap time. Defaults to 5."),
  }),
  outputSchema: z.object({
    available: z.boolean(),
    reason: z.string().optional().describe("Why the comparison is unavailable, if it is."),
    lapId: z.number(),
    trackName: z.string().optional(),
    catalogFolder: z.string().optional(),
    currentSetup: SetupRecord.optional(),
    references: z
      .array(
        z.object({
          rank: z.number(),
          lapTime: z.string(),
          lapTimeSeconds: z.number(),
          team: z.string(),
          author: z.string(),
          weather: z.string(),
          inputDevice: z.string(),
          setup: SetupRecord,
          delta: SetupRecord,
        }),
      )
      .default([]),
  }),
  execute: async (inputData) => {
    const { lapId, limit: rawLimit } = inputData;
    const limit = rawLimit ?? 5;
    const lap = await getLapById(lapId);

    if (!lap) {
      return emptyResult(lapId, "lap not found");
    }
    if (lap.gameId !== "f1-2025") {
      return emptyResult(lapId, `lap ${lapId} is ${lap.gameId ?? "unknown game"}, not f1-2025`);
    }

    // carSetup JSON column is populated on lap save. Older laps predate that
    // capture, but the telemetry packets themselves carry `f1.setup` on every
    // frame — scan as a fallback so the tool still works on historical laps.
    const currentSetup =
      parseSetup(lap.carSetup) ?? extractSetupFromTelemetry(lap.telemetry);
    if (!currentSetup) {
      return emptyResult(lapId, "lap has no carSetup column and no f1.setup on telemetry packets");
    }

    const trackOrdinal = lap.trackOrdinal;
    if (trackOrdinal === undefined || trackOrdinal === null) {
      return emptyResult(lapId, "lap has no trackOrdinal");
    }

    const folder = getCatalogFolderForTrack(trackOrdinal);
    if (!folder) {
      return emptyResult(lapId, `no catalog coverage for track ordinal ${trackOrdinal}`);
    }

    const references = topCatalogReferences(trackOrdinal, limit, currentSetup).map((r) => {
      // Coerce Partial<F1Setup> to Record<string, number> by stripping any
      // undefined values — the zod outputSchema requires a strict numeric map.
      const delta: Record<string, number> = {};
      for (const [k, v] of Object.entries(r.delta ?? {})) {
        if (typeof v === "number") delta[k] = v;
      }
      return {
        rank: r.rank,
        lapTime: r.lapTime,
        lapTimeSeconds: r.lapTimeSeconds,
        team: r.team,
        author: r.author,
        weather: r.weather,
        inputDevice: r.inputDevice,
        setup: r.setup,
        delta,
      };
    });

    return {
      available: references.length > 0,
      lapId,
      trackName: getCatalogDisplayName(trackOrdinal),
      catalogFolder: folder,
      currentSetup,
      references,
      reason: references.length === 0 ? "catalog folder exists but contains no setups" : undefined,
    };
  },
});

function emptyResult(lapId: number, reason: string) {
  return {
    available: false,
    reason,
    lapId,
    references: [],
  };
}

function extractSetupFromTelemetry(
  packets: import("../../shared/types").TelemetryPacket[] | undefined,
): F1Setup | null {
  if (!packets || packets.length === 0) return null;
  for (const p of packets) {
    const s = p.f1?.setup;
    if (s && typeof s === "object") {
      const normalised = normalizePacketSetup(s as unknown as Record<string, unknown>);
      if (Object.keys(normalised).length > 0) return normalised;
    }
  }
  return null;
}

function parseSetup(raw: string | undefined): F1Setup | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const normalised = normalizePacketSetup(parsed as Record<string, unknown>);
    return Object.keys(normalised).length > 0 ? normalised : null;
  } catch {
    return null;
  }
}
