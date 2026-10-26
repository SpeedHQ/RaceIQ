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
