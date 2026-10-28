/**
 * Mastra tool: getTireTempGuide
 *
 * Exposes the per-game, per-compound optimal tire core-temperature windows
 * published in game metadata. Chat and analysis agents call it when discussing
 * tire temperatures, warm-up, cold tires, or compound choice.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { GameId } from "@raceiq/shared/games/ids";
import { formatTireTempGuide } from "@raceiq/backend-core/ai/tire-temp-guide";

type RequestContextLike = { get?: (key: string) => unknown } | undefined;

export const getTireTempGuideTool = createTool({
  id: "get-tire-temperature-guide",
  description:
    "Fetch this game's optimal tire temperature windows per compound (min/max °C) " +
    "for the channel the game measures (carcass, or tread surface when the game " +
    "publishes no carcass channel). Use when discussing tire temperatures, warm-up, cold " +
    "tires, overheating, or compound choice. Pass the current game id; omitting it uses " +
    "the turn's game context.",
  inputSchema: z.object({
    gameId: z.string().optional().describe("Game id, e.g. 'acc', 'ac-evo', 'f1-2025', 'lmu', 'fm-2023'"),
  }),
  outputSchema: z.object({
    guide: z.string().describe("Formatted per-compound guide, or empty when the game has no core-temperature metadata"),
    available: z.boolean(),
  }),
  execute: async (inputData, execCtx) => {
    const context = execCtx?.requestContext as RequestContextLike;
    const gameId = (inputData.gameId ?? context?.get?.("gameId")) as GameId | undefined;
    const guide = gameId ? formatTireTempGuide(gameId) : "";
    return { guide, available: guide.length > 0 };
  },
});
