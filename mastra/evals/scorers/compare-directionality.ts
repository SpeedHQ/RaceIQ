import { createScorer } from "@mastra/core/evals";

/**
 * Binary scorer for Compare Engineer output. Does the analysis correctly
 * identify which of the two laps is faster?
 *
 * Compare output is free-form prose, so we scan for "Lap A is faster" /
 * "Lap B is faster" / equivalent phrasing and check against the fixture's
 * `groundTruth.fasterLap`.
 */
export const compareDirectionalityScorer = createScorer({
  id: "compare-directionality",
  description: "Compare Engineer correctly identifies the faster lap",
})
  .generateScore(({ run }) => {
    const expected = run.groundTruth?.fasterLap as "A" | "B" | undefined;
    if (!expected) return 1;

    const claimed = claimedFasterLap(String(run.output ?? ""));
    if (!claimed) return 0;
    return claimed === expected ? 1 : 0;
  })
  .generateReason(({ run }) => {
    const expected = run.groundTruth?.fasterLap as "A" | "B" | undefined;
    const claimed = claimedFasterLap(String(run.output ?? ""));
    if (!expected) return "no ground truth set";
    if (!claimed) return "model did not clearly identify a faster lap";
    return claimed === expected
      ? `correct: faster = Lap ${expected}`
      : `wrong: model said Lap ${claimed}, fixture says Lap ${expected}`;
  });

/**
 * Heuristic: find the first strong claim like "Lap A is faster",
 * "Lap B was quicker", "Lap A gains time", etc. Returns whichever lap
 * is attributed as faster, or null if none found.
 */
function claimedFasterLap(text: string): "A" | "B" | null {
  const pattern = /Lap\s+([AB])\s+(?:is|was|stays|runs|proves|ends up|finishes)\s+(?:\w+\s+){0,3}?(faster|quicker|ahead|the quicker|the faster)/i;
  const match = text.match(pattern);
  if (match) return match[1].toUpperCase() as "A" | "B";

  const gainPattern = /Lap\s+([AB])\s+gains?\s+time/i;
  const gainMatch = text.match(gainPattern);
  if (gainMatch) return gainMatch[1].toUpperCase() as "A" | "B";

  return null;
}
