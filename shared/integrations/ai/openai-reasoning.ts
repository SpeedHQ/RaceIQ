export const OPENAI_REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type OpenAiReasoningLevel = (typeof OPENAI_REASONING_LEVELS)[number];

export function openAiReasoningEffort(provider: string, level: OpenAiReasoningLevel = "medium"): OpenAiReasoningLevel {
  return provider === "openai" ? level : "medium";
}
