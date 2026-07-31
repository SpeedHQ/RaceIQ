type AiProvider = "" | "gemini" | "openai" | "codex" | "local";

export interface AiConfigSettings {
  aiProvider?: AiProvider;
  geminiApiKeySet?: boolean;
  aiModel?: string;
  openaiApiKeySet?: boolean;
  codexReady?: boolean;
}

export function isAiConfigured(settings: AiConfigSettings): boolean {
  const provider = settings.aiProvider ?? "gemini";
  if (provider === "local") return true;
  if (provider === "codex") return settings.codexReady === true;
  if (provider === "openai") return !!settings.openaiApiKeySet;
  return !!settings.geminiApiKeySet;
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
