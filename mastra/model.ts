/**
 * Map RaceIQ app settings (provider + model name) to a Mastra model config.
 *
 * For `local` (LM Studio / Ollama) we instantiate the native OpenAI provider
 * with a custom baseURL and `compatibility: "compatible"`, which pins the
 * transport to `/v1/chat/completions` (not `/v1/responses`). This keeps tool
 * calls on the format LM Studio fully supports.
 */
import { createOpenAI } from "@ai-sdk/openai";

type OpenAIModel = ReturnType<ReturnType<typeof createOpenAI>>;

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
      });
      // `openai(id)` targets `/v1/responses` in @ai-sdk/openai v3+. LM Studio
      // only fully implements `/v1/chat/completions`, so pick that transport
      // explicitly via `.chat(id)`.
      return openai.chat(model || "local-model");
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
