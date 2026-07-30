import { getSecret } from "../keystore";
import { loadSettings, type AppSettings } from "../settings";
import type { AiProvider } from "./providers";
import { AI_FEATURES, type AiFeature } from "./ai-features";

export type { AiFeature } from "./ai-features";

export interface ConfiguredAiProvider {
  provider: Exclude<AiProvider, "">;
  model: string;
  thinkingBudget: number | null;
  localEndpoint: string;
  apiKey?: string;
}
function settingsForFeature(settings: AppSettings, feature: AiFeature): { provider: string; model: string; thinkingBudget: number | null } {
  const config = AI_FEATURES[feature];
  const fallback = config.fallbackFeature ? AI_FEATURES[config.fallbackFeature] : undefined;
  return {
    provider: settings[config.providerSetting] || (fallback ? settings[fallback.providerSetting] : ""),
    model: settings[config.modelSetting] || (fallback ? settings[fallback.modelSetting] : ""),
    thinkingBudget: settings[config.thinkingBudgetSetting] ?? (fallback ? settings[fallback.thinkingBudgetSetting] : null),
  };
}

export async function getConfiguredAiProvider(feature: AiFeature, settings = loadSettings()): Promise<ConfiguredAiProvider> {
  const section = feature === "chat" || feature === "compaction" ? "Chat" : "Analysis";
  const selected = settingsForFeature(settings, feature);
  if (!selected.provider) throw new Error(`No AI provider selected. Choose one in Settings → AI ${section}.`);
  if (selected.provider !== "gemini" && selected.provider !== "openai" && selected.provider !== "local" && selected.provider !== "codex") {
    throw new Error(`Unsupported AI provider: ${selected.provider}`);
  }
  if (selected.provider === "codex") {
    return { provider: selected.provider, model: selected.model, thinkingBudget: selected.thinkingBudget, localEndpoint: settings.localEndpoint };
  }
  let apiKey: string | undefined;
  if (selected.provider === "openai") {
    apiKey = await getSecret("openai-api-key");
    if (!apiKey) throw new Error(`OpenAI API key not set. Add it in Settings → AI ${section}.`);
    process.env.OPENAI_API_KEY = apiKey;
    delete process.env.OPENAI_BASE_URL;
  } else if (selected.provider === "local") {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "local";
    process.env.OPENAI_BASE_URL = settings.localEndpoint || "http://localhost:1234/v1";
  } else {
    apiKey = await getSecret("gemini-api-key");
    if (!apiKey) throw new Error(`Gemini API key not set. Add it in Settings → AI ${section}.`);
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = apiKey;
    delete process.env.OPENAI_BASE_URL;
  }
  return { provider: selected.provider, model: selected.model, thinkingBudget: selected.thinkingBudget, localEndpoint: settings.localEndpoint, apiKey };
}
