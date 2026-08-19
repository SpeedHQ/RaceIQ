import { MessageList } from "@mastra/core/agent";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

import type { GameId } from "../../../shared/games/ids";
import { queryLapTelemetryBySemanticId } from "../../telemetry/replay";
import { getLapById } from "../../db/lap-read-queries";
import { deleteCompareAnalysis, getAnalysis, getCompareAnalysis, saveCompareAnalysis } from "../../db/analysis-queries";
import { compareLaps } from "../../lap-analysis/comparison";
import { loadSettings } from "../../runtime/config/settings";
import { resolveLapCorners, resolveLapSegments } from "../../tracks/corner-resolution";
import { buildCompareInsightsBlock } from "../../ai/insight-format";
import { buildCompareChatSystemPrompt } from "../../ai/compare-chat-prompt";
import { buildInputsComparePrompt, InputsCompareSchema, type PromptSegment } from "../../ai/inputs-compare-prompt";
import { compareChatAgent, compareEngineerAgent } from "../../ai/agents";
import { buildGoogleReasoningProviderOptions, buildGoogleThinkingProviderOptions } from "../../ai/google-provider-options";
import { beginAnalysisRun, finishAnalysisRun, getAnalysisRun } from "../../ai/analysis-run-registry";
import { streamAgentTurnResponse } from "../../ai/agent-stream";
import {
  CHAT_RESOURCE_ID,
  compareChatThreadId,
  generationThreadId,
  getChatMemory,
  listThreadGenerations,
  resolveActiveThread,
} from "../../ai/chat-agent";
import { getSecret } from "../../runtime/platform/keystore";
import { AnalyseQuerySchema, ChatBodySchema, CompareParamsSchema } from "./support";
const inputsAnalysisRunKey = (idA: number, idB: number) =>
  `inputs:${Math.min(idA, idB)}:${Math.max(idA, idB)}`;


export const comparisonRoutes = new Hono()
  .get("/api/laps/:id1/compare/:id2", zValidator("param", CompareParamsSchema), async (c) => {
    const { id1, id2 } = c.req.valid("param");
    if (id1 === id2) return c.json({ error: "Cannot compare a lap with itself" }, 400);

    const lapA = await getLapById(id1);
    if (!lapA) return c.json({ error: `Lap ${id1} not found` }, 404);

    const lapB = await getLapById(id2);
    if (!lapB) return c.json({ error: `Lap ${id2} not found` }, 404);

    if (lapA.telemetry.length === 0 || lapB.telemetry.length === 0) return c.json({ error: "One or both laps have no telemetry data" }, 400);

    const trackOrdinal = lapA.trackOrdinal ?? 0;
    const corners = await resolveLapCorners(trackOrdinal, lapA.gameId, lapA.telemetry, {
      saveDetected: true,
    });
    const result = compareLaps(lapA.telemetry, lapB.telemetry, corners);
    const semanticIds = [
      "motion.position-x",
      "motion.position-z",
      "motion.yaw",
      "motion.speed",
      "inputs.throttle",
      "inputs.brake",
      "engine.current-engine-rpm",
      "tires.tire-wear",
      "timing.distance-traveled",
      "timing.current-lap",
    ] as const;
    const [replayA, replayB] = await Promise.all([
      queryLapTelemetryBySemanticId(id1, semanticIds),
      queryLapTelemetryBySemanticId(id2, semanticIds),
    ]);
    if (!replayA || !replayB || replayA.envelopes.length === 0 || replayB.envelopes.length === 0) {
      return c.json({ error: "One or both laps have no semantic telemetry data" }, 400);
    }
    const toSamples = (replay: typeof replayA) =>
      replay.envelopes.map((envelope) => ({
        sequence: envelope.sequence.toString(),
        observedAtMs: envelope.observedAt.domain === "monotonic" ? Number(envelope.observedAt.nanoseconds) / 1_000_000 : envelope.observedAt.milliseconds,
        values: Object.fromEntries(envelope.values.filter((entry) => entry.state === "ok").map((entry) => [entry.semanticId, entry.value])),
      }));

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
      telemetryA: toSamples(replayA),
      telemetryB: toSamples(replayB),
      gameId: lapA.gameId,
    });
  })

  .get("/api/laps/:id1/compare/:id2/inputs-analyse/status", zValidator("param", CompareParamsSchema), (c) => {
    const { id1, id2 } = c.req.valid("param");
    return c.json(getAnalysisRun(inputsAnalysisRunKey(id1, id2)) ?? { status: "none" });
  })
  .post("/api/laps/:id1/compare/:id2/inputs-analyse", zValidator("param", CompareParamsSchema), zValidator("query", AnalyseQuerySchema), async (c) => {
    const { id1, id2 } = c.req.valid("param");
    const { regenerate, cacheOnly } = c.req.valid("query");
    if (id1 === id2) return c.json({ error: "Cannot compare a lap with itself" }, 400);

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
    if (lapA.telemetry.length === 0 || lapB.telemetry.length === 0) return c.json({ error: "One or both laps have no telemetry data" }, 400);

    const trackOrdinal = lapA.trackOrdinal ?? 0;
    const trackSegments = await resolveLapSegments(trackOrdinal, lapA.gameId);
    const corners = await resolveLapCorners(trackOrdinal, lapA.gameId, lapA.telemetry, {
      segments: trackSegments,
    });

    const comparison = compareLaps(lapA.telemetry, lapB.telemetry, corners);

    const settings = loadSettings();

    // Named track segments (corners + straights) for the per-segment breakdown.
    // Game-specific, and carrying the official turn numbers so the breakdown
    // names corners the same way the map and the track guide do.
    const segments: PromptSegment[] | null =
      trackSegments.map((s) => ({
        name: s.name,
        type: s.type === "corner" ? ("corner" as const) : ("straight" as const),
        startFrac: s.startFrac,
        endFrac: s.endFrac,
        number: s.number,
        covers: s.covers,
        group: s.group,
        direction: s.direction,
      })) ?? null;

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
      undefined,
      buildCompareInsightsBlock("Lap A", lapA.telemetry, lapA.gameId as GameId | undefined) +
        buildCompareInsightsBlock("Lap B", lapB.telemetry, lapB.gameId as GameId | undefined),
    );

    // Set provider env vars before calling Mastra (the dynamic model resolver
    // reads settings at request time but env-based API keys must be in scope).
    if (!settings.aiProvider) {
      return c.json({ error: "No AI provider selected. Choose one in Settings → AI Analysis." }, 400);
    }
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
    const inputsRunKey = inputsAnalysisRunKey(id1, id2);
    if (!beginAnalysisRun(inputsRunKey)) {
      return c.json({ error: "Inputs comparison already in progress" }, 409);
    }

    try {
      const start = performance.now();
      const result = await compareEngineerAgent.generate(prompt, {
        structuredOutput: {
          schema: InputsCompareSchema,
          // LM Studio only accepts `response_format: json_schema` (it rejects
          // json_object), and for reasoning models such as qwen3.5 it emits the
          // schema-constrained JSON into `reasoning_content` while leaving
          // `content` empty — so no object is ever parsed and this route throws.
          // Prompt injection keeps the answer on the plain-text channel, which
          // those models fill normally. Hosted providers parse native structured
          // output fine, so only the local path opts in.
          ...(settings.aiProvider === "local" ? { jsonPromptInjection: true } : {}),
        },
        // Every other AI route already caps output and disables reasoning on
        // local models (analyse, lap chat, compare chat). This one did not, so
        // a thinking model such as qwen3.5 could reason unboundedly and push the
        // request past Bun.serve's 255s idleTimeout — surfacing to the client as
        // a bare "socket hang up" from the Vite proxy.
        modelSettings: { maxOutputTokens: 8192, temperature: 0 },
        providerOptions: {
          openai: { reasoningEffort: "medium" },
          google: buildGoogleThinkingProviderOptions(
            settings.aiModel || "gemini-flash-latest",
            settings.aiThinkingBudget,
          ) as never,
        },
      });
      const durationMs = Math.round(performance.now() - start);

      const object = (result as any).object;
      if (!object) {
        throw new Error(
          settings.aiProvider === "local"
            ? `Model "${settings.aiModel}" returned no output matching the expected structure. Some local models do not reliably emit structured JSON — try another model in Settings → AI Analysis.`
            : "Compare engineer returned no structured object",
        );
      }

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
    } finally {
      finishAnalysisRun(inputsRunKey);
    }
  })

  .delete("/api/laps/:id1/compare/:id2/inputs-analyse", zValidator("param", CompareParamsSchema), async (c) => {
    const { id1, id2 } = c.req.valid("param");
    try {
      await deleteCompareAnalysis(id1, id2, "inputs");
    } catch (err: any) {
      console.error("[InputsCompare] Failed to clear:", err.message);
    }
    return c.json({ ok: true });
  })

  .get("/api/laps/:id1/compare/:id2/chat", zValidator("param", CompareParamsSchema), async (c) => {
    const { id1, id2 } = c.req.valid("param");
    try {
      const memory = getChatMemory();
      const base = compareChatThreadId(id1, id2);
      const genParam = Number(c.req.query("gen"));
      const threadId = Number.isInteger(genParam) && genParam >= 1
        ? generationThreadId(base, genParam)
        : await resolveActiveThread(base);
      const thread = await memory.getThreadById({ threadId });
      if (!thread) return c.json({ messages: [] });
      const result = await memory.recall({ threadId });
      const raw = result.messages ?? [];

      const list = new MessageList({ threadId, resourceId: CHAT_RESOURCE_ID });
      list.add(raw, "memory");
      const uiMessages = list.get.all.aiV5
        .ui()
        .filter((m) => m.role === "user" || m.role === "assistant");

      return c.json({ messages: uiMessages });
    } catch (err: any) {
      console.error("[CompareChat] Failed to load messages:", err.message);
      return c.json({ messages: [] });
    }
  })

  .post("/api/laps/:id1/compare/:id2/chat", zValidator("param", CompareParamsSchema), zValidator("json", ChatBodySchema), async (c) => {
    const { id1, id2 } = c.req.valid("param");
    const { messages } = c.req.valid("json");
    if (id1 === id2) return c.json({ error: "Cannot compare a lap with itself" }, 400);

    const lapA = await getLapById(id1);
    if (!lapA) return c.json({ error: `Lap ${id1} not found` }, 404);
    const lapB = await getLapById(id2);
    if (!lapB) return c.json({ error: `Lap ${id2} not found` }, 404);
    if (lapA.telemetry.length === 0 || lapB.telemetry.length === 0) return c.json({ error: "One or both laps have no telemetry data" }, 400);

    const cachedA = await getAnalysis(id1);
    const cachedB = await getAnalysis(id2);
    if (!cachedA || !cachedB) {
      return c.json({ error: "Both laps must be analysed before chatting. Run analysis on each lap first." }, 400);
    }

    const trackOrdinal = lapA.trackOrdinal ?? 0;
    const corners = await resolveLapCorners(trackOrdinal, lapA.gameId, lapA.telemetry);

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
      settings.temperatureUnit,
      settings.language,
      buildCompareInsightsBlock("Lap A", lapA.telemetry, lapA.gameId as GameId | undefined) +
        buildCompareInsightsBlock("Lap B", lapB.telemetry, lapB.gameId as GameId | undefined),
    );

    const chatProvider = settings.chatProvider;
    if (!chatProvider) {
      return c.json({ error: "No AI provider selected. Choose one in Settings → AI Chat." }, 400);
    }
    if (chatProvider === "gemini") {
      const key = await getSecret("gemini-api-key");
      if (!key) return c.json({ error: "Gemini API key not set. Add it in Settings → AI Chat." }, 400);
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
      delete process.env.OPENAI_BASE_URL;
    } else if (chatProvider === "openai") {
      const key = await getSecret("openai-api-key");
      if (!key) return c.json({ error: "OpenAI API key not set. Add it in Settings → AI Chat." }, 400);
      process.env.OPENAI_API_KEY = key;
      delete process.env.OPENAI_BASE_URL;
    } else if (chatProvider === "local") {
      process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "local";
      process.env.OPENAI_BASE_URL = settings.localEndpoint || "http://localhost:1234/v1";
    }

    const chatModelLabel = settings.chatModel
      || (chatProvider === "openai"
        ? "gpt-4o-mini"
        : chatProvider === "local"
          ? "local-model"
          : "gemini-flash-latest");

    const threadId = await resolveActiveThread(compareChatThreadId(id1, id2));
    const turnStartedAt = Date.now();
    try {
      const stream = await compareChatAgent.stream(
        [{ role: "system", content: systemPrompt }, ...messages],
        {
          memory: { thread: threadId, resource: CHAT_RESOURCE_ID },
          providerOptions: {
            openai: { reasoningEffort: "medium" },
            google: buildGoogleReasoningProviderOptions(chatModelLabel, settings.chatThinkingBudget) as never,
          },
        },
      );

      return streamAgentTurnResponse({
        agentStream: stream,
        originalMessages: messages,
        memory: getChatMemory(),
        threadId,
        turnStartedAt,
      });
    } catch (err: any) {
      console.error("[CompareChat] Stream failed:", err.message);
      return c.json({ error: err.message }, 500);
    }
  })

  .delete("/api/laps/:id1/compare/:id2/chat", zValidator("param", CompareParamsSchema), async (c) => {
    const { id1, id2 } = c.req.valid("param");
    try {
      const memory = getChatMemory();
      const base = compareChatThreadId(id1, id2);
      const gens = await listThreadGenerations(base);
      const ids = new Set(gens.map((g) => g.threadId));
      ids.add(base);
      for (const threadId of ids) {
        await memory.deleteThread(threadId);
      }
    } catch (err: any) {
      console.error("[CompareChat] Failed to clear thread:", err.message);
    }
    return c.json({ ok: true });
  });
