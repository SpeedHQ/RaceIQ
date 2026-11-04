/**
 * 固定 base URL 表。
 *
 * 只有"厂商自带端点"的 provider 才在这里；`openai-compatible` 由用户填写，
 * `gemini` 走 Google 自己的 SDK，不经过 OpenAI 兼容层。
 */
import type { AiProvider } from "./providers";

const FIXED_BASE_URLS: Partial<Record<AiProvider, string>> = {
  openai: "https://api.openai.com/v1",
  // DeepSeek 官方文档（2026-11）：OpenAI 格式端点，无 /v1 后缀。
  deepseek: "https://api.deepseek.com",
};

export function baseUrlFor(provider: AiProvider): string | undefined {
  return FIXED_BASE_URLS[provider];
}
