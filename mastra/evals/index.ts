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
import { drillQualityScorer } from "./scorers/drill-quality";
import { llmFaithfulnessScorer } from "./scorers/llm-faithfulness";

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

/**
 * Driver Coach. `drill-quality` is the coach's counterpart to the analyst's
 * `numeric-grounding`: coaching output has no deterministic rules engine behind
 * it, so nothing but this stops "be smoother" from being recorded as a drill.
 * Freeform shape still applies — a coach must cite real corners too.
 */
export const coachScorers = [
  drillQualityScorer,
  chatFreeformShapeScorer,
  unitConsistencyScorer,
] as const satisfies ReadonlyArray<MastraScorer>;

export const chatScorers = [
  chatFreeformShapeScorer,
  unitConsistencyScorer,
] as const satisfies ReadonlyArray<MastraScorer>;

/**
 * Model-graded (LLM-as-judge) scorers. Kept in their own array because they
 * are slow and require a local LM Studio judge to be running — the fast
 * deterministic suites above must stay runnable without it. Applies to any
 * agent that produces grounded text: `lap-analyst` and `setup-engineer`.
 */
export const judgeScorers = [
  llmFaithfulnessScorer,
] as const satisfies ReadonlyArray<MastraScorer>;

/**
 * Instance-level registry: makes every scorer listable/selectable in Mastra
 * Studio's Scorers tab. Keyed by scorer id. Studio only surfaces scorers it
 * finds here (or attached to an agent) — objects that merely exist in eval
 * files are invisible to it.
 */
export const scorerRegistry = {
  "output-shape": outputShapeScorer,
  "corner-coverage": cornerCoverageScorer,
  "numeric-grounding": numericGroundingScorer,
  "unit-consistency": unitConsistencyScorer,
  "compare-directionality": compareDirectionalityScorer,
  "chat-freeform-shape": chatFreeformShapeScorer,
  "drill-quality": drillQualityScorer,
  "llm-faithfulness": llmFaithfulnessScorer,
} satisfies Record<string, MastraScorer>;

/**
 * Agent-attach helper: wraps scorers as `{ key: { scorer } }` so Studio runs
 * them live on that agent's traces. `HAS_LOCAL_JUDGE` gates the slow
 * model-graded judge so agents stay scorable without LM Studio running.
 */
const HAS_LOCAL_JUDGE = process.env.EVAL_LOCAL_JUDGE === "1";

export function attachScorers(scorers: ReadonlyArray<MastraScorer>) {
  return Object.fromEntries(
    scorers.map((s) => [s.id, { scorer: s }]),
  );
}

/** Live scorers for the grounded-text agents: deterministic + optional judge. */
export const liveAnalystScorers = attachScorers([
  ...analystScorers,
  ...(HAS_LOCAL_JUDGE ? judgeScorers : []),
]);

/** Live scorers for the Driver Coach — deterministic only, so Studio scores
 *  its traces without LM Studio running. */
export const liveCoachScorers = attachScorers(coachScorers);

/** Default pass thresholds per scorer id. Tests read these directly. */
export const SCORER_THRESHOLDS: Record<string, number> = {
  "output-shape": 1.0,
  "corner-coverage": 0.7,
  "numeric-grounding": 0.8,
  "unit-consistency": 1.0,
  "compare-directionality": 0.9,
  "chat-freeform-shape": 0.8,
  // 0.75 = three of four signals. Deliberately not 1.0: a legitimately
  // lap-wide drill ("keep your eyes up through every corner") can miss the
  // measurable-reference signal and still be a real, repeatable instruction.
  "drill-quality": 0.75,
  "llm-faithfulness": 1.0,
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
