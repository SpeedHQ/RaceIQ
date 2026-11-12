export const AI_PROVIDERS = {
  gemini: { name: "Google Gemini", label: "Gemini", environmentKey: "GOOGLE_GENERATIVE_AI_API_KEY", defaultModel: "gemini-flash-latest" },
  openai: { name: "OpenAI", label: "OpenAI", environmentKey: "OPENAI_API_KEY", defaultModel: "gpt-4o-mini" },
  anthropic: { name: "Claude (Anthropic)", label: "Anthropic", environmentKey: "ANTHROPIC_API_KEY", defaultModel: "claude-haiku-5-5" },
  deepseek: { name: "DeepSeek", label: "DeepSeek", environmentKey: "DEEPSEEK_API_KEY", defaultModel: "deepseek-flash" },
  "openai-compatible": { name: "OpenAI-compatible", label: "OpenAI-compatible", environmentKey: null, defaultModel: "local-model" },
} as const;

export type AiProvider = keyof typeof AI_PROVIDERS;

export function isAiProvider(value: string): value is AiProvider {
  return Object.hasOwn(AI_PROVIDERS, value);
}
