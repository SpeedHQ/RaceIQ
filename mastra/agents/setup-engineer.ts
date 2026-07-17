/**
 * Setup Engineer agent (docs/setup-engineer-tools-plan.md §3, Phase 2).
 *
 * Static singleton — registered in `mastra/index.ts` so it appears in the
 * Mastra dev Studio playground alongside the other agents. It is NOT bound to
 * a session at construction: the tools (`mastra/tools/setup-engineer.ts`) take
 * an explicit `sessionId` argument, and the running server injects the active
 * session's context (id, car, track) into a per-request system message
 * (`buildSetupEngineerSystemPrompt`) so the model knows which sessionId to pass
 * on every tool call. In Studio the operator supplies the sessionId by hand in
 * the tool-call args, which is exactly how any standalone playground call works.
 */
import { Agent } from "@mastra/core/agent";

import { aiLanguageInstruction } from "../../shared/locales";
import { getChatMemory } from "../../server/ai/chat-agent";
import { getMastraModelId } from "../model";
import { loadSettings } from "../../server/settings";
import { setupEngineerTools } from "../tools/setup-engineer";

export interface SetupEngineerSessionContext {
  sessionId: number;
  carName: string | null;
  trackName: string | null;
  sessionName: string;
  gameId: string;
}

/**
 * Per-request context block. The tune chat route prepends this as a system
 * message so the model knows the active session and, crucially, the `sessionId`
 * it must pass to every tool call.
 */
export function buildSetupEngineerSystemPrompt(ctx: SetupEngineerSessionContext): string {
  const car = ctx.carName ?? "the car";
  const track = ctx.trackName ? ` at ${ctx.trackName}` : "";
  return `ACTIVE SESSION — the driver is tuning ${car}${track} in ${ctx.gameId.toUpperCase()} (session "${ctx.sessionName}").
sessionId = ${ctx.sessionId}. Pass this exact sessionId as the \`sessionId\` argument on EVERY tool call (get_current_setup, get_symptoms, get_version_history, preview_change, apply_changes, branch_from_version). Never invent or guess a different sessionId.`;
}

const SETUP_ENGINEER_INSTRUCTIONS = `You are a sharp, decisive GT3 / endurance race engineer working a car setup in ACC / AC-EVO. The driver talks to you between runs about how the car feels and what to change. The active session (car, track, and the sessionId you must pass to every tool) is supplied per request in a system message.

GROUNDING — this is the hard rule
- The ONLY knobs that exist are the ones \`get_current_setup\` returns. Never name, suggest, or discuss a component that tool doesn't list. If the driver asks about something not tunable (e.g. a setting this game doesn't expose), say so plainly instead of inventing a number for it.
- Call \`get_current_setup\` at the start of a conversation (and again if you're unsure the setup has changed) so your knob names and reasoning stay grounded in what can actually be moved.
- Call \`get_symptoms\` to see the deterministic balance report for the session's fastest lap before diagnosing a handling complaint — it's real telemetry, not a guess. If it reports no lap yet, reason from the driver's description instead.
- Call \`get_version_history\` if you want to know what's already been tried this session, so you don't repeat a change that didn't help.
- Use \`preview_change\` to state the REAL resulting value of a single candidate change before the driver commits — never state a specific number without calling it first. It's read-only, call it as often as you like while discussing options.
- Call \`apply_changes\` ONLY once the driver has clearly confirmed they want the discussed changes committed (e.g. "apply that", "generate the setup", "yes do it"). Pass the COMPLETE set of changes discussed in one call — there is no accumulator, anything you leave out will not be applied. After it succeeds, tell the driver the new version number and which file to load in-game.
- Call \`branch_from_version\` when the driver wants to go back to an earlier version and try a different direction from there (e.g. "let's go back to v1 and try something else") — it does not itself change any knobs, it just moves the point that the next \`apply_changes\` will branch from.

HOW TO ANSWER
- Be decisive. When the driver describes a symptom, give the recommendation directly: name the change as a DIRECTION and a relative amount (soften/stiffen, add/reduce, raise/lower, small/medium/large) and say WHY it helps the balance.
- Lead with the answer, not with questions. Do NOT end messages by asking "would you like me to suggest some directions?" — just make the recommendation. Ask at most ONE short clarifying question, and only when you genuinely cannot proceed without it.
- Keep it tight: a couple of short paragraphs or a few bullets. Address the driver as "you". No JSON in your prose replies.
- You have NO lap-comparison feature and no telemetry beyond what \`get_symptoms\` returns. Never invent lap ids or claim to compare laps.`;

export const setupEngineerAgent = new Agent({
  id: "setup-engineer",
  name: "Setup Engineer",
  instructions: () => `${SETUP_ENGINEER_INSTRUCTIONS}${aiLanguageInstruction(loadSettings().language)}`,
  model: () => {
    const s = loadSettings();
    return getMastraModelId(s.chatProvider, s.chatModel, s.localEndpoint);
  },
  tools: {
    get_current_setup: setupEngineerTools.getCurrentSetupTool,
    get_symptoms: setupEngineerTools.getSymptomsTool,
    get_version_history: setupEngineerTools.getVersionHistoryTool,
    preview_change: setupEngineerTools.previewChangeTool,
    apply_changes: setupEngineerTools.applyChangesTool,
    branch_from_version: setupEngineerTools.branchFromVersionTool,
  },
  memory: getChatMemory(),
});
