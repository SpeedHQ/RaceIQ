import { MessageList } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

import { IdParamSchema } from "@shared/platform/http/route-schemas";
import { GameIdSchema, type GameId } from "../../../shared/games/ids";
import type { Tune } from "../../../shared/racing/tuning/types";
import { eligibilityDecisionText } from "../../../shared/racing/quality/display";
import { isEligibilityUsable, resolveEligibilityDecision } from "../../../shared/racing/quality/policies";
import { getLapById, getLapMetaById } from "../../db/lap-read-queries";
import { deleteAnalysis as deleteAnalysisQuery, getAnalysis, getLapQualityIdentity, lapFindingGenerationCacheKey } from "../../db/analysis-queries";
import { getCurrentFindingGeneration, type FindingGenerationExpectation } from "../../findings/store";
import { getTuneById as getDbTune } from "../../db/tune-queries";
import { resolveLapCorners } from "../../tracks/corner-resolution";
import { loadSettings } from "../../runtime/config/settings";
import { buildChatSystemPrompt } from "../../ai/chat-prompt";
import { buildGoogleReasoningProviderOptions } from "../../ai/google-provider-options";
import { streamAgentTurnResponse } from "../../ai/agent-stream";
import { lapChatAgent } from "../../ai/agents";
import {
  CHAT_RESOURCE_ID,
  chatThreadId,
  generationThreadId,
  getChatMemory,
  listThreadGenerations,
  resolveActiveThread,
} from "../../ai/chat-agent";
import { FINDING_RECEIPT_FENCE_CONTEXT_KEY } from "../../ai/chat-message-context";
import { getSecret } from "../../runtime/platform/keystore";
import { ChatBodySchema, ChatHistoryQuerySchema, FindingGenerationBackfilling } from "./support";
import { parseTuneRow } from "../tune-shared";

export const chatRoutes = new Hono()
  .get("/api/laps/:id/chat", zValidator("param", IdParamSchema), zValidator("query", ChatHistoryQuerySchema), async (c) => {
    const { id } = c.req.valid("param");
    const gameIdResult = GameIdSchema.safeParse(c.req.header("X-Game-Id"));
    if (!gameIdResult.success) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
    let base: string | null = null;
    try {
      const lap = await getLapMetaById(id);
      if (!lap || lap.gameId !== gameIdResult.data) return c.json({ error: "Lap not found" }, 404);
      const [identity, findingGeneration] = await Promise.all([
        getLapQualityIdentity(id),
        getCurrentFindingGeneration({
          kind: "lap",
          gameId: lap.gameId,
          sessionId: String(lap.sessionId),
          lapId: String(lap.id),
        }),
      ]);
      if (!identity) return c.json({ messages: [], threadId: null, status: "stale", retryable: true }, 409);
      if (!findingGeneration) return c.json({ messages: [], threadId: null, ...FindingGenerationBackfilling }, 409);
      const findingGenerationKey = lapFindingGenerationCacheKey(findingGeneration.receipt);
      base = chatThreadId(id, `${identity.policyVersion}:${identity.generation}:${findingGenerationKey}`);
      const memory = getChatMemory();
      const gen = c.req.valid("query").gen;
      const threadId = gen === undefined ? await resolveActiveThread(base) : generationThreadId(base, gen);
      const thread = await memory.getThreadById({ threadId });
      if (!thread) return c.json({ messages: [], threadId: gen === undefined ? base : threadId, status: gen === undefined ? "current" : "stale" });
      const result = await memory.recall({ threadId });
      const raw = result.messages ?? [];

      const list = new MessageList({ threadId, resourceId: CHAT_RESOURCE_ID });
      list.add(raw, "memory");
      const uiMessages = list.get.all.aiV5.ui().filter((message) => message.role === "user" || message.role === "assistant");

      return c.json({ messages: uiMessages, threadId: gen === undefined ? base : threadId, status: gen === undefined ? "current" : "stale" });
    } catch (err: any) {
      console.error("[Chat] Failed to load messages:", err.message);
      return c.json({ messages: [], threadId: base });
    }
  })

  .post("/api/laps/:id/chat", zValidator("param", IdParamSchema), zValidator("json", ChatBodySchema), async (c) => {
    const { id } = c.req.valid("param");
    const gameIdResult = GameIdSchema.safeParse(c.req.header("X-Game-Id"));
    if (!gameIdResult.success) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
    const { messages } = c.req.valid("json");

    const lap = await getLapById(id);
    if (!lap || lap.gameId !== gameIdResult.data) return c.json({ error: "Lap not found" }, 404);
    const gameId: GameId = gameIdResult.data;
    const decision = resolveEligibilityDecision(lap, "corner-trace");
    if (!isEligibilityUsable(decision)) {
      return c.json({ error: eligibilityDecisionText(decision), decision }, 422);
    }
    const identity = await getLapQualityIdentity(id);
    if (!identity) return c.json({ error: "Lap quality identity is unavailable." }, 422);
    if (lap.telemetry.length === 0) return c.json({ error: "No telemetry data" }, 400);
    const findingGeneration = await getCurrentFindingGeneration({
      kind: "lap",
      gameId,
      sessionId: String(lap.sessionId),
      lapId: String(lap.id),
    });
    if (!findingGeneration) {
      return c.json(FindingGenerationBackfilling, 409);
    }
    const findingGenerationKey = lapFindingGenerationCacheKey(findingGeneration.receipt);
    const expectedFindingGeneration = {
      scope: {
        kind: "lap",
        gameId,
        sessionId: String(lap.sessionId),
        lapId: String(lap.id),
      },
      generationId: findingGeneration.receipt.generationId,
      contentHash: findingGeneration.receipt.contentHash,
    } satisfies FindingGenerationExpectation;
    const validateReceiptFence = async () => {
      const current = await getCurrentFindingGeneration({
        kind: "lap",
        gameId,
        sessionId: String(lap.sessionId),
        lapId: String(lap.id),
      });
      return current !== null && lapFindingGenerationCacheKey(current.receipt) === findingGenerationKey;
    };
    if (!(await validateReceiptFence())) return c.json({ error: "Lap findings changed. Retry chat." }, 409);
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


    const settings = loadSettings();
    const trackOrdinal = lap.trackOrdinal ?? 0;
    // Official track segments first, then stored corners and telemetry detection,
    // so AI card jumps use the same turn labels as Analyse.
    const corners = await resolveLapCorners(trackOrdinal, gameId, lap.telemetry);

    // Load tune if linked
    let parsedTune: Tune | undefined;
    if (lap.tuneId) {
      const dbTune = await getDbTune(lap.tuneId);
      if (dbTune) {
        parsedTune = parseTuneRow(dbTune) as unknown as Tune;
      }
    }

    // Load cached analysis for context
    const cached = await getAnalysis(id, expectedFindingGeneration);
    const analysisJson = cached?.analysis;

    // Build chat prompt
    const systemPrompt = buildChatSystemPrompt(
      lap,
      lap.telemetry,
      corners,
      settings.unit,
      settings.temperatureUnit,
      parsedTune,
      analysisJson,
      settings.language,
      findingGeneration.findings,
    );

    // Provider/key/model plumbing — inlined from the old startChatStream
    // helper (removed, was the NDJSON transport's shared provider setup)
    // since this route now speaks the AI SDK v5 UI-message-stream
    // protocol instead).
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

    const chatModelLabel = settings.chatModel || (chatProvider === "openai" ? "gpt-4o-mini" : chatProvider === "local" ? "local-model" : "gemini-flash-latest");

    const threadId = await resolveActiveThread(chatThreadId(id, `${identity.policyVersion}:${identity.generation}:${findingGenerationKey}`));
    const turnStartedAt = Date.now();
    try {
      const stream = await lapChatAgent.stream([{ role: "system", content: systemPrompt }, ...messages], {
        memory: { thread: threadId, resource: CHAT_RESOURCE_ID },
        requestContext,
        abortSignal: c.req.raw.signal,
        providerOptions: {
          openai: { reasoningEffort: "medium" },
          google: buildGoogleReasoningProviderOptions(chatModelLabel, settings.chatThinkingBudget) as never,
        },
      });

      return streamAgentTurnResponse({
        validateReceiptFence,
        agentStream: stream,
        originalMessages: messages,
        memory: getChatMemory(),
        threadId,
        turnStartedAt,
        abortSignal: c.req.raw.signal,
      });
    } catch (err: any) {
      console.error("[Chat] Stream failed:", err.message);
      return c.json({ error: err.message }, 500);
    }
  })

  .delete("/api/laps/:id/chat", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const gameIdResult = GameIdSchema.safeParse(c.req.header("X-Game-Id"));
    if (!gameIdResult.success) return c.json({ error: "Missing or invalid X-Game-Id header" }, 400);
    try {
      const lap = await getLapMetaById(id);
      if (!lap || lap.gameId !== gameIdResult.data) return c.json({ error: "Lap not found" }, 404);
      const [identity, findingGeneration] = await Promise.all([
        getLapQualityIdentity(id),
        getCurrentFindingGeneration({
          kind: "lap",
          gameId: gameIdResult.data,
          sessionId: String(lap.sessionId),
          lapId: String(lap.id),
        }),
      ]);
      if (identity && findingGeneration) {
        const memory = getChatMemory();
        const findingGenerationKey = lapFindingGenerationCacheKey(findingGeneration.receipt);
        const base = chatThreadId(id, `${identity.policyVersion}:${identity.generation}:${findingGenerationKey}`);
        const gens = await listThreadGenerations(base);
        const ids = new Set(gens.map((generation) => generation.threadId));
        ids.add(base);
        for (const threadId of ids) {
          await memory.deleteThread(threadId);
        }
      }
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
  });
