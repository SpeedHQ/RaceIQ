import { createScorer } from "@mastra/core/evals";

/**
 * Drill quality — the Driver Coach's counterpart to `numeric-grounding`.
 *
 * Coaching output is MORE prone to vibes than setup output. A setup
 * recommendation is anchored by the deterministic rules engine (the model picks
 * a direction, code computes the number), but nothing structurally stops a
 * coach from producing "be smoother through the middle sector" — which reads
 * like coaching, cannot be repeated identically, and therefore cannot be
 * measured by the very consistency metric a drill arm is judged on.
 *
 * So this scores exactly what the coach's own prompt demands of a drill: ONE
 * concrete, repeatable change, aimed at a named place, that a driver can hold
 * in their head for one lap.
 *
 * Four signals, NOT equally weighted:
 *   LOCATED    0.3  — names a corner from the track's list, or is explicitly lap-wide
 *   ACTIONABLE 0.3  — contains an imperative the driver physically performs
 *   SINGULAR   0.3  — one change, not several stapled together
 *   CONCRETE   0.1  — carries a measurable reference (a distance, a board, a gear)
 *
 * The weighting is load-bearing, not cosmetic. Under equal weights a drill that
 * bundled two changes, or named nowhere to run it, scored exactly 0.75 — the
 * pass mark — so the two failures that most destroy measurability slipped
 * through. Any one of LOCATED / ACTIONABLE / SINGULAR missing now lands at 0.7
 * and fails. CONCRETE is the deliberate exception: a real lap-wide drill
 * ("look to the apex before turn-in on every corner") carries no number and is
 * still repeatable, so it may miss that signal and still pass at 0.9.
 *
 * Deterministic on purpose: no LLM judge, so it runs in the fast suite.
 *
 * Accepts either the `DrillChange` object `record_drill` writes (preferred —
 * it is exactly what lands in the DB) or raw text, so the same scorer works on
 * a proposal in chat and on a recorded arm.
 */
export const drillQualityScorer = createScorer({
  id: "drill-quality",
  description: "A drill is located, actionable, concrete and singular — repeatable enough to measure",
})
  .generateScore(({ run }) => {
    const { title, instruction, corners } = normalizeDrill(run.output);
    const text = `${title} ${instruction}`.trim();
    if (text.length === 0) return 0;

    const trackCorners: string[] = run.groundTruth?.trackCorners ?? [];
    let score = 0;
    if (isLocated(text, corners, trackCorners)) score += 0.3;
    if (hasImperative(text)) score += 0.3;
    if (isSingular(text)) score += 0.3;
    if (isConcrete(text)) score += 0.1;
    // Float addition: 0.3+0.3+0.3+0.1 must read as exactly 1.
    return Math.round(score * 100) / 100;
  })
  .generateReason(({ run, score }) => {
    const { title, instruction, corners } = normalizeDrill(run.output);
    const text = `${title} ${instruction}`.trim();
    if (score === 1) return "located, actionable, concrete, one change";

    const trackCorners: string[] = run.groundTruth?.trackCorners ?? [];
    const missing: string[] = [];
    if (!isLocated(text, corners, trackCorners)) missing.push("no corner named (and not stated lap-wide)");
    if (!hasImperative(text)) missing.push("no action the driver performs");
    if (!isConcrete(text)) missing.push("nothing measurable — reads as a feeling");
    if (!isSingular(text)) missing.push("more than one change in a single drill");
    return missing.join("; ") || `partial (${score.toFixed(2)})`;
  });

interface NormalizedDrill {
  title: string;
  instruction: string;
  corners: string[];
}

function normalizeDrill(output: unknown): NormalizedDrill {
  if (typeof output === "string") return { title: "", instruction: output, corners: [] };
  const o = (output ?? {}) as Record<string, unknown>;
  return {
    title: typeof o.title === "string" ? o.title : "",
    instruction: typeof o.instruction === "string" ? o.instruction : "",
    corners: Array.isArray(o.corners) ? o.corners.filter((c): c is string => typeof c === "string") : [],
  };
}

/** A drill must say WHERE. An explicit lap-wide drill counts — "every corner"
 *  is a location, "somewhere in sector 2" is not. */
function isLocated(text: string, corners: string[], trackCorners: string[]): boolean {
  if (corners.length > 0) return true;
  const lower = text.toLowerCase();
  if (trackCorners.some((c) => lower.includes(c.toLowerCase()))) return true;
  // Turn numbers are how half the paddock names corners.
  if (/\b(t\d{1,2}|turn \d{1,2})\b/i.test(text)) return true;
  return /\b(every corner|all corners|whole lap|lap-wide|each lap|every lap)\b/i.test(text);
}

/** Something the driver physically does, not something they should "feel". */
const IMPERATIVES = [
  "brake", "braking", "lift", "release", "carry", "hold", "turn", "apply", "squeeze",
  "roll", "trail", "aim", "look", "shift", "downshift", "upshift", "coast", "wait",
  "delay", "unwind", "feed", "position", "clip", "hit", "keep",
];

function hasImperative(text: string): boolean {
  const lower = text.toLowerCase();
  return IMPERATIVES.some((verb) => new RegExp(`\\b${verb}\\b`).test(lower));
}

/**
 * Measurable reference: a distance, a board, a gear, a pressure, a percentage,
 * a speed — anything that makes "did I do it?" answerable on the next lap.
 */
function isConcrete(text: string): boolean {
  if (/\b\d+(\.\d+)?\s?(m|metres|meters|km\/h|mph|bar|%|percent|deg|degrees)\b/i.test(text)) return true;
  if (/\b\d+\s?(m|metre|meter)?\s?board\b/i.test(text)) return true;
  if (/\bgear\s?\d\b|\b\d(st|nd|rd|th)\s+gear\b/i.test(text)) return true;
  // A named reference point on track is concrete even without a number.
  return /\b(apex|turn-in|braking point|track limits?|kerb|curb|white line|exit kerb)\b/i.test(text);
}

/**
 * One change at a time. Two simultaneous changes make the result unreadable —
 * you cannot tell which one moved the spread.
 *
 * Three ways a drill bundles, in rising order of how easy they are to miss:
 *
 *  1. An explicit second instruction — "and also brake later", "additionally".
 *  2. Two numbered or bulleted steps: two drills wearing one coat.
 *  3. ⚠️ Two actions aimed at two DIFFERENT PLACES — "brake 10m later at T4 and
 *     get on the throttle earlier at T7". This is the form a model actually
 *     produces, it reads as one fluent sentence, and an earlier cut of this
 *     scorer passed it at 1.0. It is the whole reason SINGULAR is weighted
 *     load-bearing, so it must be the case that is caught.
 *
 * Still conservative about plain "and": two verbs at ONE location describe a
 * single action ("brake later and release progressively into T4" is one drill),
 * so the flag is two distinct *corner references*, not two verbs. A lap-wide
 * drill names no corner and therefore cannot trip (3).
 */
function isSingular(text: string): boolean {
  if (/\b(and also|also,|plus also|as well as also)\b/i.test(text)) return false;
  if (/\b(and then also|and additionally|additionally,)\b/i.test(text)) return false;
  // Two numbered/bulleted steps is two drills wearing one coat.
  if (/(^|\n)\s*(2[.)]|second(ly)?[,:])/im.test(text)) return false;
  return !targetsTwoPlaces(text);
}

/**
 * True when the text names two or more distinct corners AND carries a
 * conjunction joining them — i.e. two separate places to do something.
 *
 * Requiring the conjunction keeps a legitimate single drill that merely
 * *mentions* a second corner as context ("brake earlier at T4; you are losing
 * the exit onto the T5 straight") from being scored as two drills.
 */
function targetsTwoPlaces(text: string): boolean {
  const refs = new Set((text.match(/\b(?:t\s?\d{1,2}|turn \d{1,2})\b/gi) ?? []).map((r) => r.replace(/\s|turn/gi, "").toLowerCase()));
  if (refs.size < 2) return false;
  return /\b(and|then|,)\s/i.test(text);
}
