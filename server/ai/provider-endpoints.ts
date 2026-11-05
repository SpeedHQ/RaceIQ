/**
 * Fixed base URL table.
 *
 * Only providers that ship their own endpoint live here; `openai-compatible` is user-supplied
 * and `gemini` goes through Google's own SDK instead of the OpenAI-compatible layer.
 */
import type { AiProvider } from "./providers";

const FIXED_BASE_URLS: Partial<Record<AiProvider, string>> = {
  openai: "https://api.openai.com/v1",
  // DeepSeek docs (2026-11): OpenAI-format endpoint, no /v1 suffix.
  deepseek: "https://api.deepseek.com",
};

export function baseUrlFor(provider: AiProvider): string | undefined {
  return FIXED_BASE_URLS[provider];
}
