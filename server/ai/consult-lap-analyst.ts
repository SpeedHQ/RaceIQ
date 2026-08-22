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
import { RequestContext } from "@mastra/core/request-context";
import type { GameId } from "../../shared/games/ids";
import { lapFindingGenerationCacheKey } from "../db/analysis-queries";
import { resolveSemanticLapCorners, resolveLapSegments } from "../tracks/corner-resolution";
import { CANONICAL_LAP_ANALYSIS_SEMANTIC_IDS } from "../../shared/racing/analysis/laps/semantic-frame";
import { queryLapTelemetryBySemanticId } from "../telemetry/replay";
import { semanticSamplesFromReplay } from "../telemetry/semantic-samples";
import { TRACK_CONDITION_SEMANTIC_IDS } from "./track-conditions";
import { getSecret } from "../runtime/platform/keystore";
import { loadSettings } from "../runtime/config/settings";
import { buildAnalystPrompt } from "./analyst-prompt";
// Import the raw Lap Analyst agent directly (not via ./agents) to avoid a module
// cycle: ./agents → setup-engineer agent → its tools → this file. The raw agent
// has no such back-edge. We lose the dev-only observability wrapper here, which
// the setup-engineer consult doesn't need.
import { lapAnalystAgent } from "../../mastra/agents/lap-analyst";
import { loadRepresentativeLapSelection } from "../experiments/representative-lap";
const CONSULT_LAP_ANALYSIS_SEMANTIC_IDS = [...CANONICAL_LAP_ANALYSIS_SEMANTIC_IDS, ...TRACK_CONDITION_SEMANTIC_IDS];
import { getCurrentFindingGeneration } from "../findings/store";
import { FINDING_RECEIPT_FENCE_CONTEXT_KEY } from "./chat-message-context";

interface LapAnalystConsult {
  available: boolean;
  summary: string;
  eligibilityStatus: "eligible" | "eligible_with_warning" | "ineligible" | "unknown";
  reasonCodes: string[];
  lapId?: number;
  provenance?: {
    findingGenerationId: string;
    findingContentHash: string;
    findingCacheKey: string;
  };
}

export interface ConsultLapAnalystDeps {
  loadRepresentativeLapSelection?: typeof loadRepresentativeLapSelection;
  getCurrentFindingGeneration?: typeof getCurrentFindingGeneration;
  resolveLapSegments?: typeof resolveLapSegments;
  resolveSemanticLapCorners?: typeof resolveSemanticLapCorners;
  queryLapTelemetryBySemanticId?: typeof queryLapTelemetryBySemanticId;
  loadSettings?: typeof loadSettings;
  buildAnalystPrompt?: typeof buildAnalystPrompt;
  getSecret?: typeof getSecret;
  generate?: (prompt: string, options: Record<string, unknown>) => Promise<{ text?: unknown }>;
}

export async function consultLapAnalystForSession(gameId: GameId, sessionId: number, deps: ConsultLapAnalystDeps = {}): Promise<LapAnalystConsult> {
  const loadFindingGeneration = deps.getCurrentFindingGeneration ?? getCurrentFindingGeneration;
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

  const findingScope = {
    kind: "lap",
    gameId,
    sessionId: String(lap.sessionId),
    lapId: String(lap.id),
  } as const;
  const findingGeneration = await loadFindingGeneration(findingScope);
  if (!findingGeneration) {
    return {
      available: false,
      summary: "No persisted current finding generation exists for the selected lap.",
      eligibilityStatus: selection.setupDecision.status,
      reasonCodes: selection.reasonCodes,
    };
  }
  const findingGenerationKey = lapFindingGenerationCacheKey(findingGeneration.receipt);

  const replay = await (deps.queryLapTelemetryBySemanticId ?? queryLapTelemetryBySemanticId)(lap.id, CONSULT_LAP_ANALYSIS_SEMANTIC_IDS);
  if (!replay || replay.envelopes.length === 0) {
    return {
      available: false,
      summary: "No resolver-backed telemetry exists for selected lap.",
      eligibilityStatus: selection.setupDecision.status,
      reasonCodes: selection.reasonCodes,
    };
  }
  const samples = semanticSamplesFromReplay(replay);
  const trackOrdinal = lap.trackOrdinal ?? 0;
  const segments = await (deps.resolveLapSegments ?? resolveLapSegments)(trackOrdinal, lap.gameId);
  const corners = await (deps.resolveSemanticLapCorners ?? resolveSemanticLapCorners)(trackOrdinal, lap.gameId, samples, { segments });

  const settings = (deps.loadSettings ?? loadSettings)();
  const prompt = (deps.buildAnalystPrompt ?? buildAnalystPrompt)(
    lap,
    samples,
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
    const key = await (deps.getSecret ?? getSecret)("openai-api-key");
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
    const key = await (deps.getSecret ?? getSecret)("gemini-api-key");
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
  const requestContext = new RequestContext();
  requestContext.set(FINDING_RECEIPT_FENCE_CONTEXT_KEY, {
    kind: "lap",
    gameId,
    cacheKey: findingGenerationKey,
    laps: [
      {
        lapId: lap.id,
        generationId: findingGeneration.receipt.generationId,
        contentHash: findingGeneration.receipt.contentHash,
      },
    ],
  });
  const generate = deps.generate ?? ((agentPrompt: string, options: Record<string, unknown>) => lapAnalystAgent.generate(agentPrompt, options as never));
  const result = await generate(prompt, {
    maxSteps: 5,
    ...(hideTools ? { activeTools: [] as never[] } : {}),
    modelSettings: { maxOutputTokens: 4096, temperature: 0 },
    requestContext,
  });
  const currentFindingGeneration = await loadFindingGeneration(findingScope);
  if (!currentFindingGeneration || lapFindingGenerationCacheKey(currentFindingGeneration.receipt) !== findingGenerationKey) {
    return {
      available: false,
      summary: "Lap findings changed during analyst consultation. No analyst claims were retained.",
      eligibilityStatus: selection.setupDecision.status,
      reasonCodes: selection.reasonCodes,
    };
  }
  const text = typeof result.text === "string" ? result.text.trim() : "";
  return {
    available: true,
    summary: text || "Lap Analyst returned no content.",
    eligibilityStatus: selection.setupDecision.status,
    reasonCodes: selection.reasonCodes,
    lapId: lap.id,
    provenance: {
      findingGenerationId: findingGeneration.receipt.generationId,
      findingContentHash: findingGeneration.receipt.contentHash,
      findingCacheKey: findingGenerationKey,
    },
  };
}
