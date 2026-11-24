/**
 * Eval-only agent factories.
 *
 * Production agents (`mastra/agents/*`) bind their model to `loadSettings()`
 * so users can swap providers in the UI. Evals need the opposite: a fixed,
 * reproducible model pinned to whatever the eval harness decides. These
 * factories build one-off agents with a pinned model so fixture runs stay
 * deterministic-ish across CI and local runs.
 *
 * Set EVALS_MODEL explicitly; EVALS_PROVIDER defaults to Gemini.
 */
import { Agent } from "@mastra/core/agent";
import { compareEngineerPersona } from "@raceiq/assistant/ai/compare-engineer";
import { DEEPSEEK_AGENT_DEFAULTS, getMastraModelId } from "@raceiq/assistant/mastra/model";
import { getAiProviderApiKey } from "@raceiq/assistant/ai/openai-compatible-provider";

export function resolveEvalProvider(): "gemini" | "openai" | "deepseek" {
  const provider = process.env.EVALS_PROVIDER ?? "gemini";
  if (provider === "gemini" || provider === "openai" || provider === "deepseek") return provider;
  throw new Error(`Unsupported EVALS_PROVIDER: ${provider}`);
}

export function getEvalApiKey(): Promise<string | undefined> {
  return getAiProviderApiKey(resolveEvalProvider());
}

/** Label used in baseline filenames and eval output. */
export function resolveEvalModelId(): string {
  const provider = resolveEvalProvider();
  const model = process.env.EVALS_MODEL?.trim();
  if (!model) throw new Error("EVALS_MODEL must be set to run AI evaluations.");
  if (provider === "gemini") return `google/${model}`;
  if (provider === "openai") return `openai/${model}`;
  return `deepseek/${model}`;
}


const EVAL_LAP_ANALYST_INSTRUCTIONS = `You are a senior race engineer reviewing a single driver's lap from telemetry data. Your job is to issue a structured verdict on the lap covering pace, handling, problem corners, braking, throttle application, and coaching.

Be specific and concrete. Cite numbers where helpful. Refer to the driver as "you". Use the units provided in the prompt.`;

export function buildEvalLapAnalystAgent(apiKey: string): Agent {
  const modelId = resolveEvalModelId();
  if (!apiKey) throw new Error("AI evaluation API key not set. Configure it in Settings.");
  const model = getMastraModelId({ provider: resolveEvalProvider(), model: modelId.slice(modelId.indexOf("/") + 1), apiKey });
  return new Agent({
    id: "eval-lap-analyst",
    name: "Eval Lap Analyst",
    instructions: EVAL_LAP_ANALYST_INSTRUCTIONS,
    model: () => model,
    defaultOptions: DEEPSEEK_AGENT_DEFAULTS,
  });
}

export function buildEvalCompareEngineerAgent(unit: "metric" | "imperial", apiKey: string): Agent {
  const modelId = resolveEvalModelId();
  if (!apiKey) throw new Error("AI evaluation API key not set. Configure it in Settings.");
  const model = getMastraModelId({ provider: resolveEvalProvider(), model: modelId.slice(modelId.indexOf("/") + 1), apiKey });
  return new Agent({
    id: "eval-compare-engineer",
    name: "Eval Compare Engineer",
    instructions: compareEngineerPersona(unit),
    model: () => model,
    defaultOptions: DEEPSEEK_AGENT_DEFAULTS,
  });
}
