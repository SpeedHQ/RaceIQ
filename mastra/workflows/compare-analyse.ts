/**
 * Compare-Analyse Workflow
 *
 * Two-step Mastra workflow for the inputs-comparison flow:
 *   1. fetchTrackGuide — look up expert corner-by-corner knowledge
 *   2. analyseInputs   — call the compare engineer agent with the enriched prompt
 *
 * Each step is independently observable in Mastra Studio traces.
 * The route can call this workflow instead of directly invoking the agent.
 */
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { buildTrackGuideContext } from "../../server/ai/track-guides";

// ─── Step 1: Fetch Track Guide ────────────────────────────────

const fetchTrackGuideStep = createStep({
  id: "fetch-track-guide",
  description: "Look up expert track knowledge for the circuit being analysed",
  inputSchema: z.object({
    trackName: z.string().describe("Display name or ID of the track"),
  }),
  outputSchema: z.object({
    trackName: z.string(),
    trackGuide: z.string().describe("Formatted guide text, empty if unavailable"),
    hasGuide: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    const guide = buildTrackGuideContext(inputData.trackName);
    return {
      trackName: inputData.trackName,
      trackGuide: guide,
      hasGuide: guide.length > 0,
    };
  },
});

// ─── Step 2: Run Compare Analysis ─────────────────────────────

const analyseInputsStep = createStep({
  id: "analyse-inputs",
  description: "Call the compare engineer agent with track guide + comparison data",
  inputSchema: z.object({
    trackName: z.string(),
    trackGuide: z.string(),
    hasGuide: z.boolean(),
  }),
  outputSchema: z.object({
    analysis: z.string().describe("Structured JSON analysis from the compare engineer"),
    hasGuide: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    // The agent call happens in the route (it needs the full prompt + structured output).
    // This step signals to the route that the guide is ready and passes it through.
    // In a full workflow-driven architecture, the agent call would live here:
    //
    //   const agent = mastra?.getAgent("compare-engineer");
    //   const result = await agent?.generate(prompt, { structuredOutput: ... });
    //
    // For now, this step validates the guide was fetched and makes the pipeline
    // observable in Mastra Studio.
    return {
      analysis: `[guide-ready] trackGuide=${inputData.hasGuide ? "available" : "none"} for ${inputData.trackName}`,
      hasGuide: inputData.hasGuide,
    };
  },
});

// ─── Workflow Definition ──────────────────────────────────────

export const compareAnalyseWorkflow = createWorkflow({
  id: "compare-analyse",
  inputSchema: z.object({
    trackName: z.string().describe("Track display name or identifier"),
  }),
  outputSchema: z.object({
    analysis: z.string(),
    hasGuide: z.boolean(),
  }),
})
  .then(fetchTrackGuideStep)
  .then(analyseInputsStep);

compareAnalyseWorkflow.commit();
