import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { existsSync, readdirSync } from "fs";
import { resolve } from "path";
import { PUBLIC_DIR } from "../paths";

import { IdParamSchema, GameIdQuerySchema } from "../../shared/schemas";
import { udpListener } from "../udp";
import { wsManager } from "../ws";
import { lapDetector } from "../lap-detector";
import { loadSettings, saveSettings, PartialSettingsSchema } from "../settings";
import { getProfiles, insertProfile, updateProfile, deleteProfile, getLaps } from "../db/queries";
import { getRunningGame } from "../games/registry";
import { getTrackOutlineByOrdinal } from "../../shared/track-data";

const ProfileBodySchema = z.object({ name: z.string().min(1) });

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
    return c.json({
      ...settings,
      udpPort: udpListener.port,
      geminiApiKeySet: hasGeminiKey,
    });
  })

  // GET /api/ai-models — available models per provider
  .get("/api/ai-models", async (c) => {
    const { getClaudeModels, getGeminiModels } = await import("../ai/providers");
    const { getSecret } = await import("../keystore");
    const geminiKey = await getSecret("gemini-api-key");
    const geminiModels = geminiKey ? await getGeminiModels(geminiKey) : [];
    return c.json({
      "claude-cli": getClaudeModels(),
      "gemini": geminiModels,
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
  .put("/api/settings", zValidator("json", PartialSettingsSchema), async (c) => {
    const parseResult = c.req.valid("json");
    const current = loadSettings();
    const merged = { ...current, ...parseResult };

    if (parseResult.tireTempCelsiusThresholds) {
      merged.tireTempCelsiusThresholds = {
        ...current.tireTempCelsiusThresholds,
        ...parseResult.tireTempCelsiusThresholds,
      };
    }

    const t = merged.tireTempCelsiusThresholds;
    if (t.cold >= t.warm || t.warm >= t.hot) {
      return c.json({ error: "Thresholds must be in order: cold < warm < hot" }, 400);
    }

    for (const [name, arr] of [
      ["tireHealthThresholds", merged.tireHealthThresholds.values],
      ["suspensionThresholds", merged.suspensionThresholds.values],
    ] as const) {
      for (let i = 1; i < arr.length; i++) {
        if (arr[i] <= arr[i - 1])
          return c.json({ error: `${name} must be in ascending order` }, 400);
      }
    }

    try {
      if (merged.udpPort !== udpListener.port) {
        await udpListener.restart(merged.udpPort);
      }
      if (merged.wsRefreshRate) {
        wsManager.setRefreshRate(merged.wsRefreshRate);
      }
      saveSettings(merged);
      return c.json(merged);
    } catch {
      return c.json({ error: `Failed to bind to port ${merged.udpPort}` }, 500);
    }
  })

  // GET /api/profiles
  .get("/api/profiles", async (c) => {
    return c.json(await getProfiles());
  })

  // POST /api/profiles
  .post("/api/profiles", zValidator("json", ProfileBodySchema), async (c) => {
    const { name } = c.req.valid("json");
    const trimmed = name.trim();
    const id = await insertProfile(trimmed);
    return c.json({ id, name: trimmed }, 201);
  })

  // PATCH /api/profiles/:id
  .patch(
    "/api/profiles/:id",
    zValidator("param", IdParamSchema),
    zValidator("json", ProfileBodySchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { name } = c.req.valid("json");
      const trimmed = name.trim();
      const ok = await updateProfile(id, trimmed);
      if (!ok) return c.json({ error: "Profile not found" }, 404);
      return c.json({ id, name: trimmed });
    },
  )

  // DELETE /api/profiles/:id
  .delete(
    "/api/profiles/:id",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const all = await getProfiles();
      if (all.length <= 1)
        return c.json({ error: "Cannot delete the last profile" }, 400);
      const ok = await deleteProfile(id);
      if (!ok) return c.json({ error: "Profile not found" }, 404);
      return c.json({ ok: true });
    },
  )

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
    const allLaps = await getLaps(undefined, gameId);
    const validLaps = allLaps.filter((l) => l.isValid && l.lapTime > 0);

    const lapsByTrack = new Map<number, number>();
    for (const lap of allLaps) {
      if (lap.trackOrdinal && lap.lapTime > 0) {
        lapsByTrack.set(
          lap.trackOrdinal,
          (lapsByTrack.get(lap.trackOrdinal) ?? 0) + 1,
        );
      }
    }

    let totalDistanceMeters = 0;
    for (const [trackOrd, count] of lapsByTrack) {
      const outline = gameId
        ? getTrackOutlineByOrdinal(trackOrd, gameId)
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

    const totalTime = allLaps.reduce(
      (s, l) => s + (l.lapTime > 0 ? l.lapTime : 0),
      0,
    );

    return c.json({
      totalLaps: allLaps.length,
      validLaps: validLaps.length,
      totalDistanceMeters,
      totalTimeSec: totalTime,
      uniqueTracks: lapsByTrack.size,
      uniqueCars: new Set(allLaps.map((l) => l.carOrdinal).filter(Boolean))
        .size,
    });
  });
