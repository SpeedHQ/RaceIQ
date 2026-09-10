type AiProvider = "" | "gemini" | "openai" | "openai-compatible";

export interface AiConfigSettings {
  aiProvider?: AiProvider;
  geminiApiKeySet?: boolean;
  aiModel?: string;
  openaiApiKeySet?: boolean;
  chatProvider?: AiProvider;
  chatModel?: string;
}

function isProviderConfigured(provider: AiProvider, settings: AiConfigSettings): boolean {
  if (provider === "openai-compatible") return true;
  if (provider === "openai") return !!settings.openaiApiKeySet;
  if (provider === "gemini") return !!settings.geminiApiKeySet;
  return false;
}

export function isAiConfigured(settings: AiConfigSettings): boolean {
  return isProviderConfigured(settings.aiProvider ?? "", settings);
}

export function isAiAnalysisConfigured(settings: AiConfigSettings): boolean {
  return Boolean(settings.aiProvider && settings.aiModel?.trim()) && isAiConfigured(settings);
}
export function isAiChatConfigured(settings: AiConfigSettings): boolean {
  return Boolean(settings.chatProvider && settings.chatModel?.trim()) && isProviderConfigured(settings.chatProvider ?? "", settings);
}

export function launchAiFeature(aiConfigured: boolean, openFeature: () => void, configureAi: () => void): void {
  if (aiConfigured) {
    openFeature();
    return;
  }
  configureAi();
}
