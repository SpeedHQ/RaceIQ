import { AiProviderError } from "./provider-error";
import { getSecret } from "../runtime/platform/keystore";

export type ConfiguredAiProvider = "gemini" | "openai" | "local";

export async function getAiProviderApiKey(provider: ConfiguredAiProvider): Promise<string | undefined> {
  const key = await getSecret(`${provider}-api-key`);
  return key || undefined;
}
export async function requireAiProviderApiKey(provider: Exclude<ConfiguredAiProvider, "local">): Promise<string> {
  const key = await getAiProviderApiKey(provider);
  if (!key) {
    throw new AiProviderError(`${provider === "gemini" ? "Gemini" : "OpenAI"} API key not set. Configure it in Settings.`, {
      code: "missing-api-key",
      provider,
    });
  }
  return key;
}

export async function configureAiProviderEnvironment(
  provider: ConfiguredAiProvider,
  localEndpoint = "http://localhost:1234/v1",
): Promise<string | undefined> {
  const apiKey = await getAiProviderApiKey(provider);
  if (provider !== "local" && !apiKey) {
    throw new AiProviderError(`${provider === "gemini" ? "Gemini" : "OpenAI"} API key not set. Configure it in Settings.`, {
      code: "missing-api-key",
      provider,
    });
  }
  if (provider === "gemini") {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = apiKey;
    delete process.env.OPENAI_BASE_URL;
  } else if (provider === "openai") {
    process.env.OPENAI_API_KEY = apiKey;
    delete process.env.OPENAI_BASE_URL;
  } else {
    process.env.OPENAI_API_KEY = apiKey || "local";
    process.env.OPENAI_BASE_URL = localEndpoint;
  }
  return apiKey;
}

export const getLocalApiKey = () => getAiProviderApiKey("local");
export const configureLocalOpenAiEnvironment = (endpoint: string) => configureAiProviderEnvironment("local", endpoint);
