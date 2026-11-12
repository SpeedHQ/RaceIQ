import { AiProviderError } from "./provider-error";
import { AI_PROVIDERS, type AiProvider } from "./ai-features";
import { isSupportedAiProvider } from "./provider-capabilities";
import { getSecret } from "@raceiq/backend-core/runtime/platform/keystore";

export type ConfiguredAiProvider = AiProvider;


export async function getAiProviderApiKey(provider: ConfiguredAiProvider): Promise<string | undefined> {
  if (!isSupportedAiProvider(provider)) {
    throw new AiProviderError(`Unsupported AI provider: ${provider}`, { code: "unsupported-provider", provider });
  }
  const key = await getSecret(`${provider}-api-key`);
  return key || undefined;
}
export async function requireAiProviderApiKey(provider: Exclude<ConfiguredAiProvider, "openai-compatible">): Promise<string> {
  const key = await getAiProviderApiKey(provider);
  if (!key) {
    throw new AiProviderError(`${AI_PROVIDERS[provider].label} API key not set. Configure it in Settings.`, {
      code: "missing-api-key",
      provider,
    });
  }
  return key;
}

export async function configureAiProviderEnvironment(
  provider: ConfiguredAiProvider,
  _localEndpoint = "http://localhost:1234/v1",
): Promise<string | undefined> {
  const apiKey = await getAiProviderApiKey(provider);
  if (provider !== "openai-compatible" && !apiKey) {
    throw new AiProviderError(`${AI_PROVIDERS[provider].label} API key not set. Configure it in Settings.`, {
      code: "missing-api-key",
      provider,
    });
  }
  // Model callbacks resolve credentials from the keystore, not process.env.
  return apiKey;
}

export const getLocalApiKey = () => getAiProviderApiKey("openai-compatible");
export const configureLocalOpenAiEnvironment = (endpoint: string) => configureAiProviderEnvironment("openai-compatible", endpoint);
