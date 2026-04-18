import { createScorer } from "@mastra/core/evals";
import { parseAnalystOutput } from "../../../server/ai/schemas";

/**
 * Binary scorer: does the analyst output parse into AnalystOutputSchema?
 *
 * This is the floor — below 1.0 means the model failed the most basic
 * contract (valid JSON, correct shape). Every prompt/model change must
 * clear this.
 */
export const outputShapeScorer = createScorer({
  id: "output-shape",
  description: "Lap Analyst output parses against the shared analyst schema",
})
  .generateScore(({ run }) => {
    const parsed = parseAnalystOutput(run.output);
    return parsed.success ? 1 : 0;
  })
  .generateReason(({ run }) => {
    const parsed = parseAnalystOutput(run.output);
    if (parsed.success) return "valid";
    return parsed.error.issues
      .slice(0, 6)
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
  });
