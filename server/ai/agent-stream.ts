import { createUIMessageStream, createUIMessageStreamResponse, type UIMessageChunk } from "ai";
import { toAISdkStream } from "@mastra/ai-sdk";
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
  /** Patch streamed reasoning back into the saved row. Default true. */
  persistReasoning?: boolean;
}

async function restoreOriginalUserMessage(
  originalMessages: UiStreamOptions["originalMessages"],
  memory: AgentTurnMemory,
  threadId: string,
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
    const raw: any[] = (await memory.recall({ threadId })).messages ?? [];
    const target = raw.find((message) => message.role === "user" && message.id === original.id);
    if (target) {
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
 * Build the raw UI-message-chunk stream for an agent turn: reasoning
 * forwarding, usage metadata, reasoning persistence. Shared by both the
 * plain HTTP-response path (`streamAgentTurnResponse`) and the detached
 * registry-backed path (`startDetachedAgentTurn`) — identical behavior
 * either way, only what consumes the resulting stream differs.
 */
function buildAgentTurnUIStream(opts: StreamAgentTurnOptions): ReadableStream<UIMessageChunk> {
  const {
    agentStream,
    originalMessages,
    memory,
    threadId,
    turnStartedAt,
    persistReasoning = true,
  } = opts;

  // Wall-clock span of the turn's thinking: first reasoning chunk → last one.
  // Captured in the stream loop, read at finish (metadata) and onFinish (persist).
  let reasoningFirstTs = 0;
  let reasoningLastTs = 0;
  const reasoningDurationMs = () =>
    reasoningLastTs > reasoningFirstTs ? reasoningLastTs - reasoningFirstTs : 0;

  // Final token usage off the stream's `finish` part — captured in
  // messageMetadata below, persisted to memory in onFinish so the footer
  // survives a refresh.
  let finishUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;

  return createUIMessageStream({
    originalMessages,
    onFinish: async ({ responseMessage }) => {
      if (persistReasoning) {
        await persistReasoningToMemory(responseMessage as any, memory, threadId, turnStartedAt, reasoningDurationMs(), finishUsage);
      }
      await restoreOriginalUserMessage(originalMessages, memory, threadId);
    },
    execute: async ({ writer }) => {
      for await (const part of toAISdkStream(agentStream, {
        from: "agent",
        // `sendReasoning` defaults to FALSE in @mastra/ai-sdk, which silently
        // strips the model's thought parts out of the UI-message stream — so
        // even with includeThoughts:true on the Gemini side the chat only ever
        // saw the running indicator and never a live thinking block. Turn it on
        // so reasoning parts actually reach the UI.
        sendReasoning: true,
        // Threaded straight into AI SDK v5's UIMessageStreamOptions. Invoked on
        // the underlying stream's `start`/`finish` TextStreamPart events;
        // `finish` carries `totalUsage` in ai@7's LanguageModelV2Usage shape —
        // { inputTokens, outputTokens, totalTokens } — already exactly the shape
        // assistant-ui's useThreadTokenUsage() reads off metadata.usage.
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
        // Stamp thinking wall-time as reasoning chunks flow past. AI SDK v5
        // emits reasoning as `reasoning-start`/`reasoning-delta`/`reasoning-end`
        // parts — match the whole family by prefix.
        if (String((part as { type?: string }).type ?? "").startsWith("reasoning")) {
          const now = Date.now();
          if (reasoningFirstTs === 0) reasoningFirstTs = now;
          reasoningLastTs = now;
        }
        // `toAISdkStream`'s chunk type is inferred from Mastra's own bundled `ai`
        // types, which drift slightly from this repo's `ai` version (e.g.
        // `finishReason: "unknown"` isn't in the local FinishReason union). The
        // wire shape is identical — cast to bridge the two.
        await writer.write(part as Parameters<typeof writer.write>[0]);
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
