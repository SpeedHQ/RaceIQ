import { getSecret } from "../keystore";
import { loadSettings, type AppSettings } from "../settings";
import { AI_FEATURES, type AiFeature, type AiProvider } from "./ai-features";
import {
  AiProviderError,
} from "./provider-error";
import {
  CodexProviderAdapter,
  GeminiProviderAdapter,
  LocalProviderAdapter,
  OpenAiProviderAdapter,
  resolvedAiFromAdapter,
} from "./provider-adapters";
import type { ResolvedAi } from "./ai-types";

export type { AiFeature, AiProvider, ResolvedAi } from "./ai-types";

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

function fallbackModel(provider: AiProvider): string {
  switch (provider) {
    case "gemini": return "gemini-flash-latest";
    case "openai": return "gpt-4o-mini";
    case "local": return "local-model";
    case "codex": return "codex";
  }
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
  if (provider !== "gemini" && provider !== "openai" && provider !== "local" && provider !== "codex") {
    throw new AiProviderError(`Unsupported AI provider: ${selected.provider}`, {
      code: "unsupported-provider",
      provider: selected.provider,
    });
  }

  const model = selected.model.trim() || fallbackModel(provider);
  const config = { feature, model, thinkingBudget: selected.thinkingBudget };
  switch (provider) {
    case "gemini": {
      const apiKey = await getSecret("gemini-api-key");
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
      const apiKey = await getSecret("openai-api-key");
      if (!apiKey) {
        throw new AiProviderError(`OpenAI API key not set. Add it in Settings → AI ${section}.`, {
          code: "missing-api-key",
          provider,
          modelId: model,
        });
      }
      return resolvedAiFromAdapter(new OpenAiProviderAdapter({ ...config, apiKey }));
    }
    case "local":
      return resolvedAiFromAdapter(new LocalProviderAdapter({
        ...config,
        endpoint: settings.localEndpoint || "http://localhost:1234/v1",
      }));
    case "codex":
      return resolvedAiFromAdapter(new CodexProviderAdapter(config));
  }
}
