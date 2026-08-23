import { createUIMessageStream, createUIMessageStreamResponse, type UIMessageChunk } from "ai";
import { toAISdkStream } from "@mastra/ai-sdk";
import { formatClientAiErrorMessage, toClientAiError } from "./provider-error";
import { type ChatRun, pushChunk, finishRun } from "./chat-run-registry";

/**
 * Route-agnostic bridge from a Mastra agent stream to an AI SDK v5 UI-message
 * stream Response. Owns the three concerns that are identical for every chat
 * surface (tune, lap, chats, ...):
 *
 *  1. Reasoning forwarding  — `sendReasoning` defaults to FALSE in
 *     @mastra/ai-sdk, silently stripping thought parts. We force it on so the
 *     UI actually receives a live thinking block.
 *  2. Usage metadata        — map the underlying `finish` part's `totalUsage`
 *     onto assistant-ui's expected `metadata.usage` shape.
 *  3. Reasoning persistence — Mastra's memory auto-save drops reasoning, so we
 *     patch it back into the saved assistant row after the stream assembles it.
 *
 * Everything route-specific (agent selection, provider options, thread-id
 * derivation, message assembly) stays in the caller.
 */

type UiStreamOptions = Parameters<typeof createUIMessageStream>[0];
type AgentStream = Parameters<typeof toAISdkStream>[0];

export function stripThinkTags(text: string): string {
  return text.replace(/<\/?think\b[^>]*>/gi, "");
}

/** Minimal structural view of the Mastra memory we touch. */
interface AgentTurnMemory {
  recall(args: { threadId: string }): Promise<{ messages?: unknown[] }>;
  saveMessages(args: { messages: unknown[] }): Promise<unknown>;
}

export interface StreamAgentTurnOptions {
  /** Result of an agent's `.stream()` call. */
  agentStream: AgentStream;
  /** UI messages passed through for stream reconstruction. */
  originalMessages: UiStreamOptions["originalMessages"];
  /** Mastra memory instance backing the thread. */
  memory: AgentTurnMemory;
  /** Resolved thread id for the turn. */
  threadId: string;
  /**
   * Epoch ms captured before the turn started. Guards the persistence poll so a
   * prior turn's assistant row is never matched.
   */
  turnStartedAt: number;
  /** Abort signal used to stop persistence when the owning chat is cleared. */
  abortSignal?: AbortSignal;
  /** Patch streamed reasoning back into the saved assistant row. Default true. */
  persistReasoning?: boolean;
  /**
   * Revalidate the request's finding receipt after provider output completes.
   * When supplied, output stays buffered until this fence passes, preventing
   * stale provider output from reaching clients or memory.
   */
  validateReceiptFence?: () => Promise<boolean>;
}

export async function persistAssistantTurnToMemory(
  responseMessage: any,
  memory: AgentTurnMemory,
  threadId: string,
  turnStartedAt: number,
  reasoningDurationMs: number,
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number },
  abortSignal?: AbortSignal,
): Promise<void> {
  if (abortSignal?.aborted) return;
  const parts = Array.isArray(responseMessage?.parts) ? responseMessage.parts : [];
  if (!parts.length) return;

  for (let attempt = 0; attempt < 40; attempt++) {
    if (abortSignal?.aborted) return;
    const raw: any[] = (await memory.recall({ threadId })).messages ?? [];
    if (abortSignal?.aborted) return;
    const target =
      raw.find((message) => message.role === "assistant" && message.id === responseMessage.id) ??
      [...raw].reverse().find((message) => {
        if (message.role !== "assistant") return false;
        const createdAt = message.createdAt instanceof Date ? message.createdAt.getTime() : Date.parse(String(message.createdAt ?? ""));
        return Number.isFinite(createdAt) && createdAt >= turnStartedAt;
      });
    if (target) {
      const metadata = {
        ...(target.content?.metadata ?? {}),
        ...(usage ? { usage } : {}),
        ...(reasoningDurationMs > 0 ? { reasoning: { durationMs: reasoningDurationMs } } : {}),
      };
      if (abortSignal?.aborted) return;
      await memory.saveMessages({
        messages: [{
          ...target,
          content: {
            ...target.content,
            format: 2,
            parts,
            content: parts
              .filter((part: any) => part?.type === "text")
              .map((part: any) => part.text ?? "")
              .join(""),
            metadata,
          },
        }],
      });
      return;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
  }
}

export async function restoreOriginalUserMessage(
  originalMessages: UiStreamOptions["originalMessages"],
  memory: AgentTurnMemory,
  threadId: string,
  turnStartedAt = 0,
  abortSignal?: AbortSignal,
): Promise<void> {
  const original = [...(originalMessages as any[])].reverse().find((message) => message.role === "user") as any;
  if (!original?.id) return;
  const text = Array.isArray(original.parts)
    ? original.parts.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("")
    : typeof original.content === "string"
      ? original.content
      : "";
  if (!text) return;

  for (let attempt = 0; attempt < 40; attempt++) {
    if (abortSignal?.aborted) return;
    const raw: any[] = (await memory.recall({ threadId })).messages ?? [];
    if (abortSignal?.aborted) return;
    const target =
      raw.find((message) => message.role === "user" && message.id === original.id) ??
      [...raw].reverse().find((message) => {
        if (message.role !== "user") return false;
        const createdAt = message.createdAt instanceof Date ? message.createdAt.getTime() : Date.parse(String(message.createdAt ?? ""));
        return Number.isFinite(createdAt) && createdAt >= turnStartedAt;
      });
    if (target) {
      if (abortSignal?.aborted) return;
      await memory.saveMessages({
        messages: [{
          ...target,
          content: {
            ...target.content,
            format: 2,
            parts: [{ type: "text", text }],
            content: text,
          },
        }],
      });
      return;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
  }
}

/**
 * Build a UI-message-chunk stream for an agent turn.
 *
 * Receipt-fenced turns buffer chunks until provider completion, then validate
 * the request fence before exposing or persisting any provider output.
 */
function buildAgentTurnUIStream(opts: StreamAgentTurnOptions): ReadableStream<UIMessageChunk> {
  const {
    agentStream,
    originalMessages,
    memory,
    threadId,
    turnStartedAt,
    persistReasoning = true,
    validateReceiptFence,
  } = opts;
  let reasoningFirstTs = 0;
  let reasoningLastTs = 0;
  const reasoningDurationMs = () =>
    reasoningLastTs > reasoningFirstTs ? reasoningLastTs - reasoningFirstTs : 0;
  let finishUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
  let turnFenceValid = !validateReceiptFence;
  return createUIMessageStream({
    onFinish: async ({ responseMessage }) => {
      if (opts.abortSignal?.aborted || !turnFenceValid) return;
      if (persistReasoning) {
        await persistAssistantTurnToMemory(
          responseMessage as any,
          memory,
          threadId,
          turnStartedAt,
          reasoningDurationMs(),
          finishUsage,
          opts.abortSignal,
        );
      }
      await restoreOriginalUserMessage(originalMessages, memory, threadId, turnStartedAt, opts.abortSignal);
    },
    execute: async ({ writer }) => {
      const buffered: UIMessageChunk[] = [];
      try {
        for await (const part of toAISdkStream(agentStream, {
          from: "agent",
          sendReasoning: true,
          messageMetadata: ({ part }) => {
            if (part.type !== "finish") return undefined;
            const { inputTokens, outputTokens, totalTokens } = part.totalUsage;
            const durationMs = reasoningDurationMs();
            finishUsage = {
              inputTokens: inputTokens ?? 0,
              outputTokens: outputTokens ?? 0,
              totalTokens: totalTokens ?? 0,
            };
            return {
              usage: finishUsage,
              ...(durationMs > 0 ? { reasoning: { durationMs } } : {}),
            };
          },
        })) {
          if (opts.abortSignal?.aborted) return;
          if (String((part as { type?: string }).type ?? "").startsWith("reasoning")) {
            const now = Date.now();
            if (reasoningFirstTs === 0) reasoningFirstTs = now;
            reasoningLastTs = now;
          }
          const uiPart =
            (part as { type?: string; delta?: unknown }).type === "text-delta" &&
            typeof (part as { delta?: unknown }).delta === "string"
              ? { ...part, delta: stripThinkTags((part as { delta: string }).delta) }
              : part;
          if (validateReceiptFence) {
            buffered.push(uiPart as UIMessageChunk);
          } else {
            await writer.write(uiPart as Parameters<typeof writer.write>[0]);
          }
        }
        if (opts.abortSignal?.aborted) return;
        if (validateReceiptFence) {
          turnFenceValid = await validateReceiptFence();
          if (opts.abortSignal?.aborted) return;
          if (!turnFenceValid) throw new Error("Finding receipt changed during chat turn");
          for (const part of buffered) {
            if (opts.abortSignal?.aborted) return;
            await writer.write(part as Parameters<typeof writer.write>[0]);
          }
        }
      } catch (err) {
        if (opts.abortSignal?.aborted) return;
        const aiError = toClientAiError(err);
        const promptTokens = aiError.upstream?.promptTokens;
        if (promptTokens != null) {
          await writer.write({
            type: "message-metadata",
            messageMetadata: {
              usage: {
                inputTokens: promptTokens,
                outputTokens: 0,
                totalTokens: promptTokens,
              },
            },
          } as Parameters<typeof writer.write>[0]);
        }
        await writer.write({
          type: "error",
          errorText: formatClientAiErrorMessage(aiError),
        } as Parameters<typeof writer.write>[0]);
      }
    },
  });
}

/**
 * Build a UI-message-stream Response from a Mastra agent stream, forwarding
 * reasoning, attaching usage metadata, and persisting reasoning to memory.
 */
export function streamAgentTurnResponse(opts: StreamAgentTurnOptions): Response {
  return createUIMessageStreamResponse({ stream: buildAgentTurnUIStream(opts) });
}

/**
 * Start a detached agent turn: the agent stream begins executing immediately
 * and is pumped into `run`'s registry buffer (chat-run-registry.ts) — chunks
 * accumulate and fan out to subscribers whether or not a client is attached.
 * Reasoning/message persistence still happens via `onFinish` inside
 * `buildAgentTurnUIStream`, entirely server-side.
 *
 * Callers must reserve `run` via `reserveChatRun()` BEFORE calling this (the
 * double-start guard lives there — `run.abortController.signal` needs to
 * exist before the agent call is even made so it can be threaded into
 * `agent.stream({ abortSignal })`).
 */
export function startDetachedAgentTurn(run: ChatRun, opts: StreamAgentTurnOptions): void {
  const uiStream = buildAgentTurnUIStream(opts);
  const reader = uiStream.getReader();

  (async () => {
    try {
      while (true) {
        if (run.abortController.signal.aborted) {
          await reader.cancel().catch(() => {});
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        pushChunk(run, value);
      }
    } catch (err: any) {
      console.error("[agent-stream] Detached turn failed:", err?.message ?? err);
      pushChunk(run, {
        type: "error",
        errorText: err?.message ?? "Agent turn failed",
      } as UIMessageChunk);
    } finally {
      finishRun(run);
    }
  })();
}
