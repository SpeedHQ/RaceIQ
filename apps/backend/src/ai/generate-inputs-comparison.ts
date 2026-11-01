import { z } from "zod";
import type { AppSettings } from "@raceiq/backend-core/runtime/config/settings";
import type { ResolvedAi } from "@raceiq/backend-core/ai/ai-types";
import { compareEngineerPersona } from "@raceiq/backend-core/ai/compare-engineer";
import { InputsCompareSchema } from "@raceiq/backend-core/ai/inputs-compare-prompt";
import { buildGoogleThinkingProviderOptions } from "@raceiq/backend-core/ai/google-provider-options";
import { runAiStructured } from "./model-provider";

/** One provider boundary for direct Codex and existing tool-capable Mastra models. */
export async function generateInputsComparison(ai: ResolvedAi, prompt: string, settings: AppSettings, generateMastra: (prompt: string, options: Record<string, unknown>) => Promise<unknown>) {
  const result = await runAiStructured(
    ai,
    {
      system: compareEngineerPersona(settings.unit, settings.temperatureUnit, settings.language, { json: true }),
      prompt,
      schema: z.toJSONSchema(InputsCompareSchema),
      schemaName: "inputs_comparison",
      maxOutputTokens: 8192,
      temperature: 0,
    },
    (requestContext) =>
      generateMastra(prompt, {
        requestContext,
        structuredOutput: {
          schema: InputsCompareSchema,
          ...(ai.provider === "openai-compatible" || ai.provider === "anthropic" ? { jsonPromptInjection: true } : {}),
        },
        modelSettings: { maxOutputTokens: 8192, temperature: 0 },
        providerOptions: {
          openai: { reasoningEffort: "medium" },
          google: buildGoogleThinkingProviderOptions(ai.model, settings.aiThinkingBudget),
        },
      }),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.analysis);
  } catch {
    throw new Error("Compare engineer returned invalid JSON. Not cached.");
  }
  const checked = InputsCompareSchema.safeParse(parsed);
  if (!checked.success) throw new Error("Compare engineer returned invalid comparison structure. Not cached.");
  return { ...result, object: checked.data };
}
