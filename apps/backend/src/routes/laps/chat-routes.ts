import { RequestContext } from "@mastra/core/request-context";
import { MessageList } from "@mastra/core/agent";
import { zValidator } from "@hono/zod-validator";
import { Hono, type TypedResponse } from "hono";

import { z } from "zod";
import { IdParamSchema } from "@raceiq/shared/platform/http/route-schemas";
import { chatRequestHasImage, resolveChatVisionCapability } from "@raceiq/shared/integrations/ai/chat-vision";
import type { Tune } from "@raceiq/shared/racing/tuning/types";
import { getLapById } from "@raceiq/backend-core/db/lap-read-queries";
import { getTuneById as getDbTune } from "@raceiq/backend-core/db/tune-queries";
import { getAnalysis } from "@raceiq/backend-core/db/analysis-queries";
import { sanitizeAnalystOutput } from "@raceiq/backend-core/ai/schemas";
import { setupContextForLap } from "../../ai/lap-setup-context";
import { resolveLapCorners } from "../../tracks/corner-resolution";
import { loadSettings } from "@raceiq/backend-core/runtime/config/settings";
import { buildChatSystemPrompt } from "@raceiq/backend-core/ai/chat-prompt";
import { buildGoogleReasoningProviderOptions } from "@raceiq/backend-core/ai/google-provider-options";
import { streamAgentTurnResponse } from "@raceiq/backend-core/ai/agent-stream";
import { lapChatAgent } from "../../ai/agents";
import {
  CHAT_RESOURCE_ID,
  chatThreadId,
  generationThreadId,
  getChatMemory,
  ensureSystemPrompt,
  listThreadGenerations,
  resolveActiveThread,
} from "@raceiq/backend-core/ai/chat-agent";
import { configureAiProviderEnvironment } from "@raceiq/backend-core/ai/openai-compatible-provider";
import { CHAT_TURN_CONTEXT_KEY, CHAT_TURN_MESSAGES_KEY } from "@raceiq/backend-core/ai/chat-message-context";
import { ChatBodySchema } from "./support";
import { parseTuneRow } from "../tune-shared";

const ChatMessageParamsSchema = IdParamSchema.extend({
  messageId: z.string().min(1).max(256).regex(/^\S+$/),
});
type LapChatAgentStreamBoundary = {
  stream: (
    messages: unknown[],
    options: {
      requestContext: RequestContext;
      memory: { thread: string; resource: string };
      providerOptions: Record<string, unknown>;
    },
  ) => Promise<unknown>;
};

type ChatRouteOverrides = Partial<{
  getLapById: typeof getLapById;
  getAnalysis: typeof getAnalysis;
  loadSettings: typeof loadSettings;
  resolveLapCorners: typeof resolveLapCorners;
  buildChatSystemPrompt: typeof buildChatSystemPrompt;
  streamAgentTurnResponse: typeof streamAgentTurnResponse;
  lapChatAgent: LapChatAgentStreamBoundary;
  resolveActiveThread: typeof resolveActiveThread;
  ensureSystemPrompt: typeof ensureSystemPrompt;
  getChatMemory: typeof getChatMemory;
  configureAiProviderEnvironment: typeof configureAiProviderEnvironment;
}>;

export function createChatRoutes(overrides: ChatRouteOverrides = {}) {
  const loadLap = overrides.getLapById ?? getLapById;
  const loadAnalysis = overrides.getAnalysis ?? getAnalysis;
  const settingsLoader = overrides.loadSettings ?? loadSettings;
  const resolveCorners = overrides.resolveLapCorners ?? resolveLapCorners;
  const promptBuilder = overrides.buildChatSystemPrompt ?? buildChatSystemPrompt;
  const streamResponse = overrides.streamAgentTurnResponse ?? streamAgentTurnResponse;
  const agent: LapChatAgentStreamBoundary = overrides.lapChatAgent ?? (lapChatAgent as unknown as LapChatAgentStreamBoundary);
  const activeThread = overrides.resolveActiveThread ?? resolveActiveThread;
  const saveSystemPrompt = overrides.ensureSystemPrompt ?? ensureSystemPrompt;
  const memoryProvider = overrides.getChatMemory ?? getChatMemory;
  const configureProvider = overrides.configureAiProviderEnvironment ?? configureAiProviderEnvironment;
  return new Hono()
    .get("/api/laps/:id/chat", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
      try {
      const memory = memoryProvider();
      const base = chatThreadId(id);
      const genParam = Number(c.req.query("gen"));
      const threadId = Number.isInteger(genParam) && genParam >= 1
        ? generationThreadId(base, genParam)
        : await activeThread(base);
      const thread = await memory.getThreadById({ threadId });
      if (!thread) return c.json({ messages: [] });
      const result = await memory.recall({ threadId });
      const raw = result.messages ?? [];

      const list = new MessageList({ threadId, resourceId: CHAT_RESOURCE_ID });
      list.add(raw, "memory");
      // Keep provider-specific part generics out of Hono's serialized response type.
      const uiMessages: Array<{ id: string; role: "system" | "user" | "assistant"; parts: unknown[] }> = list.get.all.aiV5
        .ui()
        .filter((m) => m.role === "user" || m.role === "assistant");

      return c.newResponse(JSON.stringify({ messages: uiMessages }), 200, { "Content-Type": "application/json" }) as Response & TypedResponse<{ messages: typeof uiMessages }, 200>;
    } catch (err: any) {
      console.error("[Chat] Failed to load messages:", err.message);
      return c.json({ messages: [] });
    }
  })

  .post("/api/laps/:id/chat", zValidator("param", IdParamSchema), zValidator("json", ChatBodySchema), async (c) => {
    const { id } = c.req.valid("param");
    const { messages } = c.req.valid("json");

    const lap = await loadLap(id);
    if (!lap) return c.json({ error: "Lap not found" }, 404);
    if (lap.telemetry.length === 0) return c.json({ error: "No telemetry data" }, 400);

    const settings = settingsLoader();
    const trackIdentity = lap.trackId;
    // Official track segments first, then stored corners and telemetry detection,
    // so AI card jumps use the same turn labels as Analyse.
    const corners = await resolveCorners(trackIdentity, lap.gameId, lap.telemetry);

    // Load tune if linked
    let parsedTune: Tune | undefined;
    let linkedTune: { id: number; gameId: string; carId: string; trackId: string | null; settings: unknown } | undefined;
    if (lap.tuneId) {
      const dbTune = await getDbTune(lap.tuneId);
      if (dbTune && dbTune.gameId === lap.gameId && dbTune.carId === lap.carId &&
        (dbTune.trackId == null || dbTune.trackId === lap.trackId)) {
        try {
          const candidate = parseTuneRow(dbTune);
          if (candidate.settings && typeof candidate.settings === "object" && !Array.isArray(candidate.settings)) {
            parsedTune = candidate as unknown as Tune;
            linkedTune = {
              id: dbTune.id,
              gameId: dbTune.gameId,
              carId: dbTune.carId,
              trackId: dbTune.trackId,
              settings: candidate.settings,
            };
          }
        } catch (error) {
          // An unreadable stored setup is unavailable, not a reason to fail text chat.
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
    }

    const setupContext = setupContextForLap({
      id: Number(id),
      gameId: lap.gameId,
      carId: lap.carId,
      trackId: lap.trackId,
      carSetup: lap.carSetup,
      telemetry: lap.telemetry,
    }, undefined, linkedTune);
    const cached = await loadAnalysis(id);
    let analysisJson = cached?.analysis;
    if (analysisJson) {
      const sanitized = sanitizeAnalystOutput(analysisJson, setupContext, { requireMatchingProvenance: true });
      analysisJson = sanitized.success ? JSON.stringify(sanitized.data) : undefined;
    }
    // Build chat prompt
    const systemPrompt = promptBuilder(lap, lap.telemetry, corners, settings.unit, settings.temperatureUnit, parsedTune, analysisJson, settings.language);
    // Provider/key/model plumbing — inlined from the old startChatStream
    // helper (removed, was the NDJSON transport's shared provider setup)
    // since this route now speaks the AI SDK v5 UI-message-stream
    // protocol instead).
    const chatProvider = settings.chatProvider;
    if (!chatProvider) {
      return c.json({ error: "No AI provider selected. Choose one in Settings → AI Chat." }, 400);
    }
    const chatModelLabel = settings.chatModel
      || (chatProvider === "openai" ? "gpt-4o-mini" : chatProvider === "openai-compatible" ? "local-model" : "gemini-flash-latest");

    const visionCapability = resolveChatVisionCapability(chatProvider, chatModelLabel);
    if (chatRequestHasImage(messages) && visionCapability !== "supported") {
      const error = visionCapability === "unsupported"
        ? "This chat model does not support images. Remove the image or choose a verified image-capable chat model."
        : "Image support for this chat model is unknown. Remove the image or choose a verified image-capable chat model.";
      return c.json({ error }, 400);
    }
    await configureProvider(chatProvider, settings.localEndpoint || "http://localhost:1234/v1");
    const threadId = await activeThread(chatThreadId(id));
    await saveSystemPrompt(threadId, systemPrompt);
    const turnStartedAt = Date.now();
    try {
      const requestContext = new RequestContext();
      requestContext.set(CHAT_TURN_CONTEXT_KEY, systemPrompt);
      requestContext.set(CHAT_TURN_MESSAGES_KEY, messages);
      const stream = await agent.stream(
        messages,
        {
          requestContext,
          memory: { thread: threadId, resource: CHAT_RESOURCE_ID },
          providerOptions: {
            openai: { reasoningEffort: "medium" },
            google: buildGoogleReasoningProviderOptions(chatModelLabel, settings.chatThinkingBudget) as never,
          },
        },
      );

      return streamResponse({
        agentStream: stream as never,
        originalMessages: messages,
        memory: memoryProvider(),
        threadId,
        turnStartedAt,
        diagnostic: {
          provider: chatProvider,
          model: chatModelLabel,
          operation: "chat.stream",
          threadId,
          request: { systemPrompt, messages },
        },
      });
    } catch (err: unknown) {
      console.error("[Chat] Stream failed:", err instanceof Error ? err.message : "Unknown provider error");
      return c.json({ error: "Chat request failed. Check provider settings and retry." }, 500);
    }
  })

  .delete("/api/laps/:id/chat/messages/:messageId", zValidator("param", ChatMessageParamsSchema), async (c) => {
    const { id, messageId } = c.req.valid("param");
    try {
      if (!await loadLap(id)) return c.json({ error: "Lap not found" }, 404);
      const memory = memoryProvider();
      const base = chatThreadId(id);
      const generations = await listThreadGenerations(base);
      const threadIds = new Set(generations.map(({ threadId }) => threadId));
      threadIds.add(base);
      for (const threadId of threadIds) {
        const { messages } = await memory.recall({ threadId });
        const userTurn = (messages ?? []).find((item: unknown) =>
          item && typeof item === "object" && "id" in item && item.id === messageId && "role" in item && item.role === "user",
        );
        if (userTurn) {
          await memory.deleteMessages([messageId]);
          break;
        }
      }
      // Non-persisted failed turns are valid delete targets: local UI removal
      // must not depend on the first provider request having reached memory.
      return c.json({ ok: true });
    } catch (error) {
      console.error("[Chat] Failed to remove submitted turn:", error instanceof Error ? error.message : "Unknown memory error");
      return c.json({ error: "Could not remove this message. Retry, or clear chat history." }, 500);
    }
  })

  .delete("/api/laps/:id/chat", zValidator("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    try {
      const memory = memoryProvider();
      const base = chatThreadId(id);
      const gens = await listThreadGenerations(base);
      const ids = new Set(gens.map((g) => g.threadId));
      ids.add(base);
      for (const threadId of ids) {
        await memory.deleteThread(threadId);
      }
    } catch (error: unknown) {
      console.error("[Chat] Failed to clear thread:", error instanceof Error ? error.message : "Unknown memory error");
      return c.json({ error: "Could not clear chat history. Retry." }, 500);
    }
    return c.json({ ok: true });
  });
}

export const chatRoutes = createChatRoutes();
