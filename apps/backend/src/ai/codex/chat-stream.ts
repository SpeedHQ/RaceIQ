import { createUIMessageStream, type UIMessageChunk } from "ai";
import { logLlmEvent } from "@raceiq/backend-core/ai/diagnostic-logging";
import { finishRun, pushChunk, type ChatRun } from "@raceiq/backend-core/ai/chat-run-registry";
import { CHAT_RESOURCE_ID } from "@raceiq/backend-core/ai/chat-agent";

type ChatMessage = { id?: string; role?: string; parts?: unknown[]; content?: unknown };
type ChatMemory = {
  saveMessages(args: { messages: unknown[] }): Promise<unknown>;
};
type CodexTurnResult = {
  text: string;
  model: string;
  runtimeVersion: string;
  latencyMs: number;
  firstContentMs: number | null;
  budget: { requestedOutputTokens: number | null; effectiveOutputTokens: number | null; supported: boolean };
  usage: {
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
    reasoningOutputTokens: number | null;
    costUsd: null;
  };
};

export type CodexChatStreamOptions = {
  run: ChatRun;
  originalMessages: unknown[];
  memory: ChatMemory;
  threadId: string;
  generate(onTextDelta: (delta: string) => void, signal: AbortSignal): Promise<CodexTurnResult>;
  operation: string;
};

function latestUserMessage(messages: unknown[]): { id: string; text: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as ChatMessage;
    if (message?.role !== "user") continue;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const text = parts
      .filter((part): part is { type: string; text?: string } => !!part && typeof part === "object" && "type" in part)
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("");
    if (message.id && text.trim()) return { id: message.id, text };
  }
  return null;
}

async function persistIncomingUserMessage(memory: ChatMemory, threadId: string, messages: unknown[]): Promise<void> {
  const user = latestUserMessage(messages);
  if (!user) throw new Error("Codex chat requires a non-empty user text message.");
  await memory.saveMessages({
    messages: [{
      id: user.id,
      role: "user",
      createdAt: new Date(),
      threadId,
      resourceId: CHAT_RESOURCE_ID,
      type: "text",
      content: { format: 2, parts: [{ type: "text", text: user.text }], content: user.text },
    }],
  });
}

function usageFor(result: CodexTurnResult) {
  const { inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens } = result.usage;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens == null || outputTokens == null ? null : inputTokens + outputTokens,
    cachedInputTokens,
    reasoningTokens: reasoningOutputTokens,
  };
}

/**
 * Execute Codex independently of any subscriber and buffer its UI-message
 * chunks for reconnect. User and completed assistant turns use existing
 * Mastra memory/thread IDs, so history/export/delete remain canonical.
 */
export async function startDetachedCodexTurn(options: CodexChatStreamOptions): Promise<void> {
  await persistIncomingUserMessage(options.memory, options.threadId, options.originalMessages);
  let completed = false;
  let persistedUsage: ReturnType<typeof usageFor> | undefined;
  let persistedDiagnostics: Omit<CodexTurnResult, "text" | "usage"> | undefined;
  const uiStream = createUIMessageStream({
    originalMessages: options.originalMessages as never,
    onFinish: async ({ responseMessage }) => {
      if (!completed) return;
      const parts = Array.isArray(responseMessage.parts) ? responseMessage.parts : [];
      if (!parts.length) return;
      const text = parts
        .filter((part) => part.type === "text")
        .map((part) => part.type === "text" ? part.text : "")
        .join("");
      await options.memory.saveMessages({
        messages: [{
          id: responseMessage.id,
          role: "assistant",
          createdAt: new Date(),
          threadId: options.threadId,
          resourceId: CHAT_RESOURCE_ID,
          type: "text",
          content: {
            format: 2,
            parts,
            content: text,
            metadata: { usage: persistedUsage, codex: persistedDiagnostics },
          },
        }],
      });
      logLlmEvent("llm-response", {
        provider: "codex",
        model: persistedDiagnostics?.model ?? "unknown",
        operation: options.operation,
        threadId: options.threadId,
        response: { status: "completed", ...persistedDiagnostics, usage: persistedUsage },
      });
    },
    execute: async ({ writer }) => {
      const messageId = crypto.randomUUID();
      const textPartId = crypto.randomUUID();
      let deltaWrites = Promise.resolve();
      logLlmEvent("llm-request", {
        provider: "codex",
        model: "configured",
        operation: options.operation,
        threadId: options.threadId,
      });
      await writer.write({ type: "start", messageId } as UIMessageChunk);
      await writer.write({ type: "text-start", id: textPartId } as UIMessageChunk);
      try {
        const result = await options.generate((delta) => {
          deltaWrites = deltaWrites.then(() => writer.write({ type: "text-delta", id: textPartId, delta } as UIMessageChunk));
        }, options.run.abortController.signal);
        await deltaWrites;
        completed = true;
        persistedUsage = usageFor(result);
        persistedDiagnostics = {
          model: result.model,
          runtimeVersion: result.runtimeVersion,
          latencyMs: result.latencyMs,
          firstContentMs: result.firstContentMs,
          budget: result.budget,
        };
        await writer.write({
          type: "message-metadata",
          messageMetadata: {
            usage: persistedUsage,
            codex: persistedDiagnostics,
          },
        } as UIMessageChunk);
        await writer.write({ type: "text-end", id: textPartId } as UIMessageChunk);
        await writer.write({ type: "finish", finishReason: "stop" } as UIMessageChunk);
      } catch (error) {
        await deltaWrites.catch(() => {});
        logLlmEvent("llm-error", {
          provider: "codex",
          model: persistedDiagnostics?.model ?? "configured",
          operation: options.operation,
          threadId: options.threadId,
          error,
        });
        if (options.run.abortController.signal.aborted) {
          await writer.write({ type: "abort" } as UIMessageChunk);
        } else {
          await writer.write({ type: "error", errorText: error instanceof Error ? error.message : "Codex chat failed." } as UIMessageChunk);
        }
      }
    },
  });
  const reader = uiStream.getReader();
  void (async () => {
    try {
      while (true) {
        if (options.run.abortController.signal.aborted) {
          await reader.cancel().catch(() => {});
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        pushChunk(options.run, value);
      }
    } catch (error) {
      console.error("[codex-chat] Detached turn failed:", error instanceof Error ? error.message : String(error));
      pushChunk(options.run, { type: "error", errorText: "Codex chat failed. Retry the request." } as UIMessageChunk);
    } finally {
      finishRun(options.run);
    }
  })();
}
