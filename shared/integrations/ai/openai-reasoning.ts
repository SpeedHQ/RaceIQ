export const OPENAI_REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type OpenAiReasoningLevel = (typeof OPENAI_REASONING_LEVELS)[number];

export function openAiReasoningEffort(provider: string, level: OpenAiReasoningLevel = "medium"): OpenAiReasoningLevel {
  return provider === "openai" ? level : "medium";
}

const standardSubscriptionEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
const optionalSubscriptionEfforts = ["none", ...standardSubscriptionEfforts] as const;

export function chatGptReasoningLevels(model: string): readonly OpenAiReasoningLevel[] {
  switch (model) {
    case "gpt-6.2-sol":
    case "gpt-6.2-astra":
    case "gpt-6.1-sol":
    case "gpt-6-astra":
      return standardSubscriptionEfforts;
    case "gpt-6.1-terra":
    case "gpt-6-sol":
    case "gpt-6-luna":
      return optionalSubscriptionEfforts;
    default:
      return [];
  }
}
