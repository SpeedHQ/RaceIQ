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
