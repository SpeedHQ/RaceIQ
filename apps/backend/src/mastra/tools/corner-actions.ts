import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { MAX_CORNER_ACTIONS, CornerActionSchema, parseCornerActions } from "@raceiq/shared/integrations/ai/corner-action";

const CornerActionsInput = z.object({
  actions: z
    .array(z.unknown())
    .max(MAX_CORNER_ACTIONS)
    .describe("Validated inline corner references; invalid entries are dropped."),
});

const CornerActionsOutput = z.object({
  actions: z.array(CornerActionSchema).max(MAX_CORNER_ACTIONS),
});

/**
 * Chat answers stay plain prose. This tool is the structured side-channel that
 * carries the runtime-validated action spans for the text just written.
 */
export const cornerActionsTool = createTool({
  id: "corner_actions",
  description:
    "Attach clickable corner references to the answer you just wrote. Call exactly once, after the answer text, " +
    "when the answer names one or more corners. Each action span is a 0-based character range in that answer text. " +
    "Do not repeat the actions in prose and do not mention this tool.",
  inputSchema: CornerActionsInput,
  outputSchema: CornerActionsOutput,
  execute: async ({ actions }) => ({ actions: parseCornerActions(actions) }),
});
