/**
 * Newline-delimited JSON (NDJSON) streaming protocol for chat endpoints.
 *
 * Reshapes a Mastra `agent.stream()` result into a typed event stream so the
 * client can distinguish "thinking" (waiting for first token) from
 * "generating" (tokens flowing), surface tool calls live, and show an
 * accurate token count at the end of the run.
 *
 * Event shapes emitted (one JSON object per line, `\n` terminated):
 *   { type: "status", state: "thinking" | "generating" }
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

type AgentStream = Awaited<ReturnType<Agent["stream"]>>;

export function chatStreamResponse(streamPromise: Promise<AgentStream> | AgentStream): Response {
  const encoder = new TextEncoder();
  const writeEvent = (c: ReadableStreamDefaultController, obj: unknown) => {
    try { c.enqueue(encoder.encode(JSON.stringify(obj) + "\n")); } catch { /* closed */ }
  };

  const readable = new ReadableStream({
    async start(controller) {
      let firstTextArrived = false;
      // Immediate status so the UI can show "Thinking…" without waiting for
      // the model to warm up. Works around Bun / Vite / browser idle timers
      // for slow local models (LM Studio, Ollama) where time-to-first-token
      // can be 30-90s.
      writeEvent(controller, { type: "status", state: "thinking" });
      const keepAlive = setInterval(() => {
        if (firstTextArrived) return;
        writeEvent(controller, { type: "ping" });
      }, 15_000);

      try {
        const stream = await streamPromise;
        // Mastra's fullStream emits typed parts with a `payload` sub-object:
        // { type: "text-delta",   payload: { text } }
        // { type: "tool-call",    payload: { toolName, args, ... } }
        // { type: "tool-result",  payload: { toolName, result, ... } }
        // { type: "finish",       payload: { output: { usage } } }
        // { type: "error",        payload: { error } }
        // (plus start/step-start/raw/reasoning-* that we ignore here).
        for await (const part of stream.fullStream as AsyncIterable<AgentStreamPart>) {
          const p = (part as { payload?: Record<string, unknown> }).payload ?? {};
          switch (part.type) {
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
              const output = (p.output ?? {}) as Record<string, unknown>;
              const u = (output.usage ?? p.usage ?? {}) as Record<string, unknown>;
              const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
              writeEvent(controller, {
                type: "usage",
                inputTokens: n("inputTokens") || n("promptTokens"),
                outputTokens: n("outputTokens") || n("completionTokens"),
              });
              break;
            }
            case "error":
              writeEvent(controller, {
                type: "error",
                message: p.error instanceof Error ? p.error.message : String(p.error ?? "unknown error"),
              });
              break;
          }
        }
        writeEvent(controller, { type: "done" });
        controller.close();
      } catch (err: unknown) {
        writeEvent(controller, {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        try { controller.close(); } catch { /* already closed */ }
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

/** Narrow subset of AI SDK stream part shapes we care about. */
type AgentStreamPart =
  | { type: "text-delta"; textDelta?: string; text?: string }
  | { type: "tool-call"; toolName: string }
  | { type: "tool-result"; toolName: string }
  | { type: "finish"; usage?: Record<string, unknown>; finishReason?: string }
  | { type: "step-finish"; usage?: Record<string, unknown> }
  | { type: "error"; error: unknown }
  | { type: string; [k: string]: unknown };
