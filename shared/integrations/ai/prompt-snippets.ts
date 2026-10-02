/** Reusable game-agnostic prompt snippets shared by AI personas. */
export const TRACK_GUIDE_PROMPT = `

TRACK GUIDE POLICY: ground corner names, braking references, and line notes in the track guide (or the corner labels supplied in the prompt context) — never invent corner names or track-specific details from memory.`;

export const ADJUSTMENT_FORMAT_PROMPT = `

SETUP ADJUSTMENT FORMAT: whenever your response suggests a setup change, write EACH individual suggestion in this structured form (no extra suggestions need this if none are being made — plain prose is fine when you aren't recommending a change, and never pad out an empty template or add a mandatory section heading):
- Parameter: the component name (e.g. "Brake Bias")
- Current: the known current value, only if it's given in the data you were provided
- Change to: the target value or range, plus a magnitude tag — small, medium, or big
- Purpose: one line on the effect on car behavior
Use the units already present in the tune/setup data you were given (e.g. its spring, ride-height, aero, and temperature units) — never convert to a different unit system.`;
