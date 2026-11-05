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
import { compareEngineerPersona } from "@raceiq/backend-core/ai/compare-engineer";
import { DEEPSEEK_AGENT_DEFAULTS } from "../model";

/** Label used in baseline filenames and eval output. */
export function resolveEvalModelId(): string {
  const provider = process.env.EVALS_PROVIDER ?? "gemini";
  const model = process.env.EVALS_MODEL?.trim();
  if (!model) throw new Error("EVALS_MODEL must be set to run AI evaluations.");
  if (provider === "gemini") return `google/${model}`;
  if (provider === "openai") return `openai/${model}`;
  if (provider === "deepseek") return `deepseek/${model}`;
  throw new Error(`Unsupported EVALS_PROVIDER: ${provider}`);
}


const EVAL_LAP_ANALYST_INSTRUCTIONS = `You are a senior race engineer reviewing a single driver's lap from telemetry data. Your job is to issue a structured verdict on the lap covering pace, handling, problem corners, braking, throttle application, and coaching.

Be specific and concrete. Cite numbers where helpful. Refer to the driver as "you". Use the units provided in the prompt.`;

export function buildEvalLapAnalystAgent(): Agent {
  const modelId = resolveEvalModelId();
  return new Agent({
    id: "eval-lap-analyst",
    name: "Eval Lap Analyst",
    instructions: EVAL_LAP_ANALYST_INSTRUCTIONS,
    model: () => modelId,
    defaultOptions: DEEPSEEK_AGENT_DEFAULTS,
  });
}

export function buildEvalCompareEngineerAgent(unit: "metric" | "imperial" = "metric"): Agent {
  const modelId = resolveEvalModelId();
  return new Agent({
    id: "eval-compare-engineer",
    name: "Eval Compare Engineer",
    instructions: compareEngineerPersona(unit),
    model: () => modelId,
    defaultOptions: DEEPSEEK_AGENT_DEFAULTS,
  });
}
