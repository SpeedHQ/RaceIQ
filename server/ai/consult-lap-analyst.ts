/**
 * consultLapAnalystForSession — let the Setup Engineer delegate deep, corner-by
 * corner lap analysis to the Lap Analyst agent.
 *
 * The Setup Engineer reasons about *setup*; the Lap Analyst reasons about
 * *driving and telemetry*. When the driver asks something that needs the latter
 * ("why am I slow in the last sector?"), the engineer calls this to get a real
 * analysis of the policy-selected lap instead of guessing.
 *
 * Mirrors the invocation the `/api/laps/:id/analyse` route uses (corners,
 * track context, prompt, and the provider secret→env bridge for the Lap
 * Analyst's own `aiProvider`/`aiModel`, which are distinct from the chat
 * provider the engineer runs on).
 */
import type { GameId } from "../../shared/games/ids";
import { resolveLapCorners, resolveLapSegments } from "../tracks/corner-resolution";
import { getSecret } from "../runtime/platform/keystore";
import { loadSettings } from "../runtime/config/settings";
import { buildAnalystPrompt } from "./analyst-prompt";
// Import the raw Lap Analyst agent directly (not via ./agents) to avoid a module
// cycle: ./agents → setup-engineer agent → its tools → this file. The raw agent
// has no such back-edge. We lose the dev-only observability wrapper here, which
// the setup-engineer consult doesn't need.
import { lapAnalystAgent } from "../../mastra/agents/lap-analyst";
import { loadRepresentativeLapSelection } from "../experiments/representative-lap";
import { getCurrentFindingGeneration } from "../findings/store";

interface LapAnalystConsult {
  available: boolean;
  summary: string;
  eligibilityStatus: "eligible" | "eligible_with_warning" | "ineligible" | "unknown";
  reasonCodes: string[];
}

export interface ConsultLapAnalystDeps {
  loadRepresentativeLapSelection?: typeof loadRepresentativeLapSelection;
  getCurrentFindingGeneration?: typeof getCurrentFindingGeneration;
}

export async function consultLapAnalystForSession(
  gameId: GameId,
  sessionId: number,
  deps: ConsultLapAnalystDeps = {},
): Promise<LapAnalystConsult> {
  const selection = await (deps.loadRepresentativeLapSelection ?? loadRepresentativeLapSelection)(sessionId);
  const { lap } = selection;
  if (!lap || lap.gameId !== gameId) {
    return {
      available: false,
      summary: "No policy-suitable analysable lap yet for this game and session.",
      eligibilityStatus: selection.setupDecision.status,
      reasonCodes: selection.reasonCodes,
    };
  }

  const findingGeneration = await (deps.getCurrentFindingGeneration ?? getCurrentFindingGeneration)({
    kind: "lap",
    gameId,
    sessionId: String(lap.sessionId),
    lapId: String(lap.id),
  });
  if (!findingGeneration) {
    return {
      available: false,
      summary: "No persisted current finding generation exists for the selected lap.",
      eligibilityStatus: selection.setupDecision.status,
      reasonCodes: selection.reasonCodes,
    };
  }

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
    undefined,
    findingGeneration.findings,
  );

  // Bridge the Lap Analyst's provider secret → env. It reads `aiProvider`
  // (default gemini), independent of the setup-engineer chat provider.
  const provider = settings.aiProvider;
  if (provider === "openai") {
    const key = await getSecret("openai-api-key");
    if (!key)
      return {
        available: false,
        summary: "Lap Analyst unavailable — OpenAI API key not set (Settings → AI Analysis).",
        eligibilityStatus: selection.setupDecision.status,
        reasonCodes: selection.reasonCodes,
      };
    process.env.OPENAI_API_KEY = key;
  } else if (provider === "local") {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "local";
    process.env.OPENAI_BASE_URL = settings.localEndpoint || "http://localhost:1234/v1";
  } else {
    const key = await getSecret("gemini-api-key");
    if (!key)
      return {
        available: false,
        summary: "Lap Analyst unavailable — Gemini API key not set (Settings → AI Analysis).",
        eligibilityStatus: selection.setupDecision.status,
        reasonCodes: selection.reasonCodes,
      };
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
  }

  const hideTools = provider === "local";
  const result = await lapAnalystAgent.generate(prompt, {
    maxSteps: 5,
    ...(hideTools ? { activeTools: [] as never[] } : {}),
    modelSettings: { maxOutputTokens: 4096, temperature: 0 },
  });
  const text = typeof result.text === "string" ? result.text.trim() : "";
  return {
    available: true,
    summary: text || "Lap Analyst returned no content.",
    eligibilityStatus: selection.setupDecision.status,
    reasonCodes: selection.reasonCodes,
  };
}
