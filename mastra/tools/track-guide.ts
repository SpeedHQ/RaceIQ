/**
 * Mastra tool: getTrackGuide
 *
 * Exposes the expert track guide data as a callable tool for AI agents.
 * Chat agents can invoke this mid-conversation when the driver asks about
 * a specific track's corners, racing line, or technique.
 *
 * Also usable as a workflow step input.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { buildTrackGuideContext, getAvailableTrackGuides } from "../../server/ai/track-guides";

export const getTrackGuideTool = createTool({
  id: "get-track-guide",
  description:
    "Fetch expert corner-by-corner track knowledge for a racing circuit. " +
    "Returns ideal technique, common traps, and priority corners. " +
    "Use this when discussing a specific track, reviewing a lap, or the driver asks about racing line / braking / technique at a circuit.",
  inputSchema: z.object({
    trackName: z
      .string()
      .describe(
        "Track name or identifier — e.g. 'Spa', 'Silverstone', 'Monza', 'Suzuka'. " +
        "Can be a full display name or short name."
      ),
  }),
  outputSchema: z.object({
    guide: z.string().describe("Formatted track guide text, or empty string if no guide is available"),
    available: z.boolean().describe("Whether a guide was found for this track"),
  }),
  execute: async (inputData) => {
    const guide = buildTrackGuideContext(inputData.trackName);
    return {
      guide,
      available: guide.length > 0,
    };
  },
});

export const listTrackGuidesTool = createTool({
  id: "list-track-guides",
  description:
    "List all tracks that have expert guides available. " +
    "Use this when the driver asks which tracks have detailed coaching data.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    tracks: z.array(z.string()).describe("Track IDs with available guides"),
  }),
  execute: async () => {
    return { tracks: getAvailableTrackGuides() };
  },
});
