import { createScorer } from "@mastra/core/evals";
import { parseAnalystOutput } from "../../../server/ai/schemas";

const NUMERIC_UNIT_RE = /\d+(\.\d+)?\s*(lb\/in|N\/mm|psi|bar|mm|m\b|km\/h|mph|rpm|%|°|degrees?|g\b)/i;
const DELTA_RE = /-?\d+(\.\d+)?\s*(→|->|to)\s*-?\d+(\.\d+)?/;

/**
 * Fraction of `tuning[]` entries whose `target` or `reason` cites a concrete
 * number-with-unit or a delta (e.g. "3 → 5", "22.5 psi"). Keeps the model
 * from shipping vague advice like "stiffen the front" with no target.
 */
export const numericGroundingScorer = createScorer({
  id: "numeric-grounding",
  description: "Fraction of tuning entries that cite concrete numeric targets",
})
  .generateScore(({ run }) => {
    const parsed = parseAnalystOutput(run.output);
    if (!parsed.success || parsed.data.tuning.length === 0) return 0;

    const grounded = parsed.data.tuning.filter((t) => {
      const blob = `${t.current} ${t.target} ${t.reason}`;
      return NUMERIC_UNIT_RE.test(blob) || DELTA_RE.test(blob);
    }).length;

    return grounded / parsed.data.tuning.length;
  })
  .generateReason(({ run, score }) => {
    const parsed = parseAnalystOutput(run.output);
    if (!parsed.success) return "output failed to parse — cannot score grounding";
    const total = parsed.data.tuning.length;
    return `${Math.round(score * total)} / ${total} tuning entries grounded (score ${score.toFixed(2)})`;
  });
