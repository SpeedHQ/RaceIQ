import { getAiProviderApiKey } from "@raceiq/assistant/ai/openai-compatible-provider";
import { isSupportedAiProvider } from "@raceiq/assistant/ai/provider-capabilities";
import { loadSettings, type AppSettings } from "@raceiq/backend-core/runtime/config/settings";
import { AI_FEATURES, AI_PROVIDERS, type AiFeature, type AiProvider } from "@raceiq/assistant/ai/ai-features";
import {
  AiProviderError,
} from "@raceiq/assistant/ai/provider-error";
import {
  AnthropicProviderAdapter,
  DeepSeekProviderAdapter,
  GeminiProviderAdapter,
  OpenAiCompatibleProviderAdapter,
  OpenAiProviderAdapter,
  resolvedAiFromAdapter,
} from "./provider-adapters";

import type { ResolvedAi } from "@raceiq/assistant/ai/ai-types";
const PROVIDER_ADAPTERS = {
  gemini: { create: (config: AdapterConfig, apiKey: string) => new GeminiProviderAdapter({ ...config, apiKey }), includeModelInError: true },
  openai: { create: (config: AdapterConfig, apiKey: string) => new OpenAiProviderAdapter({ ...config, apiKey }), includeModelInError: true },
  anthropic: { create: (config: AdapterConfig, apiKey: string) => new AnthropicProviderAdapter({ ...config, apiKey }), includeModelInError: false },
  deepseek: { create: (config: AdapterConfig, apiKey: string) => new DeepSeekProviderAdapter({ ...config, apiKey }), includeModelInError: false },
} satisfies Record<Exclude<AiProvider, "openai-compatible">, {
  create: (config: AdapterConfig, apiKey: string) => Parameters<typeof resolvedAiFromAdapter>[0];
  includeModelInError: boolean;
}>;

type AdapterConfig = { feature: AiFeature; model: string; thinkingBudget: number | null };


function sectionFor(feature: AiFeature): "Chat" | "Analysis" {
  return feature === "chat" || feature === "compaction" ? "Chat" : "Analysis";
}

function selectedSettings(settings: AppSettings, feature: AiFeature): {
  provider: string;
  model: string;
  thinkingBudget: number | null;
} {
  const config = AI_FEATURES[feature];
  const fallback = config.fallbackFeature ? AI_FEATURES[config.fallbackFeature] : undefined;
  return {
    provider: settings[config.providerSetting] || (fallback ? settings[fallback.providerSetting] : ""),
    model: settings[config.modelSetting] || (fallback ? settings[fallback.modelSetting] : ""),
    thinkingBudget: settings[config.thinkingBudgetSetting] ?? (fallback ? settings[fallback.thinkingBudgetSetting] : null),
  };
}

export async function resolveAi(feature: AiFeature, settings: AppSettings = loadSettings()): Promise<ResolvedAi> {
  const selected = selectedSettings(settings, feature);
  const section = sectionFor(feature);
  if (!selected.provider) {
    throw new AiProviderError(`No AI provider selected. Choose one in Settings → AI ${section}.`, {
      code: "missing-provider",
    });
  }

  const provider = selected.provider as AiProvider;
  if (!isSupportedAiProvider(provider)) {
    throw new AiProviderError(`Unsupported AI provider: ${selected.provider}`, {
      code: "unsupported-provider",
      provider: selected.provider,
    });
  }

  const model = selected.model.trim();
  if (!model) {
    throw new AiProviderError(`No AI model selected. Choose one in Settings → AI ${section}.`, {
      code: "missing-model",
      provider,
    });
  }
  const config = { feature, model, thinkingBudget: selected.thinkingBudget };
  const apiKey = await getAiProviderApiKey(provider);
  if (provider === "openai-compatible") {
    return resolvedAiFromAdapter(new OpenAiCompatibleProviderAdapter({
      ...config,
      endpoint: settings.localEndpoint || "http://localhost:1234/v1",
      apiKey,
    }));
  }
  const definition = PROVIDER_ADAPTERS[provider];
  if (!definition) {
    throw new AiProviderError(`Unsupported AI provider: ${provider}`, {
      code: "unsupported-provider",
      provider,
    });
  }
  if (!apiKey) {
    throw new AiProviderError(`${AI_PROVIDERS[provider].label} API key not set. Add it in Settings → AI ${section}.`, {
      code: "missing-api-key",
      provider,
      ...(definition.includeModelInError ? { modelId: model } : {}),
    });
  }
  return resolvedAiFromAdapter(definition.create(config, apiKey));
}
