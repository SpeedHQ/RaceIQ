/**
 * Request headers for OpenAI-compatible endpoints.
 *
 * Anthropic's OpenAI-compatible API (https://api.anthropic.com/v1) rejects
 * requests without `x-api-key`, so for that host we also send `x-api-key` and
 * `anthropic-version` alongside the usual `Authorization: Bearer`. All other
 * endpoints get exactly the bearer header.
 */

export const ANTHROPIC_VERSION = "2023-06-01";
/** Anthropic's OpenAI-compatible base URL, used by the Claude (Anthropic) provider. */
export const ANTHROPIC_OPENAI_BASE_URL = "https://api.anthropic.com/v1";

export function isAnthropicEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false;
  try {
    return new URL(endpoint).hostname.toLowerCase() === "api.anthropic.com";
  } catch {
    return false;
  }
}

/** Provider-specific headers beyond `Authorization`, for SDK clients that set the bearer themselves. */
export function openAiCompatibleExtraHeaders(endpoint: string | undefined, apiKey?: string): Record<string, string> {
  if (!apiKey || !isAnthropicEndpoint(endpoint)) return {};
  return { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION };
}

/** Auth headers for a raw fetch to an OpenAI-compatible endpoint. */
export function openAiCompatibleAuthHeaders(endpoint: string | undefined, apiKey?: string): Record<string, string> {
  if (!apiKey) return {};
  return { Authorization: `Bearer ${apiKey}`, ...openAiCompatibleExtraHeaders(endpoint, apiKey) };
}

/** Request body keys current Claude models reject on the OpenAI-compatible API. */
const ANTHROPIC_UNSUPPORTED_BODY_KEYS = ["temperature", "top_p"];

/**
 * Rewrite a DeepSeek request body into the shape its API accepts.
 *
 * Two provider facts drive this:
 * - DeepSeek defaults to thinking mode, and on a long comparison prompt the
 *   reasoning stream eats the output budget until the answer is truncated
 *   (`finish_reason: "length"`). Structured-output callers do not need the
 *   visible reasoning, so switch it off and leave the budget to the answer.
 * - DeepSeek rejects `response_format: json_schema` ("This response_format type
 *   is unavailable now") and only offers `json_object`; the schema has to travel
 *   in the prompt. Callers that already put it there keep working, and SDK-side
 *   passes (Mastra's structuring step) no longer 400.
 */
export function deepseekCompatibleBody(body: Record<string, unknown>): Record<string, unknown> {
  body.thinking = { type: "disabled" };
  delete body.reasoning_effort;
  const responseFormat = body.response_format as { type?: unknown } | undefined;
  if (responseFormat?.type === "json_schema") body.response_format = { type: "json_object" };
  return body;
}

/** Wraps fetch so SDK requests to DeepSeek carry `deepseekCompatibleBody` rules. */
export function deepseekCompatibleFetch(baseFetch: typeof fetch = globalThis.fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        init = { ...init, body: JSON.stringify(deepseekCompatibleBody(body)) };
      } catch {
        // Not JSON; send unchanged.
      }
    }
    return baseFetch(input, init);
  }) as typeof fetch;
}

/** Wraps fetch so SDK requests to Anthropic drop body keys Claude rejects. */
export function anthropicCompatibleFetch(baseFetch: typeof fetch = globalThis.fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (ANTHROPIC_UNSUPPORTED_BODY_KEYS.some((key) => key in body)) {
          for (const key of ANTHROPIC_UNSUPPORTED_BODY_KEYS) delete body[key];
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch {
        // Not JSON; send unchanged.
      }
    }
    return baseFetch(input, init);
  }) as typeof fetch;
}
