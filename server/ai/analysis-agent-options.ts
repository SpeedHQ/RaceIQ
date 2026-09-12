import { buildGoogleProviderOptions } from "./google-provider-options";
import { buildGoogleThinkingProviderOptions } from "./google-provider-options";
import { getAnalystJsonSchema } from "./schemas";
import { InputsCompareSchema } from "./inputs-compare-prompt";

export function buildLapAnalystExecutionOptions(input: {
  provider: string;
  model: string;
  thinkingBudget?: number;
}): Record<string, unknown> {
  const schema = getAnalystJsonSchema();
  return {
    maxSteps: 5,
    modelSettings: { maxOutputTokens: 8192, temperature: 0 },
    providerOptions: {
      openai: {
        reasoningEffort: "medium",
        responseFormat: { type: "json_schema", jsonSchema: { name: "analyst_output", strict: true, schema } },
      },
      google: buildGoogleProviderOptions(input.model, schema, input.thinkingBudget),
    },
  };
}

export function buildCompareEngineerExecutionOptions(input: {
  provider: string;
  model: string;
  thinkingBudget?: number;
}): Record<string, unknown> {
  return {
    structuredOutput: {
      schema: InputsCompareSchema,
      ...(input.provider === "local" ? { jsonPromptInjection: true } : {}),
    },
    modelSettings: { maxOutputTokens: 8192, temperature: 0 },
    providerOptions: {
      openai: { reasoningEffort: "medium" },
      google: buildGoogleThinkingProviderOptions(input.model, input.thinkingBudget),
    },
  };
}
