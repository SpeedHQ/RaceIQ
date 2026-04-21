/**
 * Scorer registry + test helper.
 *
 * Exports the deterministic scorers as a flat array so the regression test
 * (`test/ai-quality.test.ts`) can iterate them, and a `scoreOutput` helper
 * that runs one scorer against a raw model output with a ground-truth
 * bundle.
 */
import type { MastraScorer } from "@mastra/core/evals";
import { outputShapeScorer } from "./scorers/output-shape";
import { cornerCoverageScorer } from "./scorers/corner-coverage";
import { numericGroundingScorer } from "./scorers/numeric-grounding";
import { unitConsistencyScorer } from "./scorers/unit-consistency";
import { compareDirectionalityScorer } from "./scorers/compare-directionality";
import { chatFreeformShapeScorer } from "./scorers/chat-freeform-shape";

export const analystScorers = [
  outputShapeScorer,
  cornerCoverageScorer,
  numericGroundingScorer,
  unitConsistencyScorer,
] as const satisfies ReadonlyArray<MastraScorer>;

export const compareScorers = [
  compareDirectionalityScorer,
  unitConsistencyScorer,
] as const satisfies ReadonlyArray<MastraScorer>;

export const chatScorers = [
  chatFreeformShapeScorer,
  unitConsistencyScorer,
] as const satisfies ReadonlyArray<MastraScorer>;

/** Default pass thresholds per scorer id. Tests read these directly. */
export const SCORER_THRESHOLDS: Record<string, number> = {
  "output-shape": 1.0,
  "corner-coverage": 0.7,
  "numeric-grounding": 0.8,
  "unit-consistency": 1.0,
  "compare-directionality": 0.9,
  "chat-freeform-shape": 0.8,
};

export interface ScoreResult {
  id: string;
  score: number;
  reason: string;
}

/**
 * Run one scorer against a raw model output and ground truth. Returns
 * a flat `{id, score, reason}` row — no accumulated steps.
 */
export async function scoreOutput(
  scorer: MastraScorer,
  output: unknown,
  groundTruth: unknown,
): Promise<ScoreResult> {
  const result = await scorer.run({ output, groundTruth });
  return {
    id: scorer.id,
    score: typeof result.score === "number" ? result.score : 0,
    reason: typeof result.reason === "string" ? result.reason : "",
  };
}
