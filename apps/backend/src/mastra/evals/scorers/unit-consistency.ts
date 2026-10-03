import { createScorer } from "@mastra/core/evals";

const IMPERIAL_MARKERS = /\b(mph|psi|lb\/in|lb\b|inches?|°\s*F|ft\b|feet)\b/i;
const METRIC_MARKERS = /\b(km\/h|kph|bar\b|N\/mm|cm\b|°\s*C|\bmeters?\b)\b/i;

/**
 * Binary scorer: does the output respect the fixture's unit preference?
 *
 * A metric fixture must not mention imperial units and vice versa. Catches
 * the common failure where the model leaks "psi" into a km/h lap because
 * the training data skews imperial.
 */
export const unitConsistencyScorer = createScorer({
	id: "unit-consistency",
	description:
		"Output respects fixture unit system (no metric/imperial bleed-through)",
})
	.generateScore(({ run }) => {
		const units = run.groundTruth?.units as "metric" | "imperial" | undefined;
		if (!units) return 1;

		const text =
			typeof run.output === "string" ? run.output : JSON.stringify(run.output);
		if (units === "metric" && IMPERIAL_MARKERS.test(text)) return 0;
		if (units === "imperial" && METRIC_MARKERS.test(text)) return 0;
		return 1;
	})
	.generateReason(({ run }) => {
		const units = run.groundTruth?.units as "metric" | "imperial" | undefined;
		if (!units) return "no unit preference in fixture — skipped";
		const text =
			typeof run.output === "string" ? run.output : JSON.stringify(run.output);
		const wrong =
			units === "metric"
				? text.match(IMPERIAL_MARKERS)?.[0]
				: text.match(METRIC_MARKERS)?.[0];
		return wrong
			? `leaked ${units === "metric" ? "imperial" : "metric"} unit: "${wrong}"`
			: "clean";
	});
