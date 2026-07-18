/**
 * Map RaceIQ app settings (provider + model name) to a Mastra model config.
 *
 * For `local` (LM Studio / Ollama) we instantiate the native OpenAI provider
 * with a custom baseURL and `.chat(id)`, which pins the transport to
 * `/v1/chat/completions` (not `/v1/responses`). This keeps tool calls on the
 * format LM Studio fully supports.
 *
 * Local thinking models (qwen3, deepseek-r1, gpt-oss, ...) stream their
 * chain-of-thought in a *separate* OpenAI SSE delta field,
 * `choices[0].delta.reasoning_content` (and `message.reasoning_content` for
 * non-streamed responses) — NOT inline `<think>` tags and NOT the standard
 * `reasoning` field. `@ai-sdk/openai` v4 has no mapping for `reasoning_content`,
 * so the provider silently discards it and no reasoning part ever reaches
 * Mastra or the tune chat's thinking block.
 *
 * We fix this at the transport with a custom `fetch` that rewrites the SSE
 * stream, splicing `reasoning_content` deltas into the normal `content` stream
 * wrapped in `<think>...</think>`. `extractReasoningMiddleware({ tagName:
 * "think" })` then turns that back into structured reasoning parts, restoring
 * the trace end-to-end. Cloud providers already emit reasoning parts natively,
 * so they never hit this path and are untouched.
 */
import { createOpenAI } from "@ai-sdk/openai";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import { extractReasoningMiddleware, wrapLanguageModel } from "ai";

type OpenAIModel = ReturnType<ReturnType<typeof createOpenAI>>;

const SSE_DATA_PREFIX = "data:";

/**
 * Rewrite a single line of an OpenAI SSE stream, converting
 * `delta.reasoning_content` into `<think>`-wrapped `delta.content`. `state.open`
 * tracks whether a `<think>` block is currently unterminated across lines so we
 * can emit matching open/close tags. Non-`data:` lines, `[DONE]`, and
 * unparseable payloads pass through untouched.
 */
function rewriteSseLine(line: string, state: { open: boolean }): string {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith(SSE_DATA_PREFIX)) return line;

  const payload = trimmed.slice(SSE_DATA_PREFIX.length).trim();
  if (payload === "" || payload === "[DONE]") return line;

  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return line;
  }

  const choice = (json as { choices?: Array<Record<string, unknown>> })
    ?.choices?.[0];
  const delta = choice?.delta as
    | { reasoning_content?: unknown; content?: unknown }
    | undefined;
  if (!delta) return line;

  const hadReasoningField = "reasoning_content" in delta;
  const reasoning =
    typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
  const original = typeof delta.content === "string" ? delta.content : "";
  const finishing = choice?.finish_reason != null;

  // Nothing reasoning-related and no open block to close → leave as-is.
  if (reasoning === "" && !hadReasoningField && !state.open) return line;

  let out = "";
  if (reasoning !== "") {
    if (!state.open) {
      out += "<think>";
      state.open = true;
    }
    out += reasoning;
  }
  // Real answer text — or the terminal chunk — closes any open reasoning block.
  if (state.open && (original !== "" || finishing)) {
    out += "</think>";
    state.open = false;
  }
  out += original;

  if (hadReasoningField) delete delta.reasoning_content;
  if (out !== "") delta.content = out;

  // `payload` is the exact JSON substring of `line`, so a single replace keeps
  // the `data: ` framing and any surrounding whitespace intact.
  return line.replace(payload, JSON.stringify(json));
}

/**
 * Copy response headers minus framing headers that no longer match once we
 * replace the body: `content-length` (byte count changes) and
 * `content-encoding` (fetch already decoded the body, so re-advertising gzip
 * etc. would make the consumer try to inflate plain text). Dropping them lets
 * the runtime recompute length and treat the body as identity-encoded.
 */
function headersForRewrittenBody(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return headers;
}

/**
 * A `fetch` wrapper that transparently maps LM Studio / Ollama
 * `reasoning_content` into `<think>`-wrapped content for both streamed
 * (`text/event-stream`) and non-streamed (`application/json`) chat completions.
 * Anything else is returned unchanged.
 */
function reasoningContentToThinkFetch(baseFetch: FetchFunction): FetchFunction {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    const contentType = response.headers.get("content-type") ?? "";

    // Streamed responses: rewrite the SSE body chunk by chunk.
    if (response.body && contentType.includes("text/event-stream")) {
      const state = { open: false };
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = "";

      const rewriteBlock = (block: string): string =>
        block
          .split("\n")
          .map((l) => rewriteSseLine(l, state))
          .join("\n");

      const transform = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          buffer += decoder.decode(chunk, { stream: true });
          // Only process whole lines; keep any trailing partial line buffered
          // so we never split an SSE JSON payload mid-way.
          const lastNewline = buffer.lastIndexOf("\n");
          if (lastNewline === -1) return;
          const ready = buffer.slice(0, lastNewline + 1);
          buffer = buffer.slice(lastNewline + 1);
          controller.enqueue(encoder.encode(rewriteBlock(ready)));
        },
        flush(controller) {
          buffer += decoder.decode();
          if (buffer !== "") {
            controller.enqueue(encoder.encode(rewriteBlock(buffer)));
          }
        },
      });

      return new Response(response.body.pipeThrough(transform), {
        status: response.status,
        statusText: response.statusText,
        headers: headersForRewrittenBody(response.headers),
      });
    }

    // Non-streamed responses: splice `message.reasoning_content` into content.
    if (contentType.includes("application/json")) {
      const raw = await response.text();
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return new Response(raw, {
          status: response.status,
          statusText: response.statusText,
          headers: headersForRewrittenBody(response.headers),
        });
      }
      const message = (json as { choices?: Array<{ message?: unknown }> })
        ?.choices?.[0]?.message as
        | { reasoning_content?: unknown; content?: unknown }
        | undefined;
      if (message && typeof message.reasoning_content === "string") {
        const reasoning = message.reasoning_content;
        const content =
          typeof message.content === "string" ? message.content : "";
        if (reasoning !== "") {
          message.content = `<think>${reasoning}</think>${content}`;
        }
        delete message.reasoning_content;
      }
      return new Response(JSON.stringify(json), {
        status: response.status,
        statusText: response.statusText,
        headers: headersForRewrittenBody(response.headers),
      });
    }

    return response;
  };
}

export function getMastraModelId(
  provider: string,
  model: string,
  localEndpoint?: string,
): string | OpenAIModel {
  switch (provider) {
    case "gemini":
      return `google/${model || "gemini-flash-latest"}`;
    case "openai":
      return `openai/${model || "gpt-4o-mini"}`;
    case "local": {
      const openai = createOpenAI({
        baseURL: localEndpoint ?? "http://localhost:1234/v1",
        apiKey: "local",
        // Surface the non-standard `reasoning_content` field that LM Studio /
        // Ollama thinking models emit; see the file header for the full chain.
        fetch: reasoningContentToThinkFetch(globalThis.fetch as FetchFunction),
      });
      // `openai(id)` targets `/v1/responses` in @ai-sdk/openai v3+. LM Studio
      // only fully implements `/v1/chat/completions`, so pick that transport
      // explicitly via `.chat(id)`.
      const base = openai.chat(model || "local-model");
      // The custom fetch above re-wraps `reasoning_content` as `<think>` tags;
      // this middleware parses those (plus any genuinely inlined `<think>`
      // tags) back into structured reasoning parts. `startWithReasoning` stays
      // false — the middleware only extracts content actually wrapped in tags.
      return wrapLanguageModel({
        model: base,
        middleware: extractReasoningMiddleware({ tagName: "think" }),
      }) as unknown as OpenAIModel;
    }
    default: {
      // claude-cli fallback
      const claudeMap: Record<string, string> = {
        haiku: "anthropic/claude-haiku-3-5-20241022",
        sonnet: "anthropic/claude-sonnet-4-6",
        opus: "anthropic/claude-opus-4-6",
      };
      return claudeMap[model] || "anthropic/claude-haiku-3-5-20241022";
    }
  }
}
