import { createScorer } from "@mastra/core/evals";
import { parseAnalystOutput } from "../../../server/ai/schemas";

/**
 * Fraction of the fixture's expected slowest corners that the analyst
 * surfaces in its `corners[]`, `technique[]`, or `verdict` output.
 *
 * Ground truth comes from the fixture (`groundTruth.slowestCorners`),
 * which pins the top-N corners flagged by precomputed insights so the
 * scorer reflects what the model actually saw.
 */
export const cornerCoverageScorer = createScorer({
  id: "corner-coverage",
  description: "Fraction of expected slowest corners mentioned in the output",
})
  .generateScore(({ run }) => {
    const expected: string[] = run.groundTruth?.slowestCorners ?? [];
    if (expected.length === 0) return 1;

    const haystack = extractHaystack(run.output).toLowerCase();
    const hits = expected.filter((c) => haystack.includes(c.toLowerCase())).length;
    return hits / expected.length;
  })
  .generateReason(({ run, score }) => {
    const expected: string[] = run.groundTruth?.slowestCorners ?? [];
    const haystack = extractHaystack(run.output).toLowerCase();
    const missed = expected.filter((c) => !haystack.includes(c.toLowerCase()));
    return missed.length === 0
      ? `all ${expected.length} expected corners mentioned`
      : `missed: ${missed.join(", ")} (score ${score.toFixed(2)})`;
  });

function extractHaystack(output: unknown): string {
  if (typeof output === "string") {
    const parsed = parseAnalystOutput(output);
    if (parsed.success) return stringifyAnalyst(parsed.data);
    return output;
  }
  return JSON.stringify(output ?? "");
}

function stringifyAnalyst(a: ReturnType<typeof parseAnalystOutput> extends { success: true; data: infer D } ? D : never): string {
  const parts: string[] = [a.verdict];
  for (const c of a.corners) parts.push(c.name, c.issue, c.fix);
  for (const t of a.technique) parts.push(t.tip, t.detail);
  return parts.join(" \n ");
}
