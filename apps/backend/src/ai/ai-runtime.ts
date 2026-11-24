import { getAiProviderApiKey } from "@raceiq/backend-core/ai/openai-compatible-provider";
import { isSupportedAiProvider } from "@raceiq/backend-core/ai/provider-capabilities";
import { loadSettings, type AppSettings } from "@raceiq/backend-core/runtime/config/settings";
import { AI_FEATURES, type AiFeature, type AiProvider } from "@raceiq/backend-core/ai/ai-features";
import { chatGptReasoningLevels } from "@raceiq/shared/integrations/ai/openai-reasoning";
import {
  AiProviderError,
} from "@raceiq/backend-core/ai/provider-error";
import {
  AnthropicProviderAdapter,
  DeepSeekProviderAdapter,
  GeminiProviderAdapter,
  OpenAiCompatibleProviderAdapter,
  OpenAiProviderAdapter,
  resolvedAiFromAdapter,
} from "./provider-adapters";

import type { ResolvedAi } from "@raceiq/backend-core/ai/ai-types";
import { ChatGptSubscriptionAdapter } from "./chatgpt-subscription-adapter";
import { getChatGptCatalog } from "./chatgpt-subscription-catalog";
import { hasDirectLocalAiAccess } from "../runtime/http-access";
import { chatGptAccounts } from "../runtime/chatgpt-subscription-runtime";

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
  switch (provider) {
    case "chatgpt-subscription": {
      const backgroundAllowed = feature === "driverProfile" && source === "background-driver-profile" && settings.driverProfileBackgroundEnabled;
      if (!chatGptAccounts || !(backgroundAllowed || hasDirectLocalAiAccess())) {
        throw new AiProviderError("ChatGPT is available only in the local RaceIQ app.", {
          code: "unsupported-operation", provider, modelId: model, statusCode: 403,
        });
      }
      const binding = await chatGptAccounts.bindActive();
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
    case "gemini": {
      const apiKey = await getAiProviderApiKey("gemini");
      if (!apiKey) {
        throw new AiProviderError(`Gemini API key not set. Add it in Settings → AI ${section}.`, {
          code: "missing-api-key",
          provider,
          modelId: model,
        });
      }
      return resolvedAiFromAdapter(new GeminiProviderAdapter({ ...config, apiKey }));
    }
    case "openai": {
      const apiKey = await getAiProviderApiKey("openai");
      if (!apiKey) {
        throw new AiProviderError(`OpenAI API key not set. Add it in Settings → AI ${section}.`, {
          code: "missing-api-key",
          provider,
          modelId: model,
        });
      }
      return resolvedAiFromAdapter(new OpenAiProviderAdapter({ ...config, apiKey }));
    }
    case "anthropic": {
      const apiKey = await getAiProviderApiKey("anthropic");
      if (!apiKey) {
        throw new AiProviderError(`Anthropic API key not set. Add it in Settings → AI ${section}.`, {
          code: "missing-api-key",
          provider,
        });
      }
      return resolvedAiFromAdapter(new AnthropicProviderAdapter({ ...config, apiKey }));
    }
    case "deepseek": {
      const apiKey = await getAiProviderApiKey("deepseek");
      if (!apiKey) {
        throw new AiProviderError(`DeepSeek API key not set. Add it in Settings → AI ${section}.`, {
          code: "missing-api-key",
          provider,
        });
      }
      return resolvedAiFromAdapter(new DeepSeekProviderAdapter({ ...config, apiKey }));
    }
    case "openai-compatible": {
      const apiKey = await getAiProviderApiKey("openai-compatible");
      return resolvedAiFromAdapter(new OpenAiCompatibleProviderAdapter({
        ...config,
        endpoint: settings.localEndpoint || "http://localhost:1234/v1",
        apiKey,
      }));
    }
  }
}
