/**
 * Map RaceIQ app settings (provider + model name) to a Mastra model ID string.
 *
 * Mastra uses the format "provider/model-name". Each agent's `model` field is a
 * function that calls this at request time so swapping providers in Settings UI
 * takes effect on the next call without rebuilding agents.
 */
export function getMastraModelId(
  provider: string,
  model: string,
): string {
  switch (provider) {
    case "gemini":
      return `google/${model || "gemini-2.0-flash"}`;
    case "openai":
      return `openai/${model || "gpt-4o-mini"}`;
    case "local":
      // Local models use the OpenAI-compatible API; the model id is passed through.
      return `openai/${model || "local-model"}`;
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
