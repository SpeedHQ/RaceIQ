/**
 * consultLapAnalystForSession — let the Setup Engineer delegate deep, corner-by
 * corner lap analysis to the Lap Analyst agent.
 *
 * The Setup Engineer reasons about *setup*; the Lap Analyst reasons about
 * *driving and telemetry*. When the driver asks something that needs the latter
 * ("why am I slow in the last sector?"), the engineer calls this to get a real
 * analysis of the session's representative lap instead of guessing.
 *
 * Mirrors the invocation the `/api/laps/:id/analyse` route uses (corners,
 * track context, prompt, and the provider secret→env bridge for the Lap
 * Analyst's own `aiProvider`/`aiModel`, which are distinct from the chat
 * provider the engineer runs on).
 */
import type { GameId } from "../../shared/types";
import { getCorners } from "../db/queries";
import { detectCorners } from "../corner-detection";
import { loadSettings } from "../settings";
import { resolveAi } from "./ai-runtime";
import { buildAnalystPrompt } from "./analyst-prompt";
import { resolveTrack } from "../track-info";
import { runAiText } from "./model-provider";
import { loadRepresentativeLap } from "./setup-engineer-context";
import { lapAnalystAgent } from "../../mastra/agents/lap-analyst";

export interface LapAnalystConsult {
  available: boolean;
  summary: string;
}

export async function consultLapAnalystForSession(sessionId: number): Promise<LapAnalystConsult> {
  const lap = await loadRepresentativeLap(sessionId);
  if (!lap) return { available: false, summary: "No analysable lap yet for this session." };

  const trackOrdinal = lap.trackOrdinal ?? 0;
  let corners = trackOrdinal > 0 && lap.gameId ? await getCorners(trackOrdinal, lap.gameId as GameId) : [];
  if (corners.length === 0) corners = detectCorners(lap.telemetry);

  const settings = loadSettings();
  const segments = resolveTrack(lap.gameId, lap.trackOrdinal).segments;
  const prompt = buildAnalystPrompt(
    lap,
    lap.telemetry,
    corners,
    settings.unit,
    settings.temperatureUnit,
    undefined,
    segments,
    undefined,
    settings.language,
  );
  const ai = await resolveAi("analysis", settings);
  const result = await runAiText(ai, {
    prompt,
    maxOutputTokens: 4096,
    temperature: 0,
  }, async (requestContext) =>
    lapAnalystAgent.generate(prompt, {
      maxSteps: 5,
      modelSettings: { maxOutputTokens: 4096, temperature: 0 },
      requestContext,
    }));
  const text = result.analysis.trim();
  return { available: true, summary: text || "Lap Analyst returned no content." };
}
