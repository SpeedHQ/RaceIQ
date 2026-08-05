type AiProvider = "" | "gemini" | "openai" | "local";

export interface AiConfigSettings {
  aiProvider?: AiProvider;
  geminiApiKeySet?: boolean;
  openaiApiKeySet?: boolean;
}

export function isAiConfigured(settings: AiConfigSettings): boolean {
  const provider = settings.aiProvider ?? "gemini";
  if (provider === "local") return true;
  if (provider === "openai") return !!settings.openaiApiKeySet;
  return !!settings.geminiApiKeySet;
}
