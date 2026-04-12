import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { IdParamSchema } from "../../shared/schemas";
import { GameIdSchema } from "../../shared/types";
import type { Tune } from "../../shared/types";
import {
  getLaps,
  getLapById,
  deleteLap,
  updateLapNotes,
  updateLapValidity,
  getCorners,
  saveCorners,
  getAnalysis,
  saveAnalysis,
  getCompareAnalysis,
  saveCompareAnalysis,
  deleteCompareAnalysis,
} from "../db/queries";
import { assessLapRecording } from "../lap-quality";

// Toggle: set true to use native ACC lastSectorTime transitions in recheck instead of distance-fraction
const USE_NATIVE_ACC_SECTORS = false;
import { getTuneById as getDbTune } from "../db/tune-queries";
import { generateExport } from "../export";
import { compareLaps } from "../comparison";
import { detectCorners } from "../corner-detection";
import { getTrackSectorsByOrdinal } from "../../shared/track-data";
import { getTrackOutlineSectors } from "../db/queries";
import type { GameId } from "../../shared/types";
import { loadSettings } from "../settings";
import { buildAnalystPrompt } from "../ai/analyst-prompt";
import {
  getChatMemory,
  chatThreadId,
  compareChatThreadId,
  CHAT_RESOURCE_ID,
} from "../ai/chat-agent";
import { runGemini, runOpenAi } from "../ai/providers";
import { getSecret } from "../keystore";
import { deleteAnalysis as deleteAnalysisQuery } from "../db/queries";
import { tryGetGame } from "../../shared/games/registry";
import { loadSharedTrackMeta } from "../../shared/track-data";
import { buildChatSystemPrompt } from "../ai/chat-prompt";
import { buildCompareChatSystemPrompt } from "../ai/compare-chat-prompt";
import {
  buildInputsComparePrompt,
  InputsCompareSchema,
} from "../ai/inputs-compare-prompt";
// Dev uses the full Mastra instance (so Studio sees traces); prod tree-shakes
// the Mastra wrapper out. See `server/ai/agents.ts` for the switch.
import {
  lapChatAgent,
  compareEngineerAgent,
  compareChatAgent,
} from "../ai/agents";

const CompareParamsSchema = z.object({
  id1: z.string().transform(val => parseInt(val, 10)),
  id2: z.string().transform(val => parseInt(val, 10)),
});

const LapsQuerySchema = z.object({
  gameId: GameIdSchema.optional(),
});

const AnalyseQuerySchema = z.object({
  regenerate: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  cacheOnly: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

const BulkDeleteSchema = z.object({
  ids: z.array(z.number().int()),
});

const ChatBodySchema = z.object({
  message: z.string().min(1).max(2000),
});

export const lapRoutes = new Hono()
  // ── List laps ────────────────────────────────────────────────
  .get("/api/laps", zValidator("query", LapsQuerySchema), async (c) => {
    const { gameId } = c.req.valid("query");
    const lapList = await getLaps(gameId);
    return c.json(lapList);
  })

  // ── Bulk-delete by IDs (must precede :id routes) ────────────
  .post(
    "/api/laps/bulk-delete",
    zValidator("json", BulkDeleteSchema),
    async (c) => {
      const { ids } = c.req.valid("json");
      let count = 0;
      for (const id of ids) {
        if (await deleteLap(id)) count++;
      }
      return c.json({ deleted: count });
    }
  )

  // ── Get single lap ──────────────────────────────────────────
  .get("/api/laps/:id", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const lap = await getLapById(id);
    if (!lap) return c.json({ error: "Lap not found" }, 404);

    // Compute sector times server-side
    let sectorTimes: { times: [number, number, number]; s1Idx: number; s2Idx: number; firstDist: number; lapDist: number } | null = null;
    const packets = lap.telemetry;
    if (packets.length >= 10 && lap.trackOrdinal != null) {
      const dbSectors = lap.gameId ? await getTrackOutlineSectors(lap.trackOrdinal, lap.gameId as GameId) : null;
      const bundled = getTrackSectorsByOrdinal(lap.trackOrdinal);
      const sectors = dbSectors ?? bundled;
      if (sectors?.s1End && sectors?.s2End) {
        const firstDist = packets[0].DistanceTraveled;
        const lastDist = packets[packets.length - 1].DistanceTraveled;
        const lapDist = lastDist - firstDist;
        if (lapDist > 0) {
          // Determine the best time source: CurrentLap if it progresses, else TimestampMS
          const lapProgression = packets[packets.length - 1].CurrentLap - packets[0].CurrentLap;
          const useTimestamp = lapProgression < 1; // CurrentLap unreliable (e.g. ACC with invalid iCurrentTime)
          const getTime = (i: number) => useTimestamp
            ? (packets[i].TimestampMS - packets[0].TimestampMS) / 1000
            : packets[i].CurrentLap - packets[0].CurrentLap;

          let s1Time = 0, s2Time = 0, s1Idx = -1, s2Idx = -1;
          for (let i = 0; i < packets.length; i++) {
            const frac = (packets[i].DistanceTraveled - firstDist) / lapDist;
            if (s1Idx < 0 && frac >= sectors.s1End) {
              s1Idx = i;
              s1Time = getTime(i);
            }
            if (s2Idx < 0 && frac >= sectors.s2End) {
              s2Idx = i;
              s2Time = getTime(i) - (s1Idx >= 0 ? getTime(s1Idx) : 0);
            }
          }
          const totalLapTime = lap.lapTime || (useTimestamp
            ? (packets[packets.length - 1].TimestampMS - packets[0].TimestampMS) / 1000
            : packets[packets.length - 1].CurrentLap - packets[0].CurrentLap);
          let s3Time = totalLapTime - s1Time - s2Time;
          if (s3Time < 0) s3Time = 0;
          sectorTimes = { times: [s1Time, s2Time, s3Time], s1Idx, s2Idx, firstDist, lapDist };
        }
      }
    }

    return c.json({ ...lap, sectorTimes });
  })

  // ── Export lap telemetry as text ────────────────────────────
  .get(
    "/api/laps/:id/export",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const lap = await getLapById(id);
      if (!lap) return c.json({ error: "Lap not found" }, 404);
      const packets = lap.telemetry;
      if (packets.length === 0)
        return c.json({ error: "No telemetry data" }, 400);
      const exportText = generateExport(lap, packets);
      return c.text(exportText);
    }
  )

  // ── AI analysis ─────────────────────────────────────────────
  .post(
    "/api/laps/:id/analyse",
    zValidator("param", IdParamSchema),
    zValidator("query", AnalyseQuerySchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { regenerate, cacheOnly } = c.req.valid("query");

      const lap = await getLapById(id);
      if (!lap) return c.json({ error: "Lap not found" }, 404);
      if (lap.telemetry.length === 0)
        return c.json({ error: "No telemetry data" }, 400);

      const trackOrdinal = lap.trackOrdinal ?? 0;
      const corners = trackOrdinal > 0 && lap.gameId ? await getCorners(trackOrdinal, lap.gameId) : [];

      // Compute corner fracs for client-side track highlighting
      const totalDist = lap.telemetry.length > 1
        ? lap.telemetry[lap.telemetry.length - 1].DistanceTraveled - lap.telemetry[0].DistanceTraveled
        : 1;
      const firstDist = lap.telemetry[0]?.DistanceTraveled ?? 0;
      const cornerFracs = corners.map((c) => ({
        label: c.label,
        startFrac: Math.max(0, (c.distanceStart - firstDist) / totalDist),
        endFrac: Math.min(1, (c.distanceEnd - firstDist) / totalDist),
      }));

      if (!regenerate) {
        const cached = await getAnalysis(id);
        if (cached) {
          return c.json({
            analysis: cached.analysis,
            cached: true,
            usage: {
              inputTokens: cached.inputTokens,
              outputTokens: cached.outputTokens,
              costUsd: cached.costUsd,
              durationMs: cached.durationMs,
              model: cached.model,
            },
            cornerFracs,
            hasTune: !!lap.tuneId,
          });
        }
        if (cacheOnly) {
          return c.json({ analysis: null, cached: false, cornerFracs, hasTune: !!lap.tuneId });
        }
      }
      const settings = loadSettings();

      let parsedTune: Tune | undefined;
      if (lap.tuneId) {
        const dbTune = await getDbTune(lap.tuneId);
        if (dbTune) {
          parsedTune = {
            ...dbTune,
            strengths: dbTune.strengths
              ? JSON.parse(dbTune.strengths)
              : [],
            weaknesses: dbTune.weaknesses
              ? JSON.parse(dbTune.weaknesses)
              : [],
            bestTracks: dbTune.bestTracks
              ? JSON.parse(dbTune.bestTracks)
              : [],
            strategies: dbTune.strategies
              ? JSON.parse(dbTune.strategies)
              : [],
            settings: JSON.parse(dbTune.settings),
          } as Tune;
        }
      }

      // Fetch track segments for the AI to use exact names
      let segments: { type: string; name: string; startFrac: number; endFrac: number }[] | undefined;
      try {
        const adapter = lap.gameId ? tryGetGame(lap.gameId) : null;
        const sharedName = adapter?.getSharedTrackName?.(lap.trackOrdinal ?? 0);
        if (sharedName) {
          const meta = loadSharedTrackMeta(sharedName);
          if (meta?.segments?.length) segments = meta.segments;
        }
      } catch { /* ignore */ }

      const prompt = buildAnalystPrompt(
        lap,
        lap.telemetry,
        corners,
        settings.unit,
        parsedTune,
        segments,
      );

      try {
        let result;
        if (settings.aiProvider === "openai") {
          const apiKey = await getSecret("openai-api-key");
          if (!apiKey) return c.json({ error: "OpenAI API key not set. Add it in Settings → AI Analysis." }, 400);
          result = await runOpenAi(prompt, apiKey, settings.aiModel || undefined);
        } else {
          // Default: Gemini (also handles "local" fallback)
          const apiKey = await getSecret("gemini-api-key");
          if (!apiKey) return c.json({ error: "Gemini API key not set. Add it in Settings → AI Analysis." }, 400);
          result = await runGemini(prompt, apiKey, settings.aiModel || undefined);
        }

        await saveAnalysis(id, result.analysis, result.usage);
        return c.json({ analysis: result.analysis, cached: false, usage: result.usage, cornerFracs, hasTune: !!parsedTune });
      } catch (err: any) {
        console.error("[AI] Analysis failed:", err.message);
        return c.json({ error: err.message }, err.message.includes("timed out") ? 504 : 500);
      }
    }
  )

  // ── Chat: get messages ───────────────────────────────────────
  .get(
    "/api/laps/:id/chat",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        const memory = getChatMemory();
        const threadId = chatThreadId(id);
        const thread = await memory.getThreadById({ threadId });
        if (!thread) return c.json({ messages: [] });
        const result = await memory.recall({ threadId });
        const raw = result.messages ?? [];
        const messages = raw
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => {
            const c = m.content as any;
            let content = "";
            if (typeof c === "string") {
              content = c;
            } else if (c && typeof c === "object") {
              // Mastra format: { format, parts: [{type, text}], content: "plain text" }
              content = c.content ?? c.parts?.map((p: any) => p.text ?? "").join("") ?? "";
            }
            return { role: m.role, content, createdAt: m.createdAt ?? "" };
          });
        return c.json({ messages });
      } catch (err: any) {
        console.error("[Chat] Failed to load messages:", err.message);
        return c.json({ messages: [] });
      }
    }
  )

  // ── Chat: send message (streaming) ─────────────────────────
  .post(
    "/api/laps/:id/chat",
    zValidator("param", IdParamSchema),
    zValidator("json", ChatBodySchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { message } = c.req.valid("json");

      const lap = await getLapById(id);
      if (!lap) return c.json({ error: "Lap not found" }, 404);
      if (lap.telemetry.length === 0)
        return c.json({ error: "No telemetry data" }, 400);

      const settings = loadSettings();
      const trackOrdinal = lap.trackOrdinal ?? 0;
      const corners = trackOrdinal > 0 && lap.gameId ? await getCorners(trackOrdinal, lap.gameId) : [];

      // Load tune if linked
      let parsedTune: Tune | undefined;
      if (lap.tuneId) {
        const dbTune = await getDbTune(lap.tuneId);
        if (dbTune) {
          parsedTune = {
            ...dbTune,
            strengths: dbTune.strengths ? JSON.parse(dbTune.strengths) : [],
            weaknesses: dbTune.weaknesses ? JSON.parse(dbTune.weaknesses) : [],
            bestTracks: dbTune.bestTracks ? JSON.parse(dbTune.bestTracks) : [],
            strategies: dbTune.strategies ? JSON.parse(dbTune.strategies) : [],
            settings: JSON.parse(dbTune.settings),
          } as Tune;
        }
      }

      // Load cached analysis for context
      const cached = await getAnalysis(id);
      const analysisJson = cached?.analysis;

      // Build chat prompt
      const systemPrompt = buildChatSystemPrompt(
        lap, lap.telemetry, corners, settings.unit, parsedTune, analysisJson
      );

      // Set up API key env vars for Mastra/AI SDK (uses chatProvider setting)
      const chatProvider = settings.chatProvider;
      if (chatProvider === "gemini") {
        const key = await getSecret("gemini-api-key");
        if (!key) return c.json({ error: "Gemini API key not set. Add it in Settings → AI Chat." }, 400);
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
      } else if (chatProvider === "openai") {
        const key = await getSecret("openai-api-key");
        if (!key) return c.json({ error: "OpenAI API key not set. Add it in Settings → AI Chat." }, 400);
        process.env.OPENAI_API_KEY = key;
      } else if (chatProvider === "local") {
        process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "local";
        process.env.OPENAI_BASE_URL = settings.localEndpoint || "http://localhost:1234/v1";
      }

      try {
        const threadId = chatThreadId(id);

        const stream = await lapChatAgent.stream(message, {
          instructions: systemPrompt,
          memory: {
            thread: threadId,
            resource: CHAT_RESOURCE_ID,
          },
        });

        // Pipe the text stream through a TextEncoder for the Response body
        const encoder = new TextEncoder();
        const readable = new ReadableStream({
          async start(controller) {
            try {
              for await (const chunk of stream.textStream) {
                controller.enqueue(encoder.encode(chunk));
              }
              controller.close();
            } catch (err) {
              controller.error(err);
            }
          },
        });

        return new Response(readable, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache",
            "Transfer-Encoding": "chunked",
          },
        });
      } catch (err: any) {
        console.error("[Chat] Stream failed:", err.message);
        return c.json({ error: err.message }, 500);
      }
    }
  )

  // ── Chat: clear messages ───────────────────────────────────
  .delete(
    "/api/laps/:id/chat",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        const memory = getChatMemory();
        const threadId = chatThreadId(id);
        await memory.deleteThread(threadId);
      } catch (err: any) {
        console.error("[Chat] Failed to clear thread:", err.message);
      }
      // Also clear cached analysis
      try {
        await deleteAnalysisQuery(id);
      } catch (err: any) {
        console.error("[Chat] Failed to clear analysis:", err.message);
      }
      return c.json({ ok: true });
    }
  )

  // ── Update lap notes ───────────────────────────────────────
  .patch(
    "/api/laps/:id/notes",
    zValidator("param", IdParamSchema),
    zValidator("json", z.object({ notes: z.string().nullable() })),
    async (c) => {
      const { id } = c.req.valid("param");
      await updateLapNotes(id, c.req.valid("json").notes);
      return c.json({ ok: true });
    }
  )

  // ── Recheck lap validity (dev tool) ─────────────────────────
  .post(
    "/api/laps/:id/recheck",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const lap = await getLapById(id);
      if (!lap) return c.json({ error: "Lap not found" }, 404);

      const quality = assessLapRecording(lap.telemetry, lap.lapTime);

      // Recompute sector times
      const packets = lap.telemetry;
      let sectors: { s1: number; s2: number; s3: number } | null = null;
      if (packets.length >= 50) {
        const startDist = packets[0].DistanceTraveled;
        const lapDist = packets[packets.length - 1].DistanceTraveled - startDist;
        if (lapDist >= 100) {
          const gameId = lap.gameId as GameId | undefined;
          let s1 = 0, s2 = 0;

          if (USE_NATIVE_ACC_SECTORS && gameId === "acc") {
            // Replay native sector transitions from stored packets (mirrors live tracker)
            let prevIdx = packets[0].acc?.currentSectorIndex ?? 0;
            for (const p of packets) {
              if (!p.acc) continue;
              const idx = p.acc.currentSectorIndex;
              const t = p.acc.lastSectorTime / 1000;
              if (idx !== prevIdx && t > 0) {
                if (prevIdx === 0) s1 = t;
                else if (prevIdx === 1) s2 = t;
                prevIdx = idx;
              }
            }
          }

          if (s1 === 0 || s2 === 0) {
            const dbSectors = gameId ? await getTrackOutlineSectors(lap.trackOrdinal!, gameId) : null;
            const raw = dbSectors ?? getTrackSectorsByOrdinal(lap.trackOrdinal!);
            const s1End = raw?.s1End ?? 1 / 3;
            const s2End = raw?.s2End ?? 2 / 3;

            let sector = 0, sectorStart = packets[0].CurrentLap;
            s1 = 0; s2 = 0;
            for (const p of packets) {
              const frac = (p.DistanceTraveled - startDist) / lapDist;
              const expected = frac < s1End ? 0 : frac < s2End ? 1 : 2;
              if (expected > sector) {
                const t = p.CurrentLap - sectorStart;
                if (sector === 0) s1 = t; else if (sector === 1) s2 = t;
                sectorStart = p.CurrentLap;
                sector = expected;
              }
            }
          }

          if (s1 > 0 && s2 > 0) {
            const s3 = lap.lapTime - s1 - s2;
            if (s3 > 0) sectors = { s1, s2, s3 };
          }
        }
      }

      await updateLapValidity(id, quality.valid, quality.valid ? null : quality.reason, sectors);
      return c.json({ id, valid: quality.valid, reason: quality.reason, sectors });
    }
  )

  // ── Delete single lap ───────────────────────────────────────
  .delete(
    "/api/laps/:id",
    zValidator("param", IdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const deleted = await deleteLap(id);
      if (!deleted) return c.json({ error: "Lap not found" }, 404);
      return c.json({ success: true });
    }
  )

  // ── Compare two laps ───────────────────────────────────────
  .get(
    "/api/laps/:id1/compare/:id2",
    zValidator("param", CompareParamsSchema),
    async (c) => {
      const { id1, id2 } = c.req.valid("param");
      if (id1 === id2)
        return c.json({ error: "Cannot compare a lap with itself" }, 400);

      const lapA = await getLapById(id1);
      if (!lapA) return c.json({ error: `Lap ${id1} not found` }, 404);

      const lapB = await getLapById(id2);
      if (!lapB) return c.json({ error: `Lap ${id2} not found` }, 404);

      if (lapA.telemetry.length === 0 || lapB.telemetry.length === 0)
        return c.json(
          { error: "One or both laps have no telemetry data" },
          400
        );

      const trackOrdinal = lapA.trackOrdinal ?? 0;
      let corners: Awaited<ReturnType<typeof getCorners>> = [];
      try {
        corners = lapA.gameId ? await getCorners(trackOrdinal, lapA.gameId) : [];
      } catch { /* corners optional */ }

      if (corners.length === 0 && trackOrdinal > 0) {
        const detected = detectCorners(lapA.telemetry);
        if (detected.length > 0 && lapA.gameId) {
          try {
            await saveCorners(trackOrdinal, detected, lapA.gameId, true);
            corners = detected;
          } catch {
            // Race / unique constraint — corners optional, fall back to in-memory only
            corners = detected;
          }
        }
      }

      const result = compareLaps(lapA.telemetry, lapB.telemetry, corners);

      return c.json({
        lapA: {
          lapNumber: lapA.lapNumber,
          lapTime: lapA.lapTime,
          isValid: lapA.isValid,
          trackOrdinal: lapA.trackOrdinal,
          carOrdinal: lapA.carOrdinal,
        },
        lapB: {
          lapNumber: lapB.lapNumber,
          lapTime: lapB.lapTime,
          isValid: lapB.isValid,
          trackOrdinal: lapB.trackOrdinal,
          carOrdinal: lapB.carOrdinal,
        },
        traces: {
          distance: result.distances,
          speedA: result.lapA.speed,
          speedB: result.lapB.speed,
          throttleA: result.lapA.throttle,
          throttleB: result.lapB.throttle,
          brakeA: result.lapA.brake,
          brakeB: result.lapB.brake,
          rpmA: result.lapA.rpm,
          rpmB: result.lapB.rpm,
          tireWearA: result.lapA.tireWear,
          tireWearB: result.lapB.tireWear,
        },
        timeDelta: result.timeDelta,
        corners: result.cornerDeltas,
        telemetryA: lapA.telemetry,
        telemetryB: lapB.telemetry,
        gameId: lapA.gameId,
      });
    }
  )

  // ── Inputs comparison analysis ─────────────────────────────
  .post(
    "/api/laps/:id1/compare/:id2/inputs-analyse",
    zValidator("param", CompareParamsSchema),
    zValidator("query", AnalyseQuerySchema),
    async (c) => {
      const { id1, id2 } = c.req.valid("param");
      const { regenerate, cacheOnly } = c.req.valid("query");
      if (id1 === id2)
        return c.json({ error: "Cannot compare a lap with itself" }, 400);

      // Cache lookup first
      if (!regenerate) {
        const cached = await getCompareAnalysis(id1, id2, "inputs");
        if (cached) {
          return c.json({
            analysis: cached.analysis,
            cached: true,
            usage: {
              inputTokens: cached.inputTokens,
              outputTokens: cached.outputTokens,
              costUsd: cached.costUsd,
              durationMs: cached.durationMs,
              model: cached.model,
            },
          });
        }
        if (cacheOnly) return c.json({ analysis: null, cached: false });
      }

      const lapA = await getLapById(id1);
      if (!lapA) return c.json({ error: `Lap ${id1} not found` }, 404);
      const lapB = await getLapById(id2);
      if (!lapB) return c.json({ error: `Lap ${id2} not found` }, 404);
      if (lapA.telemetry.length === 0 || lapB.telemetry.length === 0)
        return c.json({ error: "One or both laps have no telemetry data" }, 400);

      const trackOrdinal = lapA.trackOrdinal ?? 0;
      let corners: Awaited<ReturnType<typeof getCorners>> = [];
      try {
        corners = lapA.gameId ? await getCorners(trackOrdinal, lapA.gameId) : [];
      } catch { /* corners optional */ }

      const comparison = compareLaps(lapA.telemetry, lapB.telemetry, corners);

      const settings = loadSettings();

      // Fetch named track segments (corners + straights) for per-segment breakdown
      let segments: { name: string; type: "corner" | "straight"; startFrac: number; endFrac: number }[] | null = null;
      try {
        const adapter = lapA.gameId ? tryGetGame(lapA.gameId) : null;
        const sharedName = adapter?.getSharedTrackName?.(lapA.trackOrdinal ?? 0);
        if (sharedName) {
          const meta = loadSharedTrackMeta(sharedName);
          if (meta?.segments?.length) {
            segments = meta.segments.map((s: any) => ({
              name: s.name,
              type: (s.type === "corner" ? "corner" : "straight") as "corner" | "straight",
              startFrac: s.startFrac,
              endFrac: s.endFrac,
            }));
          }
        }
      } catch { /* segments optional */ }

      const prompt = buildInputsComparePrompt(
        {
          lapNumber: lapA.lapNumber,
          lapTime: lapA.lapTime,
          isValid: lapA.isValid,
          carOrdinal: lapA.carOrdinal ?? undefined,
          trackOrdinal: lapA.trackOrdinal ?? undefined,
          gameId: lapA.gameId as GameId | undefined,
        },
        {
          lapNumber: lapB.lapNumber,
          lapTime: lapB.lapTime,
          isValid: lapB.isValid,
          carOrdinal: lapB.carOrdinal ?? undefined,
          trackOrdinal: lapB.trackOrdinal ?? undefined,
          gameId: lapB.gameId as GameId | undefined,
        },
        comparison,
        segments,
        settings.unit,
      );

      // Set provider env vars before calling Mastra (the dynamic model resolver
      // reads settings at request time but env-based API keys must be in scope).
      if (settings.aiProvider === "openai") {
        const key = await getSecret("openai-api-key");
        if (!key) return c.json({ error: "OpenAI API key not set. Add it in Settings → AI Analysis." }, 400);
        process.env.OPENAI_API_KEY = key;
      } else if (settings.aiProvider === "local") {
        process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "local";
        process.env.OPENAI_BASE_URL = settings.localEndpoint || "http://localhost:1234/v1";
      } else {
        const key = await getSecret("gemini-api-key");
        if (!key) return c.json({ error: "Gemini API key not set. Add it in Settings → AI Analysis." }, 400);
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
      }

      try {
        const start = performance.now();
        const result = await compareEngineerAgent.generate(prompt, {
          structuredOutput: { schema: InputsCompareSchema },
        });
        const durationMs = Math.round(performance.now() - start);

        const object = (result as any).object;
        if (!object) throw new Error("Compare engineer returned no structured object");

        // Merge server-authoritative segment types into the model response so
        // named corners never appear as "straight". Match by name first; fall
        // back to positional order (both lists are emitted in the same order).
        if (Array.isArray(object.segments) && segments) {
          const byName = new Map(segments.map((s) => [s.name, s.type]));
          object.segments = object.segments.map((seg: any, i: number) => ({
            ...seg,
            type: byName.get(seg.name) ?? segments[i]?.type ?? "straight",
          }));
        }
        const analysisJson = JSON.stringify(object);
        const totalUsage = (result as any).totalUsage ?? (result as any).usage ?? {};
        const usage = {
          inputTokens: totalUsage.inputTokens ?? totalUsage.promptTokens ?? 0,
          outputTokens: totalUsage.outputTokens ?? totalUsage.completionTokens ?? 0,
          costUsd: 0,
          durationMs,
          model: settings.aiModel || settings.aiProvider,
        };
        await saveCompareAnalysis(id1, id2, analysisJson, usage, "inputs");
        return c.json({ analysis: analysisJson, cached: false, usage });
      } catch (err: any) {
        console.error("[InputsCompare] Failed:", err.message);
        return c.json({ error: err.message }, err.message.includes("timed out") ? 504 : 500);
      }
    }
  )

  // ── Inputs comparison: clear cached analysis ───────────────
  .delete(
    "/api/laps/:id1/compare/:id2/inputs-analyse",
    zValidator("param", CompareParamsSchema),
    async (c) => {
      const { id1, id2 } = c.req.valid("param");
      try {
        await deleteCompareAnalysis(id1, id2, "inputs");
      } catch (err: any) {
        console.error("[InputsCompare] Failed to clear:", err.message);
      }
      return c.json({ ok: true });
    }
  )

  // ── Compare chat: get messages ─────────────────────────────
  .get(
    "/api/laps/:id1/compare/:id2/chat",
    zValidator("param", CompareParamsSchema),
    async (c) => {
      const { id1, id2 } = c.req.valid("param");
      try {
        const memory = getChatMemory();
        const threadId = compareChatThreadId(id1, id2);
        const thread = await memory.getThreadById({ threadId });
        if (!thread) return c.json({ messages: [] });
        const result = await memory.recall({ threadId });
        const raw = result.messages ?? [];
        const messages = raw
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => {
            const c = m.content as any;
            let content = "";
            if (typeof c === "string") {
              content = c;
            } else if (c && typeof c === "object") {
              content = c.content ?? c.parts?.map((p: any) => p.text ?? "").join("") ?? "";
            }
            return { role: m.role, content, createdAt: m.createdAt ?? "" };
          });
        return c.json({ messages });
      } catch (err: any) {
        console.error("[CompareChat] Failed to load messages:", err.message);
        return c.json({ messages: [] });
      }
    }
  )

  // ── Compare chat: send message (streaming) ────────────────
  .post(
    "/api/laps/:id1/compare/:id2/chat",
    zValidator("param", CompareParamsSchema),
    zValidator("json", ChatBodySchema),
    async (c) => {
      const { id1, id2 } = c.req.valid("param");
      const { message } = c.req.valid("json");
      if (id1 === id2)
        return c.json({ error: "Cannot compare a lap with itself" }, 400);

      const lapA = await getLapById(id1);
      if (!lapA) return c.json({ error: `Lap ${id1} not found` }, 404);
      const lapB = await getLapById(id2);
      if (!lapB) return c.json({ error: `Lap ${id2} not found` }, 404);
      if (lapA.telemetry.length === 0 || lapB.telemetry.length === 0)
        return c.json({ error: "One or both laps have no telemetry data" }, 400);

      const cachedA = await getAnalysis(id1);
      const cachedB = await getAnalysis(id2);
      if (!cachedA || !cachedB) {
        return c.json(
          { error: "Both laps must be analysed before chatting. Run analysis on each lap first." },
          400,
        );
      }

      const trackOrdinal = lapA.trackOrdinal ?? 0;
      let corners: Awaited<ReturnType<typeof getCorners>> = [];
      try {
        corners = lapA.gameId ? await getCorners(trackOrdinal, lapA.gameId) : [];
      } catch { /* corners optional */ }

      const comparison = compareLaps(lapA.telemetry, lapB.telemetry, corners);

      const settings = loadSettings();
      const systemPrompt = buildCompareChatSystemPrompt(
        {
          id: id1,
          lapNumber: lapA.lapNumber,
          lapTime: lapA.lapTime,
          isValid: lapA.isValid,
          carOrdinal: lapA.carOrdinal ?? undefined,
          trackOrdinal: lapA.trackOrdinal ?? undefined,
          gameId: lapA.gameId as GameId | undefined,
        },
        {
          id: id2,
          lapNumber: lapB.lapNumber,
          lapTime: lapB.lapTime,
          isValid: lapB.isValid,
          carOrdinal: lapB.carOrdinal ?? undefined,
          trackOrdinal: lapB.trackOrdinal ?? undefined,
          gameId: lapB.gameId as GameId | undefined,
        },
        comparison,
        cachedA.analysis,
        cachedB.analysis,
        settings.unit,
      );

      const chatProvider = settings.chatProvider;
      if (chatProvider === "gemini") {
        const key = await getSecret("gemini-api-key");
        if (!key) return c.json({ error: "Gemini API key not set. Add it in Settings → AI Chat." }, 400);
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
      } else if (chatProvider === "openai") {
        const key = await getSecret("openai-api-key");
        if (!key) return c.json({ error: "OpenAI API key not set. Add it in Settings → AI Chat." }, 400);
        process.env.OPENAI_API_KEY = key;
      } else if (chatProvider === "local") {
        process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "local";
        process.env.OPENAI_BASE_URL = settings.localEndpoint || "http://localhost:1234/v1";
      }

      try {
        const threadId = compareChatThreadId(id1, id2);

        const stream = await compareChatAgent.stream(message, {
          instructions: systemPrompt,
          memory: { thread: threadId, resource: CHAT_RESOURCE_ID },
        });

        const encoder = new TextEncoder();
        const readable = new ReadableStream({
          async start(controller) {
            try {
              for await (const chunk of stream.textStream) {
                controller.enqueue(encoder.encode(chunk));
              }
              controller.close();
            } catch (err) {
              controller.error(err);
            }
          },
        });

        return new Response(readable, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache",
            "Transfer-Encoding": "chunked",
          },
        });
      } catch (err: any) {
        console.error("[CompareChat] Stream failed:", err.message);
        return c.json({ error: err.message }, 500);
      }
    }
  )

  // ── Compare chat: clear messages ───────────────────────────
  .delete(
    "/api/laps/:id1/compare/:id2/chat",
    zValidator("param", CompareParamsSchema),
    async (c) => {
      const { id1, id2 } = c.req.valid("param");
      try {
        const memory = getChatMemory();
        const threadId = compareChatThreadId(id1, id2);
        await memory.deleteThread(threadId);
      } catch (err: any) {
        console.error("[CompareChat] Failed to clear thread:", err.message);
      }
      return c.json({ ok: true });
    }
  )

  // ── Delete ALL laps ─────────────────────────────────────────
  .delete("/api/laps", async (c) => {
    const laps = await getLaps();
    let count = 0;
    for (const lap of laps) {
      if (await deleteLap(lap.id)) count++;
    }
    return c.json({ deleted: count });
  });
