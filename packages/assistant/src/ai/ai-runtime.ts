import { chatGptReasoningLevels } from "@raceiq/shared/integrations/ai/openai-reasoning";
import type { ChatGptAccountBinding } from "@raceiq/shared/integrations/ai/chatgpt-subscription";
import { ChatGptSubscriptionAdapter } from "./chatgpt-subscription-adapter";
import { getChatGptCatalog } from "./chatgpt-subscription-catalog";
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
} satisfies Record<Exclude<AiProvider, "openai-compatible" | "chatgpt-subscription">, {
  create: (config: AdapterConfig, apiKey: string) => Parameters<typeof resolvedAiFromAdapter>[0];
  includeModelInError: boolean;
}>;

type AdapterConfig = { feature: AiFeature; model: string; thinkingBudget: number | null };


function sectionFor(feature: AiFeature): "Chat" | "Analysis" {
  return feature === "chat" || feature === "compaction" ? "Chat" : "Analysis";
}

export function selectedAiSettings(settings: AppSettings, feature: AiFeature): {
  provider: string;
  model: string;
  thinkingBudget: number | null;
} {
  const config = AI_FEATURES[feature];
  const fallback = config.fallbackFeature ? AI_FEATURES[config.fallbackFeature] : undefined;
  const provider = settings[config.providerSetting] || (fallback ? settings[fallback.providerSetting] : "");
  const model = provider === "chatgpt-subscription" && fallback && !settings[config.providerSetting]
    ? settings[fallback.modelSetting]
    : settings[config.modelSetting] || (provider !== "chatgpt-subscription" && fallback ? settings[fallback.modelSetting] : "");
  return {
    provider,
    model,
    thinkingBudget: settings[config.thinkingBudgetSetting] ?? (fallback ? settings[fallback.thinkingBudgetSetting] : null),
  };
}

type SubscriptionHost = { bindActive(): Promise<ChatGptAccountBinding>; hasDirectLocalAiAccess(): boolean };
let subscriptionHost: SubscriptionHost | null = null;

export function configureSubscriptionHost(host: SubscriptionHost | null) {
  subscriptionHost = host;
}

export async function resolveAi(
  feature: AiFeature,
  settings: AppSettings = loadSettings(),
  source?: "background-driver-profile",
  onSubscriptionUsage?: NonNullable<ConstructorParameters<typeof ChatGptSubscriptionAdapter>[3]>["onUsage"],
): Promise<ResolvedAi> {
  const selected = selectedAiSettings(settings, feature);
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
  if (provider === "chatgpt-subscription") {
    const backgroundAllowed = feature === "driverProfile" && source === "background-driver-profile" && settings.driverProfileBackgroundEnabled;
    if (!subscriptionHost || !(backgroundAllowed || subscriptionHost.hasDirectLocalAiAccess())) {
      throw new AiProviderError("ChatGPT is available only in the local RaceIQ app.", {
        code: "unsupported-operation", provider, modelId: model, statusCode: 403,
      });
    }
    const binding = await subscriptionHost.bindActive();
    const catalog = await getChatGptCatalog(binding);
    if (!catalog.some((entry) => entry.id === model && entry.features.includes(feature === "compaction" ? "chat" : feature))) {
      throw new AiProviderError("Choose an available ChatGPT model in Settings.", {
        code: "unsupported-operation", provider, modelId: model, statusCode: 422,
      });
    }
    const effort = settings.chatSubscriptionReasoningLevel;
    return resolvedAiFromAdapter(new ChatGptSubscriptionAdapter(feature, model, binding, feature === "chat" ? {
      onUsage: onSubscriptionUsage,
      reasoningEffort: effort && chatGptReasoningLevels(model).includes(effort) ? effort : undefined,
    } : undefined));
  }
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
