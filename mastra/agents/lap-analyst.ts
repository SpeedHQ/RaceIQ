/**
 * Lap Analyst — single-lap structured analysis persona.
 *
 * Used by the per-lap analyse flow (POST /api/laps/:id/analyse). Issues a
 * structured verdict on one lap (pace, handling, problem corners, braking,
 * throttle, coaching, setup). Distinct from compare-engineer, which thinks
 * across two laps.
 */
import { Agent } from "@mastra/core/agent";
import { getMastraModelId } from "../model";
import { loadSettings } from "../../server/runtime/config/settings";
import { compareF1SetupToCatalogTool } from "../tools/f1-setup-compare";
import { getCornerMetricsTool } from "../tools/corner-metrics";
import { getTrackGuideTool, listTrackGuidesTool } from "../tools/track-guide";
import { liveAnalystScorers } from "../evals";
import { TRACK_GUIDE_PROMPT } from "../../shared/ai/prompt-snippets";
const LAP_ANALYST_INSTRUCTIONS = `You are a senior race engineer reviewing a single driver's lap from telemetry data. Your job is to issue a structured verdict on the lap covering pace, handling, problem corners, braking, throttle application, coaching, and setup recommendations.

Be specific and concrete. Cite numbers where helpful. Refer to the driver as "you". Use the units provided in the prompt.

DISCIPLINE (applies to every game):
- Corner names in \`corners[]\`, \`technique[]\`, or any other field MUST come from the "Valid Corner Labels" list in the prompt context. If the prompt instead says "No named corner data is available", use "T1", "T2", … (sequential numbering). Never invent corner names like "Bit-Kurve" or "Parabolica-3" that aren't in the provided list.
- If current car setup is not included in the prompt and setup context is needed to explain handling, call \`compareF1SetupToCatalogTool\`; use returned setup only as analysis context and do not output setup recommendations.
`;
export const lapAnalystAgent = new Agent({
  id: "lap-analyst",
  name: "Lap Analyst",
  instructions: LAP_ANALYST_INSTRUCTIONS,
  model: ({ requestContext }) => getModel("analysis", requestContext),
  // Optional setup lookup: use when the prompt does not already include car setup.
  tools: {
    compareF1SetupToCatalogTool,
    getCornerMetricsTool,
    getTrackGuideTool,
    listTrackGuidesTool,
  },
  // Tool stays registered for models that can tool-call reliably. On local
  // models (Gemma 4) that loop the tool, the analyse route inlines the
  // same data into the prompt — model can ignore the tool and still get
  // the context. See server/routes/laps/chat-routes.ts.
  tools: { compareF1SetupToCatalogTool, getCornerMetricsTool, getTrackGuideTool, listTrackGuidesTool },
  // Live scoring in Studio: deterministic suite always, LLM-judge when
  // EVAL_LOCAL_JUDGE=1 (LM Studio running). See mastra/evals/index.ts.
  scorers: liveAnalystScorers,
});
