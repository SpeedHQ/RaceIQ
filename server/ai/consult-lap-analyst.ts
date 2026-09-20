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
import { resolveLapCorners, resolveLapSegments } from "../tracks/corner-resolution";
import { loadSettings } from "../runtime/config/settings";
import { configureAiProviderEnvironment } from "./openai-compatible-provider";
import { buildAnalystPrompt } from "./analyst-prompt";
// Import the raw Lap Analyst agent directly (not via ./agents) to avoid a module
// cycle: ./agents → setup-engineer agent → its tools → this file. The raw agent
// has no such back-edge. We lose the dev-only observability wrapper here, which
// the setup-engineer consult doesn't need.
import { lapAnalystAgent } from "../../mastra/agents/lap-analyst";
import { loadRepresentativeLap } from "../experiments/representative-lap";

interface LapAnalystConsult {
  available: boolean;
  summary: string;
}

export async function consultLapAnalystForSession(sessionId: number): Promise<LapAnalystConsult> {
  const lap = await loadRepresentativeLap(sessionId);
  if (!lap) return { available: false, summary: "No analysable lap yet for this session." };

  const trackOrdinal = lap.trackOrdinal ?? 0;
  const segments = await resolveLapSegments(trackOrdinal, lap.gameId);
  const corners = await resolveLapCorners(trackOrdinal, lap.gameId, lap.telemetry, { segments });

  const settings = loadSettings();
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

  const provider = settings.aiProvider;
  if (!provider) return { available: false, summary: "Lap Analyst unavailable — no AI provider selected." };
  await configureAiProviderEnvironment(provider, settings.localEndpoint || "http://localhost:1234/v1");

  const hideTools = provider === "openai-compatible";
  const result = await lapAnalystAgent.generate(prompt, {
    maxSteps: 5,
    ...(hideTools ? { activeTools: [] as never[] } : {}),
    modelSettings: { maxOutputTokens: 4096, temperature: 0 },
  });
  const text = typeof result.text === "string" ? result.text.trim() : "";
  return { available: true, summary: text || "Lap Analyst returned no content." };
}
