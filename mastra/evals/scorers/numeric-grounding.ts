import { createScorer } from "@mastra/core/evals";
import { parseAnalystOutput } from "../../../server/ai/schemas";

const NUMERIC_UNIT_RE =
	/\d+(\.\d+)?\s*(lb\/in|N\/mm|psi|bar|in\b|cm\b|mm|m\b|km\/h|mph|rpm|%|°|degrees?|g\b)/i;
const DELTA_RE = /-?\d+(\.\d+)?\s*(→|->|to)\s*-?\d+(\.\d+)?/;

/**
 * Fraction of `setup[]` entries whose `current` or `target` cites a concrete
 * number-with-unit (e.g. "22.5 psi", "680 lb/in", "27"). Keeps the model
 * from shipping vague advice like "stiffen the front" with no target.
 */
export const numericGroundingScorer = createScorer({
	id: "numeric-grounding",
	description:
		"Fraction of setup entries that cite concrete numeric current/target values",
})
	.generateScore(({ run }) => {
		const parsed = parseAnalystOutput(run.output);
		if (!parsed.success || parsed.data.setup.length === 0) return 0;

		const grounded = parsed.data.setup.filter((t) => {
			const blob = `${t.current} ${t.target}`;
			return (
				NUMERIC_UNIT_RE.test(blob) ||
				DELTA_RE.test(blob) ||
				/^-?\d+(\.\d+)?$/.test(t.target.trim())
			);
		}).length;

		return grounded / parsed.data.setup.length;
	})
	.generateReason(({ run, score }) => {
		const parsed = parseAnalystOutput(run.output);
		if (!parsed.success)
			return "output failed to parse — cannot score grounding";
		const total = parsed.data.setup.length;
		return `${Math.round(score * total)} / ${total} setup entries grounded (score ${score.toFixed(2)})`;
	});
