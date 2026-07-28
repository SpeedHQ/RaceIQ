/**
 * Reusable prompt snippets shared by every engineer/analyst agent persona.
 *
 * Keep these game-agnostic and tool-id-accurate: the ids referenced here must
 * match the Mastra tool ids in `mastra/tools/track-guide.ts`.
 */

/**
 * Track-guide usage snippet — appended to the instructions of every agent
 * that registers `getTrackGuideTool` / `listTrackGuidesTool`.
 *
 * Policy only — "when to call" guidance lives in the tool descriptions in
 * `mastra/tools/track-guide.ts`; do not duplicate it here.
 */
export const TRACK_GUIDE_PROMPT = `

TRACK GUIDE POLICY: ground corner names, braking references, and line notes in the track guide (or the corner labels supplied in the prompt context) — never invent corner names or track-specific details from memory.`;

/**
 * Structured format every setup/tune suggestion must follow, appended to the
 * system prompt of every surface that can produce setup advice (single-lap
 * Analyst, lap-analysis chat, experiment setup chat, compare persona,
 * Setup Engineer agent).
 *
 * Conditional by design: it only fires when a response actually contains a
 * setup suggestion. A response with no adjustments must stay plain prose —
 * never emit an empty template, and never wrap it in a mandatory heading
 * (e.g. "Manual Adjustments"); the per-suggestion structure is enough on its
 * own.
 */
export const ADJUSTMENT_FORMAT_PROMPT = `

SETUP ADJUSTMENT FORMAT: whenever your response suggests a setup change, write EACH individual suggestion in this structured form (no extra suggestions need this if none are being made — plain prose is fine when you aren't recommending a change, and never pad out an empty template or add a mandatory section heading):
- Parameter: the component name (e.g. "Brake Bias")
- Current: the known current value, only if it's given in the data you were provided
- Change to: the target value or range, plus a magnitude tag — small, medium, or big
- Purpose: one line on the effect on car behavior
Use the units already present in the tune/setup data you were given (e.g. its spring, ride-height, aero, and temperature units) — never convert to a different unit system.`;
