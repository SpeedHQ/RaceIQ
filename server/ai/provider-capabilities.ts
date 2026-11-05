/**
 * Provider capability defaults — pure helpers shared by the request paths.
 *
 * The chat-completions helper used to assume "anything that is not OpenAI or
 * Anthropic is a local model", which forced `reasoning_effort: "none"` onto
 * hosted OpenAI-compatible APIs (DeepSeek included). These helpers keep the
 * per-endpoint decision in one testable place instead of inlined conditionals.
 */

const DEEPSEEK_BASE = "https://api.deepseek.com";
const OPENAI_BASE = "https://api.openai.com/v1";

export type ReasoningEffort = "none" | "low" | "medium" | "high";

function normalizeEndpoint(endpoint?: string | null): string {
  return (endpoint ?? "").trim().replace(/\/+$/, "");
}

export function isDeepSeekEndpoint(endpoint?: string | null): boolean {
  const value = normalizeEndpoint(endpoint);
  return value === DEEPSEEK_BASE || value.startsWith(`${DEEPSEEK_BASE}/`);
}

function isOpenAiEndpoint(endpoint: string): boolean {
  return endpoint === OPENAI_BASE || endpoint.startsWith(`${OPENAI_BASE}/`);
}

function isAnthropicEndpoint(endpoint: string): boolean {
  return endpoint.includes("anthropic.com");
}

/**
 * What `reasoning_effort` this endpoint should receive by default.
 *
 * - OpenAI / Anthropic: leave unset (OpenAI uses `reasoning.effort` for o-series,
 *   Anthropic's compatibility layer maps the field to extended thinking).
 * - DeepSeek: officially supports low/medium/high, so medium by default.
 * - Anything else: assume a local server that may reject the field.
 */
export function defaultReasoningEffortFor(endpoint?: string | null): ReasoningEffort | undefined {
  const value = normalizeEndpoint(endpoint);
  if (!value) return "none";
  if (isOpenAiEndpoint(value)) return undefined;
  if (isAnthropicEndpoint(value)) return undefined;
  if (isDeepSeekEndpoint(value)) return "medium";
  return "none";
}

/** Fallback model id when the user has not picked one for a provider. */
export function defaultModelFor(provider: string): string {
  switch (provider) {
    case "gemini":
      return "gemini-flash-latest";
    case "openai":
      return "gpt-4o-mini";
    case "anthropic":
      return "claude-haiku-5-5";
    case "deepseek":
      return "deepseek-flash";
    default:
      return "local-model";
  }
}

/** Map a DeepSeek `GET /models` payload into the picker's model shape. */
export function mapDeepSeekModels(payload: unknown): { id: string; name: string }[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const models: { id: string; name: string }[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) models.push({ id, name: id });
  }
  return models;
}

/** Provider ids the runtime can actually resolve. Kept next to the defaults so a
 *  new provider is added in one place instead of three switch statements. */
const SUPPORTED_AI_PROVIDERS = new Set(["gemini", "openai", "anthropic", "deepseek", "openai-compatible"]);

export function isSupportedAiProvider(provider: string): boolean {
  return SUPPORTED_AI_PROVIDERS.has(provider);
}

export type StructuredResponseFormat = "json_schema" | "json_object";

/**
 * Which `response_format` an endpoint accepts for schema-constrained output.
 *
 * DeepSeek rejects `json_schema` ("This response_format type is unavailable
 * now") and only offers `json_object`, so callers must also describe the schema
 * in the prompt. Everyone else keeps the native schema path.
 */
export function responseFormatFor(endpoint?: string | null): StructuredResponseFormat {
  return isDeepSeekEndpoint(endpoint) ? "json_object" : "json_schema";
}