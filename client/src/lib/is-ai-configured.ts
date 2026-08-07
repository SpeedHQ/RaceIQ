type AiProvider = "" | "gemini" | "openai" | "local";

export interface AiConfigSettings {
  aiProvider?: AiProvider;
  geminiApiKeySet?: boolean;
  aiModel?: string;
  openaiApiKeySet?: boolean;
}

export function isAiConfigured(settings: AiConfigSettings): boolean {
  const provider = settings.aiProvider ?? "";
  if (provider === "local") return true;
  if (provider === "openai") return !!settings.openaiApiKeySet;
  if (provider === "gemini") return !!settings.geminiApiKeySet;
  return false;
}

export function isAiAnalysisConfigured(settings: AiConfigSettings): boolean {
  return Boolean(settings.aiProvider && settings.aiModel?.trim()) && isAiConfigured(settings);
}

export function launchAiFeature(aiConfigured: boolean, openFeature: () => void, configureAi: () => void): void {
  if (aiConfigured) {
    openFeature();
    return;
  }
  configureAi();
}
