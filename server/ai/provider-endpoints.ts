/** Fixed endpoints for hosted providers; local endpoints are user-configured. */
import type { AiProvider } from "./providers";

const FIXED_BASE_URLS: Partial<Record<AiProvider, string>> = {
  openai: "https://api.openai.com/v1",
  // DeepSeek's OpenAI-compatible API does not require a /v1 suffix.
  deepseek: "https://api.deepseek.com",
};

export function baseUrlFor(provider: AiProvider): string | undefined {
  return FIXED_BASE_URLS[provider];
}
