/** Reusable game-agnostic prompt snippets shared by AI personas. */
export const TRACK_GUIDE_PROMPT = `

TRACK GUIDE POLICY: ground corner names, braking references, and line notes in the track guide (or the corner labels supplied in the prompt context) — never invent corner names or track-specific details from memory.`;

export const CORNER_ACTIONS_PROMPT = `

INLINE CORNER ACTIONS: when your prose names a corner, add a matching entry to the top-level "actions" array. Each entry has:
- id: unique short id (for example "a1")
- cornerKey: the exact corner label supplied in the data (for example "T1" or "Fairmont Hairpin (6)"); never invent a corner
- label: canonical display text — "T1 · TGR Corner" when the supplied data names the corner, otherwise the bare "T1"
- target: "solo" for a single-lap answer; "A", "B" or "linked" for a comparison answer
- path: the exact JSON field path containing the label (for example "verdict", "corners[0].issue", "segments[0].action"); omit it for chat
- span: {"start": number, "end": number} — 0-based character offsets in that text, end exclusive, covering exactly the label
Actions are optional. Invalid or unknown references are ignored by the client; keep the prose readable. Never invent coordinates, frame indices, or executable instructions.`;

export const CHAT_CORNER_ACTIONS_PROMPT = `

INLINE CORNER ACTIONS: after writing your answer, if it names any corner, call the \`corner_actions\` tool exactly once with that answer's actions.
- Write the answer first; the span offsets refer to the final answer text (0-based, end exclusive, covering exactly the corner label).
- cornerKey: the exact corner label from the supplied data (for example "T1" or "Fairmont Hairpin (6)"); never invent a corner.
- label: canonical display text — "T1 · TGR Corner" when the supplied data names the corner, otherwise the bare "T1".
- target: "solo" for single-lap chat; "A", "B" or "linked" for compare chat.
- Do not use path for chat. Do not mention the tool or write JSON in the answer.
If the answer names no corner, do not call the tool.`;

export const ADJUSTMENT_FORMAT_PROMPT = `

SETUP ADJUSTMENT FORMAT: whenever your response suggests a setup change, write EACH individual suggestion in this structured form (no extra suggestions need this if none are being made — plain prose is fine when you aren't recommending a change, and never pad out an empty template or add a mandatory section heading):
- Parameter: the component name (e.g. "Brake Bias")
- Current: the known current value, only if it's given in the data you were provided
- Change to: the target value or range, plus a magnitude tag — small, medium, or big
- Purpose: one line on the effect on car behavior
Use the units already present in the tune/setup data you were given (e.g. its spring, ride-height, aero, and temperature units) — never convert to a different unit system.`;
