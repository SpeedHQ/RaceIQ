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
import { getSecret } from "../keystore";
import { loadSettings } from "../settings";
import { buildAnalystPrompt } from "./analyst-prompt";
import { resolveTrack } from "../track-info";
// Import the raw Lap Analyst agent directly (not via ./agents) to avoid a module
// cycle: ./agents → setup-engineer agent → its tools → this file. The raw agent
// has no such back-edge. We lose the dev-only observability wrapper here, which
// the setup-engineer consult doesn't need.
import { lapAnalystAgent } from "../../mastra/agents/lap-analyst";
import { loadRepresentativeLap } from "./setup-engineer-context";

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

  // Bridge the Lap Analyst's provider secret → env. It reads `aiProvider`
  // (default gemini), independent of the setup-engineer chat provider.
  const provider = settings.aiProvider;
  if (provider === "openai") {
    const key = await getSecret("openai-api-key");
    if (!key) return { available: false, summary: "Lap Analyst unavailable — OpenAI API key not set (Settings → AI Analysis)." };
    process.env.OPENAI_API_KEY = key;
  } else if (provider === "local") {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "local";
    process.env.OPENAI_BASE_URL = settings.localEndpoint || "http://localhost:1234/v1";
  } else {
    const key = await getSecret("gemini-api-key");
    if (!key) return { available: false, summary: "Lap Analyst unavailable — Gemini API key not set (Settings → AI Analysis)." };
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
  }

  const hideTools = provider === "local";
  const result = await lapAnalystAgent.generate(prompt, {
    maxSteps: 5,
    ...(hideTools ? { activeTools: [] as never[] } : {}),
    modelSettings: { maxOutputTokens: 4096, temperature: 0 },
  });
  const text = typeof result.text === "string" ? result.text.trim() : "";
  return { available: true, summary: text || "Lap Analyst returned no content." };
}
