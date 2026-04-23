import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { existsSync, readdirSync } from "fs";
import { resolve } from "path";
import { PUBLIC_DIR } from "../paths";

import { GameIdQuerySchema } from "../../shared/schemas";
import { udpListener } from "../udp";
import { wsManager } from "../ws";
import { lapDetector } from "../pipeline";
import { loadSettings, saveSettings, PartialSettingsSchema } from "../settings";
import { getLapStats, setCacheMaxBytes } from "../db/queries";
import { getRunningGame } from "../games/registry";
import { getTrackOutlineByOrdinal } from "../../shared/track-data";

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
    const settings = loadSettings();
    const { getSecret } = await import("../keystore");
    const hasGeminiKey = !!(await getSecret("gemini-api-key"));
    const hasOpenaiKey = !!(await getSecret("openai-api-key"));
    const hasAnthropicKey = !!(await getSecret("anthropic-api-key"));
    return c.json({
      ...settings,
      udpPort: udpListener.port,
      geminiApiKeySet: hasGeminiKey,
      openaiApiKeySet: hasOpenaiKey,
      anthropicApiKeySet: hasAnthropicKey,
    });
  })

  // GET /api/ai-providers — available providers
  .get("/api/ai-providers", async (c) => {
    const { getProviders } = await import("../ai/providers");
    return c.json(getProviders());
  })

  // GET /api/ai-models — available models per provider
  .get("/api/ai-models", async (c) => {
    const { getGeminiModels, getOpenAiModels, getLocalModels } = await import("../ai/providers");
    const { getSecret } = await import("../keystore");
    const geminiKey = await getSecret("gemini-api-key");
    const geminiModels = geminiKey ? await getGeminiModels(geminiKey) : [];
    const settings = loadSettings();
    const localModels = await getLocalModels(settings.localEndpoint || "http://localhost:1234/v1");
    return c.json({
      "gemini": geminiModels,
      "openai": getOpenAiModels(),
      "local": localModels,
    });
  })

  // PUT /api/ai-key — store or clear an AI provider API key
  .put("/api/ai-key", async (c) => {
    const body = await c.req.json() as { provider: string; apiKey: string };
    const { setSecret } = await import("../keystore");
    await setSecret(`${body.provider}-api-key`, body.apiKey ?? "");
    return c.json({ ok: true });
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
      saveSettings(merged);
      if (provided.onboardingComplete) {
        wsManager.broadcastNotification({ type: "onboarding_complete" });
      }
      return c.json(merged);
    } catch {
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
      const outline = gameId
        ? getTrackOutlineByOrdinal(trackOrdinal, gameId)
        : null;
      if (outline && outline.length > 1) {
        let trackLen = 0;
        for (let i = 1; i < outline.length; i++) {
          const dx = outline[i].x - outline[i - 1].x;
          const dz = outline[i].z - outline[i - 1].z;
          trackLen += Math.sqrt(dx * dx + dz * dz);
        }
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
