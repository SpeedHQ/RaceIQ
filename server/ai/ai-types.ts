import type { AiFeature, AiProvider } from "./ai-features";

export type { AiFeature, AiProvider } from "./ai-features";

export type AiUsage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  model: string;
};

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
};

export interface ResolvedAi {
  feature: AiFeature;
  provider: AiProvider;
  model: string;
  generateText(input: TextRequest): Promise<AiResult>;
  generateStructured<T>(input: StructuredRequest<T>): Promise<AiResult>;
  createChatResponse?(input: ChatRequest): Promise<Response>;
}
