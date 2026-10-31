import type { AiFeature, AiProvider } from "./ai-features";
import type { AiUsage } from "@raceiq/shared/integrations/ai/usage";

export type { AiFeature, AiProvider } from "./ai-features";

export type { AiUsage } from "@raceiq/shared/integrations/ai/usage";

/** Provider-neutral result retained by existing analysis consumers. */
export type AiResult = {
  analysis: string;
  usage: AiUsage;
};

export type TextRequest = {
  prompt: string;
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  thinkingBudget?: number | null;
};

export type StructuredRequest<T> = TextRequest & {
  schema: T;
  schemaName?: string;
};

export type ChatMessage = {
  role: string;
  content: unknown;
};

export type ChatRequest = {
  systemPrompt: string;
  messages: readonly ChatMessage[];
  onAssistantResponse?: (text: string) => void | Promise<void>;
};

export interface ResolvedAi {
  feature: AiFeature;
  provider: AiProvider;
  model: string;
  generateText(input: TextRequest): Promise<AiResult>;
  generateStructured<T>(input: StructuredRequest<T>): Promise<AiResult>;
}
