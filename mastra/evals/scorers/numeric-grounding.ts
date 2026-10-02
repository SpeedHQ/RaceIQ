import { createScorer } from "@mastra/core/evals";
import { parseAnalystOutput } from "../../../server/ai/schemas";

const NUMERIC_UNIT_RE =
	/\d+(\.\d+)?\s*(lb\/in|N\/mm|psi|bar|in\b|cm\b|mm|m\b|km\/h|mph|rpm|%|°|degrees?|g\b)/i;
const DELTA_RE = /-?\d+(\.\d+)?\s*(→|->|to)\s*-?\d+(\.\d+)?/;

/**
 * Fraction of structured analysis entries that cite concrete numeric values.
 */
export const numericGroundingScorer = createScorer({
	id: "numeric-grounding",
	description:
		"Fraction of analysis entries that cite concrete numeric values",
})
	.generateScore(({ run }) => {
		const parsed = parseAnalystOutput(run.output);
		if (!parsed.success) return 0;
		const entries = [
			...parsed.data.pace,
			...parsed.data.handling,
			...parsed.data.corners,
			...parsed.data.technique,
		];
		const grounded = entries.filter((entry) => {
			const blob = JSON.stringify(entry);
			return NUMERIC_UNIT_RE.test(blob) || DELTA_RE.test(blob);
		}).length;
		return grounded / entries.length;
	})
	.generateReason(({ run, score }) => {
		const parsed = parseAnalystOutput(run.output);
		if (!parsed.success) return "output failed to parse — cannot score grounding";
		const entries = [
			...parsed.data.pace,
			...parsed.data.handling,
			...parsed.data.technique,
		];
		return `${entries.length} analysis entries checked (score ${score.toFixed(2)})`;
	});
