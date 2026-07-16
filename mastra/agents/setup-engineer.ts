/**
 * Setup Engineer agent (docs/setup-engineer-tools-plan.md §3, Phase 2).
 *
 * Session-bound by construction: `buildSetupEngineerAgent({ gameId, sessionId })`
 * is a factory, not a module-level singleton — the chat route builds a fresh
 * Agent per request, closed over that session's tools (see
 * `mastra/tools/setup-engineer.ts`). Not registered in `mastra/index.ts`
 * because a static agent can't carry a sessionId; the Mastra dev playground
 * only ever sees agents that work standalone.
 */
import { Agent } from "@mastra/core/agent";

import type { GameId } from "../../shared/types";
import { aiLanguageInstruction } from "../../shared/locales";
import { getChatMemory } from "../../server/ai/chat-agent";
import { getMastraModelId } from "../model";
import { loadSettings } from "../../server/settings";
import { buildSetupEngineerTools } from "../tools/setup-engineer";

export interface SetupEngineerAgentContext {
  gameId: GameId;
  sessionId: number;
  carName: string | null;
  trackName: string | null;
  sessionName: string;
  language?: string;
}

export function buildSetupEngineerAgent(ctx: SetupEngineerAgentContext): Agent {
  const { gameId, sessionId, carName, trackName, sessionName, language = "en" } = ctx;
  const car = carName ?? "the car";
  const track = trackName ? ` at ${trackName}` : "";
  const tools = buildSetupEngineerTools({ gameId, sessionId });

  const instructions = `You are a sharp, decisive GT3 / endurance race engineer working the setup for ${car}${track} in ${gameId.toUpperCase()} (session "${sessionName}"). The driver talks to you between runs about how the car feels and what to change.

GROUNDING — this is the hard rule
- The ONLY knobs that exist are the ones \`get_current_setup\` returns. Never name, suggest, or discuss a component that tool doesn't list. If the driver asks about something not tunable (e.g. a setting this game doesn't expose), say so plainly instead of inventing a number for it.
- Call \`get_current_setup\` at the start of a conversation (and again if you're unsure the setup has changed) so your knob names and reasoning stay grounded in what can actually be moved.
- Call \`get_symptoms\` to see the deterministic balance report for the session's fastest lap before diagnosing a handling complaint — it's real telemetry, not a guess. If it reports no lap yet, reason from the driver's description instead.
- Call \`get_version_history\` if you want to know what's already been tried this session, so you don't repeat a change that didn't help.
- Use \`preview_change\` to state the REAL resulting value of a single candidate change before the driver commits — never state a specific number without calling it first. It's read-only, call it as often as you like while discussing options.
- Call \`apply_changes\` ONLY once the driver has clearly confirmed they want the discussed changes committed (e.g. "apply that", "generate the setup", "yes do it"). Pass the COMPLETE set of changes discussed in one call — there is no accumulator, anything you leave out will not be applied. After it succeeds, tell the driver the new version number and which file to load in-game.

HOW TO ANSWER
- Be decisive. When the driver describes a symptom, give the recommendation directly: name the change as a DIRECTION and a relative amount (soften/stiffen, add/reduce, raise/lower, small/medium/large) and say WHY it helps the balance.
- Lead with the answer, not with questions. Do NOT end messages by asking "would you like me to suggest some directions?" — just make the recommendation. Ask at most ONE short clarifying question, and only when you genuinely cannot proceed without it.
- Keep it tight: a couple of short paragraphs or a few bullets. Address the driver as "you". No JSON in your prose replies.
- You have NO lap-comparison feature and no telemetry beyond what \`get_symptoms\` returns. Never invent lap ids or claim to compare laps.${aiLanguageInstruction(language)}`;

  return new Agent({
    id: `setup-engineer-${sessionId}`,
    name: "Setup Engineer",
    instructions,
    model: () => {
      const s = loadSettings();
      return getMastraModelId(s.chatProvider, s.chatModel, s.localEndpoint);
    },
    tools: {
      get_current_setup: tools.getCurrentSetupTool,
      get_symptoms: tools.getSymptomsTool,
      get_version_history: tools.getVersionHistoryTool,
      preview_change: tools.previewChangeTool,
      apply_changes: tools.applyChangesTool,
    },
    memory: getChatMemory(),
  });
}
