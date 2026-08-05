import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PUBLIC_DIR, IS_COMPILED } from "../runtime/config/paths";

import { GameIdQuerySchema } from "@shared/platform/http/route-schemas";
import { udpListener } from "../runtime/udp-listener";
import { wsManager } from "../runtime/websocket-manager";
import { lapDetector } from "../telemetry/live-pipeline";
import { loadSettings, saveSettings, PartialSettingsSchema } from "../runtime/config/settings";
import { getSecret, setSecret } from "../runtime/platform/keystore";
import { enableLaunchOnLogin, disableLaunchOnLogin, getLaunchOnLoginExeDir } from "../runtime/platform/launch-on-login";
import { getLapStats } from "../db/lap-read-queries";
import { setCacheMaxBytes } from "../db/telemetry-replay-storage";
import { getRunningGame } from "../games/registry";
import { getTrackLengthMeters } from "../../shared/racing/tracks/recording/outlines";
import { withOnboardingOverride } from "../runtime/options";

import { getGeminiModelsDetailed, getLocalModelsDetailed, getOpenAiModels, getProviders } from "../ai/providers";
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const MODELS_EMPTY_RETRY_MS = 10 * 1000;
let cachedGeminiModels: { key: string; models: { id: string; name: string }[]; at: number } | null = null;
let cachedLocalModels: { endpoint: string; models: { id: string; name: string; contextLength?: number }[]; at: number } | null = null;
let cachedLocalEmpty: { endpoint: string; at: number } | null = null;
export type AiProviderDiscovery = {
  id: string;
  name: string;
  ready?: boolean;
  error?: string | null;
};


export async function getAiProviderDiscovery(): Promise<AiProviderDiscovery[]> {
  return getProviders();
}

export const settingsRoutes = new Hono()
  // GET /api/status
  .get("/api/status", (c) => {
    const session = lapDetector.session;
    const runningGame = getRunningGame();
    return c.json({
      udpReceiving: udpListener.receiving,
      packetsPerSec: udpListener.packetsPerSec,
      connectedClients: wsManager.connectedClients,
      droppedPackets: udpListener.droppedPackets,
      udpPort: udpListener.port,
      detectedGame: runningGame
        ? { id: runningGame.id, name: runningGame.shortName }
        : null,
      currentSession: session
        ? {
            id: session.sessionId,
            carOrdinal: session.carOrdinal,
            trackOrdinal: session.trackOrdinal,
            createdAt: "",
          }
        : null,
    });
  })

  // GET /api/settings
  .get("/api/settings", async (c) => {
    const settings = withOnboardingOverride(loadSettings());
    const hasGeminiKey = !!(await getSecret("gemini-api-key"));
    const hasOpenaiKey = !!(await getSecret("openai-api-key"));
    const hasAnthropicKey = !!(await getSecret("anthropic-api-key"));
    return c.json({
      ...settings,
      udpPort: udpListener.port,
      geminiApiKeySet: hasGeminiKey,
      openaiApiKeySet: hasOpenaiKey,
      anthropicApiKeySet: hasAnthropicKey,
      isCompiled: IS_COMPILED,
    });
  })

  // GET /api/ai-providers — available providers
  .get("/api/ai-providers", async (c) => c.json(await getAiProviderDiscovery()))

  // GET /api/ai-models — available models per provider
  .get("/api/ai-models", async (c) => {
    const forceRefresh = c.req.query("refresh") === "1";
    console.info(`[AI] ai-models request refresh=${forceRefresh ? "1" : "0"} providers=${c.req.query("providers") ?? "<settings>"}`);

    const settings = loadSettings();
    const requestedProviders = new Set(
      (c.req.query("providers") ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p === "gemini" || p === "openai" || p === "local"),
    );
    const useRequestedProviders = requestedProviders.size > 0;
    const shouldFetchGemini = useRequestedProviders
      ? requestedProviders.has("gemini")
      : settings.aiProvider === "gemini" || settings.chatProvider === "gemini";
    let geminiModels: { id: string; name: string }[] = [];
    let geminiError: string | null = null;
    if (shouldFetchGemini) {
      const geminiKey = await getSecret("gemini-api-key");
      if (geminiKey) {
        const geminiCacheHit = !forceRefresh
          && cachedGeminiModels
          && cachedGeminiModels.key === geminiKey
          && (Date.now() - cachedGeminiModels.at) < MODELS_CACHE_TTL_MS;
        if (geminiCacheHit && cachedGeminiModels) {
          console.info("[AI] ai-models gemini cache hit");
          geminiModels = cachedGeminiModels.models;
        } else {
          console.info("[AI] ai-models gemini cache miss");
          const fetchedGemini = await getGeminiModelsDetailed(geminiKey);
          geminiError = fetchedGemini.error;
          const fetchedGeminiModels = fetchedGemini.models;
          if (fetchedGeminiModels.length > 0) {
            geminiModels = fetchedGeminiModels;
            cachedGeminiModels = { key: geminiKey, models: geminiModels, at: Date.now() };
          } else if (cachedGeminiModels && cachedGeminiModels.key === geminiKey) {
            console.warn("[AI] Gemini fetch returned empty; keeping last successful cached models");
            geminiModels = cachedGeminiModels.models;
          } else {
            geminiModels = [];
          }
        }
      } else {
        console.warn("[AI] Gemini API key missing while fetching model list");
        geminiError = "Gemini API key not set.";
        cachedGeminiModels = null;
      }
    } else {
      console.info("[AI] ai-models gemini fetch skipped (provider not gemini)");
    }

    const shouldFetchLocal = useRequestedProviders
      ? requestedProviders.has("local")
      : settings.aiProvider === "local" || settings.chatProvider === "local";
    let localModels: { id: string; name: string; contextLength?: number }[] = [];
    let localError: string | null = null;
    if (shouldFetchLocal) {
      const endpoint = settings.localEndpoint || "http://localhost:1234/v1";
      const localCacheHit = !forceRefresh
        && cachedLocalModels
        && cachedLocalModels.endpoint === endpoint
        && (Date.now() - cachedLocalModels.at) < MODELS_CACHE_TTL_MS;
      const localEmptyRecent = !forceRefresh
        && cachedLocalEmpty
        && cachedLocalEmpty.endpoint === endpoint
        && (Date.now() - cachedLocalEmpty.at) < MODELS_EMPTY_RETRY_MS;
      let fetchedLocal: Awaited<ReturnType<typeof getLocalModelsDetailed>>;
      if (localCacheHit && cachedLocalModels) {
        console.info("[AI] ai-models local cache hit");
        fetchedLocal = { models: cachedLocalModels.models, error: null };
      } else if (localEmptyRecent) {
        console.info("[AI] ai-models local recent-empty cache hit");
        fetchedLocal = { models: [], error: localError };
      } else {
        console.info("[AI] ai-models local cache miss");
        fetchedLocal = await getLocalModelsDetailed(endpoint);
      }
      localError = fetchedLocal.error;
      const fetchedLocalModels = fetchedLocal.models;
      localModels = fetchedLocalModels.length > 0
        ? fetchedLocalModels
        : (cachedLocalModels && cachedLocalModels.endpoint === endpoint ? cachedLocalModels.models : []);
      if (fetchedLocalModels.length > 0) {
        cachedLocalModels = { endpoint, models: localModels, at: Date.now() };
        cachedLocalEmpty = null;
      } else if (!localCacheHit) {
        cachedLocalEmpty = { endpoint, at: Date.now() };
      }
    } else {
      console.info("[AI] ai-models local fetch skipped (provider not local)");
    }

    return c.json({
      "gemini": geminiModels,
      "openai": getOpenAiModels(),
      "local": localModels,
      "_errors": { gemini: geminiError, openai: null, local: localError },
    });
  })

  // PUT /api/ai-key — store or clear an AI provider API key
  .put("/api/ai-key", async (c) => {
    const body = await c.req.json() as { provider: string; apiKey: string };
    try {
      await setSecret(`${body.provider}-api-key`, body.apiKey ?? "");
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to store API key";
      return c.json({ ok: false, error: message }, 500);
    }
  })

  // PUT /api/settings
  .put("/api/settings", async (c) => {
    const body = await c.req.json();
    const parseResult = PartialSettingsSchema.parse(body);
    const current = loadSettings();
    // Only merge keys explicitly sent in the request body (Zod partial applies defaults for missing fields)
    const provided: Record<string, unknown> = {};
    for (const key of Object.keys(body)) {
      if (key in parseResult) provided[key] = (parseResult as Record<string, unknown>)[key];
    }
    const merged = { ...current, ...provided };
    const startedAt = performance.now();

    try {
      if (merged.udpPort !== udpListener.port) {
        await udpListener.restart(merged.udpPort);
      }
      if (merged.wsRefreshRate) {
        wsManager.setRefreshRate(merged.wsRefreshRate);
      }
      if (typeof merged.cacheMaxMB === "number") {
        setCacheMaxBytes(merged.cacheMaxMB * 1024 * 1024);
      }
      if ("launchOnLogin" in provided) {
        if (merged.launchOnLogin) {
          enableLaunchOnLogin(getLaunchOnLoginExeDir());
        } else {
          disableLaunchOnLogin();
        }
      }
      saveSettings(merged);
      if (provided.onboardingComplete) {
        wsManager.broadcastNotification({ type: "onboarding_complete" });
      }
      const durationMs = Math.round(performance.now() - startedAt);
      console.info(`[Settings] PUT /api/settings saved in ${durationMs}ms`);
      return c.json(merged);
    } catch (err) {
      const durationMs = Math.round(performance.now() - startedAt);
      console.error(`[Settings] PUT /api/settings failed in ${durationMs}ms`, err instanceof Error ? err.message : String(err));
      return c.json({ error: `Failed to bind to port ${merged.udpPort}` }, 500);
    }
  })

  // GET /api/wheels
  .get("/api/wheels", (c) => {
    const wheelsDir = resolve(PUBLIC_DIR, "wheels");
    if (!existsSync(wheelsDir)) return c.json([]);
    const files = readdirSync(wheelsDir).filter((f) =>
      /\.(svg|webp|png|jpg|jpeg)$/i.test(f),
    );
    files.sort((a, b) => {
      const aSimple = a.toLowerCase().startsWith("simple");
      const bSimple = b.toLowerCase().startsWith("simple");
      if (aSimple && !bSimple) return -1;
      if (!aSimple && bSimple) return 1;
      return a.localeCompare(b);
    });
    return c.json(
      files.map((f) => {
        const name = f.substring(0, f.lastIndexOf("."));
        return { id: f, name, src: `/wheels/${f}` };
      }),
    );
  })

  // GET /api/stats
  .get("/api/stats", zValidator("query", GameIdQuerySchema), async (c) => {
    const { gameId } = c.req.valid("query");
    const stats = await getLapStats(gameId);

    let totalDistanceMeters = 0;
    for (const { trackOrdinal, count } of stats.lapsByTrack) {
      const trackLen = gameId ? getTrackLengthMeters(trackOrdinal, gameId) : null;
      if (trackLen !== null) {
        totalDistanceMeters += trackLen * count;
      }
    }

    return c.json({
      totalLaps: stats.totalLaps,
      validLaps: stats.validLaps,
      totalDistanceMeters,
      totalTimeSec: stats.totalTimeSec,
      uniqueTracks: stats.uniqueTracks,
      uniqueCars: stats.uniqueCars,
    });
  });
