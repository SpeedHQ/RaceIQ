/**
 * Newline-delimited JSON (NDJSON) streaming protocol for chat endpoints.
 *
 * Reshapes a Mastra `agent.stream()` result into a typed event stream so the
 * client can distinguish "thinking" (waiting for first token) from
 * "generating" (tokens flowing), surface tool calls live, and show an
 * accurate token count at the end of the run.
 *
 * Event shapes emitted (one JSON object per line, `\n` terminated):
 *   { type: "status", state: "starting" | "thinking" | "generating" }
 *   { type: "tool",   state: "start" | "end", name }
 *   { type: "text",   delta }
 *   { type: "usage",  inputTokens, outputTokens }
 *   { type: "ping" }                        // heartbeat while idle
 *   { type: "error",  message }
 *   { type: "done" }                         // terminator
 *
 * Why NDJSON and not Server-Sent Events: existing chat route already
 * returned plain text via `Response(ReadableStream)`; NDJSON is a
 * line-oriented swap that keeps the same plumbing (no SSE parser needed
 * on the client beyond a line splitter).
 */
import type { Agent } from "@mastra/core/agent";

import { estimateTokenCostUsd } from "./chat-pricing";
import { toClientAiError } from "./provider-error";

type AgentStream = Awaited<ReturnType<Agent["stream"]>>;
type AgentStreamPart = AgentStream["fullStream"] extends AsyncIterable<infer Part> ? Part : never;
type StreamFactory = () => Promise<AgentStream> | AgentStream;
function pickUsage(part: AgentStreamPart, payload: Record<string, unknown>): Record<string, unknown> {
  const partObj = part as unknown as Record<string, unknown>;
  const output = (payload.output ?? partObj.output ?? {}) as Record<string, unknown>;
  const usage = (
    output.usage
    ?? output.usageMetadata
    ?? payload.usage
    ?? payload.usageMetadata
    ?? partObj.usage
    ?? partObj.usageMetadata
    ?? {}
  ) as Record<string, unknown>;
  return usage;
}


type ChatStreamContext = {
  provider: string | null;
  modelId: string | null;
};
export function chatStreamResponse(
  streamSource: Promise<AgentStream> | AgentStream | StreamFactory,
  context?: ChatStreamContext,
): Response {
  const encoder = new TextEncoder();
  const writeEvent = (c: ReadableStreamDefaultController, obj: unknown) => {
    try {
      c.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
    } catch {
      /* closed */
    }
  };

  const createStream: StreamFactory = typeof streamSource === "function"
    ? streamSource
    : () => streamSource;

  const provider = context?.provider ?? null;
  const modelId = context?.modelId ?? null;
  const readable = new ReadableStream({
    async start(controller) {
      let firstTextArrived = false;
      // "starting" means request is in-flight but model has not emitted any
      // reasoning/text yet. We only emit "thinking" when reasoning parts
      // actually arrive, so non-thinking models never show a fake thinking
      // state in the UI.
      writeEvent(controller, { type: "status", state: "starting" });
      const keepAlive = setInterval(() => {
        if (firstTextArrived) return;
        writeEvent(controller, { type: "ping" });
      }, 15_000);

      let attempt = 0;
      const maxAttempts = 2;

      try {
        while (attempt < maxAttempts) {
          attempt += 1;
          try {
            const stream = await createStream();
            // Mastra's fullStream emits typed parts with a `payload` sub-object:
            // { type: "text-delta",   payload: { text } }
            // { type: "tool-call",    payload: { toolName, args, ... } }
            // { type: "tool-result",  payload: { toolName, result, ... } }
            // { type: "finish",       payload: { output: { usage } } }
            // { type: "error",        payload: { error } }
            // (plus start/step-start/raw/reasoning-* that we ignore here).
            for await (const part of stream.fullStream as AsyncIterable<AgentStreamPart>) {
              const p = (part as { payload?: Record<string, unknown> }).payload ?? {};
              const partType = (part as { type: string }).type;
              switch (partType) {
                case "reasoning-start":
                case "reasoning-delta":
                case "reasoning":
                  writeEvent(controller, { type: "status", state: "thinking" });
                  break;
                case "text-delta": {
                  if (!firstTextArrived) {
                    firstTextArrived = true;
                    writeEvent(controller, { type: "status", state: "generating" });
                  }
                  const delta = typeof p.text === "string" ? p.text : "";
                  if (delta) writeEvent(controller, { type: "text", delta });
                  break;
                }
                case "tool-call":
                  writeEvent(controller, {
                    type: "tool",
                    state: "start",
                    name: typeof p.toolName === "string" ? p.toolName : "unknown",
                  });
                  break;
                case "tool-result":
                  writeEvent(controller, {
                    type: "tool",
                    state: "end",
                    name: typeof p.toolName === "string" ? p.toolName : "unknown",
                  });
                  break;
                case "finish":
                case "step-finish": {
                  const u = pickUsage(part, p);
                  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
                  const inputTokens = n("inputTokens") || n("promptTokens") || n("promptTokenCount") || n("input_tokens");
                  const outputTokens = n("outputTokens") || n("completionTokens") || n("candidatesTokenCount") || n("output_tokens");
                  writeEvent(controller, {
                    type: "usage",
                    inputTokens,
                    outputTokens,
                    costUsd: estimateTokenCostUsd(inputTokens, outputTokens, provider, modelId),
                    model: modelId,
                  });
                  break;
                }
                case "error": {
                  const aiError = toClientAiError(p.error);
                  writeEvent(controller, { type: "error", ...aiError });
                  break;
                }
              }
            }

            writeEvent(controller, { type: "done" });
            controller.close();
            return;
          } catch (err: unknown) {
            const aiError = toClientAiError(err);
            const shouldRetry = aiError.retryable && attempt < maxAttempts;
            if (shouldRetry) continue;
            writeEvent(controller, { type: "error", ...aiError });
            try {
              controller.close();
            } catch {
              /* already closed */
            }
            return;
          }
        }
      } finally {
        clearInterval(keepAlive);
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "Transfer-Encoding": "chunked",
    },
  });
}

/** Stream part type is inferred from Mastra Agent.stream(). */
