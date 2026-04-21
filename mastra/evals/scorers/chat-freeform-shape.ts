import { createScorer } from "@mastra/core/evals";

/**
 * Lightweight health check for chat agents (`lap-chat`, `compare-chat`).
 * Chat output is free-form, so we can't schema-check it. Instead we score
 * three cheap signals:
 *   1. non-empty, >= 30 chars
 *   2. cites at least one corner name from the fixture's corner list
 *   3. does not hallucinate a corner name that isn't in the track's list
 *
 * Each signal worth 1/3. A perfect chat response scores 1.0.
 */
export const chatFreeformShapeScorer = createScorer({
  id: "chat-freeform-shape",
  description: "Chat output is grounded: non-empty, cites real corners, no hallucinated corners",
})
  .generateScore(({ run }) => {
    const text = String(run.output ?? "").trim();
    const trackCorners: string[] = run.groundTruth?.trackCorners ?? [];
    if (trackCorners.length === 0) return text.length >= 30 ? 1 : 0;

    let score = 0;
    if (text.length >= 30) score += 1 / 3;

    const lower = text.toLowerCase();
    const trackLower = trackCorners.map((c) => c.toLowerCase());
    const cited = trackLower.filter((c) => lower.includes(c));
    if (cited.length > 0) score += 1 / 3;

    const hallucinated = detectHallucinatedCorners(text, trackCorners);
    if (hallucinated.length === 0) score += 1 / 3;

    return score;
  })
  .generateReason(({ run, score }) => {
    const trackCorners: string[] = run.groundTruth?.trackCorners ?? [];
    const text = String(run.output ?? "");
    const hallucinated = detectHallucinatedCorners(text, trackCorners);
    if (score === 1) return "non-empty, cites real corners, no hallucinations";
    const notes: string[] = [];
    if (text.trim().length < 30) notes.push("too short");
    if (hallucinated.length > 0) notes.push(`hallucinated corners: ${hallucinated.slice(0, 3).join(", ")}`);
    return notes.join("; ") || `partial (${score.toFixed(2)})`;
  });

/**
 * Very cautious: only flag capitalized phrases that look like corner names
 * (e.g. "Stowe", "Les Combes") but aren't in the known track list. Common
 * English words and racing terms are filtered out to avoid false positives.
 */
function detectHallucinatedCorners(text: string, trackCorners: string[]): string[] {
  const known = new Set(trackCorners.map((c) => c.toLowerCase()));
  const candidates = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g) ?? [];
  const ALLOWLIST = new Set([
    "Lap", "Laps", "Turn", "Turns", "Corner", "Corners", "Sector", "Sectors",
    "Front", "Rear", "Left", "Right", "Apex", "Exit", "Entry", "Mid",
    "DRS", "ERS", "GT3", "GT4", "You", "The", "Your",
  ]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    const trimmed = raw.trim();
    if (ALLOWLIST.has(trimmed)) continue;
    if (seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    if (!known.has(trimmed.toLowerCase())) out.push(trimmed);
  }
  return out;
}
