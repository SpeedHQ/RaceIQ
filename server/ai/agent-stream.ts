import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { toAISdkStream } from "@mastra/ai-sdk";

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

/**
 * Persist the reasoning text assembled on the live stream back into the memory
 * row that Mastra's own async save leaves reasoning-less.
 */
async function persistReasoningToMemory(
  responseMessage: { id?: string; parts?: Array<{ type: string; text?: string }> },
  memory: AgentTurnMemory,
  threadId: string,
  turnStartedAt: number,
  reasoningDurationMs: number,
): Promise<void> {
  try {
    const reasoningText = (responseMessage.parts ?? [])
      .filter((p) => p.type === "reasoning")
      .map((p) => p.text ?? "")
      .join("\n")
      .trim();
    if (!reasoningText) return;

    // Poll until Mastra's own async save has landed this turn's assistant row
    // (finish handling runs as the stream is consumed; it can trail this
    // callback by a few ms).
    //
    // Prefer an exact id match against the streamed response message — that is
    // unambiguously the model's own row. Fall back to the newest assistant row
    // stamped at/after the turn started, but SKIP deterministic tool/route notes
    // (branch_from_version, apply summaries, ...). Those are saved *during* the
    // turn and can carry a newer createdAt than Mastra's trailing model save, so
    // the old "newest assistant" heuristic would stamp the reasoning onto the
    // last branch note — surfacing a phantom thinking block on it.
    const isNote = (m: any) => m?.content?.metadata?.deterministic === true;
    let target: any;
    for (let attempt = 0; attempt < 40; attempt++) {
      const recalled = await memory.recall({ threadId });
      const raw: any[] = recalled.messages ?? [];
      const byId = responseMessage.id
        ? raw.find((m) => m.role === "assistant" && m.id === responseMessage.id)
        : undefined;
      if (byId) {
        target = byId;
        break;
      }
      const newest = [...raw]
        .reverse()
        .find((m) => m.role === "assistant" && !isNote(m));
      if (newest && new Date(newest.createdAt).getTime() >= turnStartedAt) {
        target = newest;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!target) return;

    const existingParts: any[] = Array.isArray(target.content?.parts)
      ? target.content.parts
      : [];
    // Idempotent: bail if reasoning is somehow already persisted.
    if (target.content?.reasoning || existingParts.some((p) => p.type === "reasoning")) {
      return;
    }

    // Write reasoning both as a leading `parts` entry (so MessageList
    // reconstructs it in order, before the answer text) and on
    // `content.reasoning` — mirroring how MessageList itself serialises a
    // response, and matching the GET route's read path.
    // Stamp the turn's thinking wall-time onto content.metadata so it
    // round-trips through MessageList.ui() (same path as usage) and the
    // reasoning trigger can show "Reasoning (Ns)" after a refresh.
    const content = {
      ...target.content,
      reasoning: reasoningText,
      parts: [{ type: "reasoning", reasoning: reasoningText }, ...existingParts],
      metadata: {
        ...(target.content?.metadata ?? {}),
        ...(reasoningDurationMs > 0 ? { reasoning: { durationMs: reasoningDurationMs } } : {}),
      },
    };
    await memory.saveMessages({ messages: [{ ...target, content }] });
  } catch (err: any) {
    console.error("[agent-stream] Failed to persist reasoning:", err?.message ?? err);
  }
}

/**
 * Build a UI-message-stream Response from a Mastra agent stream, forwarding
 * reasoning, attaching usage metadata, and persisting reasoning to memory.
 */
export function streamAgentTurnResponse(opts: StreamAgentTurnOptions): Response {
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

  const uiStream = createUIMessageStream({
    originalMessages,
    onFinish: persistReasoning
      ? async ({ responseMessage }) =>
          persistReasoningToMemory(responseMessage as any, memory, threadId, turnStartedAt, reasoningDurationMs())
      : undefined,
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
          return {
            usage: {
              inputTokens: inputTokens ?? 0,
              outputTokens: outputTokens ?? 0,
              totalTokens: totalTokens ?? 0,
            },
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

  return createUIMessageStreamResponse({ stream: uiStream });
}
