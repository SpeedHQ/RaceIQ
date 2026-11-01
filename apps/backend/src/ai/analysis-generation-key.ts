import { createHash } from "node:crypto";
import { effectiveAnalysisInstructions } from "@raceiq/shared/integrations/ai/analysis-instructions";
import type { AppSettings } from "@raceiq/backend-core/runtime/config/settings";

/** Version whenever backend-owned prompt behavior changes. Never stores raw prompt text. */
export function analysisGenerationKey(kind: "lap" | "compare", settings: AppSettings, lapOrder?: readonly [number, number]): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        revision: 1,
        kind,
        ...(kind === "compare" ? { lapOrder } : {}),
        provider: settings.aiProvider,
        model: settings.aiModel,
        thinkingBudget: settings.aiThinkingBudget,
        endpoint: settings.aiProvider === "openai-compatible" ? settings.localEndpoint : null,
        maxOutputTokens: 8192,
        unit: settings.unit,
        temperatureUnit: settings.temperatureUnit,
        language: settings.language,
        instructions: effectiveAnalysisInstructions(kind, kind === "lap" ? settings.lapAnalysisInstructions : settings.compareAnalysisInstructions),
      }),
    )
    .digest("hex");
}
