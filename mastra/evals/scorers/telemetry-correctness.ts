/**
 * Local LLM judge for numerical telemetry correctness.
 * Unlike faithfulness, this scorer never passes when fixture truth is absent.
 */
import { createScorer } from "@mastra/core/evals";

const JUDGE_BASE_URL = process.env.EVAL_JUDGE_BASE_URL ?? "http://localhost:1234/v1";
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? "google/gemma-4-e2b";
const JUDGE_API_KEY = process.env.EVAL_JUDGE_API_KEY ?? "lm-studio";

interface JudgeVerdict {
  correct: boolean;
  errors: string[];
}

const JUDGE_JSON_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "telemetry_correctness_verdict",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        correct: { type: "boolean" },
        errors: { type: "array", items: { type: "string" } },
      },
      required: ["correct", "errors"],
    },
  },
} as const;

const SYSTEM_PROMPT =
  "You are a strict race-telemetry correctness judge. Compare ANSWER against AUTHORITATIVE TELEMETRY TRUTH and SOURCE CONTEXT. " +
  "Check every numerical telemetry value, units, named corners, lap direction, and unsupported claim. " +
  "Reject invented, contradictory, or unit-mismatched facts. General advice is acceptable only when it does not assert unsupported telemetry. " +
  "Return JSON only: correct is true only when all factual telemetry claims are supported, and errors lists concrete problems.";

function outputToText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return "";
  }
}

async function judge(source: string, answer: string): Promise<JudgeVerdict> {
  const response = await fetch(`${JUDGE_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${JUDGE_API_KEY}` },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      temperature: 0,
      response_format: JUDGE_JSON_SCHEMA,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `AUTHORITATIVE TELEMETRY TRUTH AND SOURCE CONTEXT:\n${source}\n\nANSWER:\n${answer}` },
      ],
    }),
  });
  if (!response.ok) throw new Error(`judge request failed: ${response.status} ${response.statusText}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("judge response missing JSON content");
  const parsed = JSON.parse(content) as Partial<JudgeVerdict>;
  if (typeof parsed.correct !== "boolean" || !Array.isArray(parsed.errors) || parsed.errors.some((e) => typeof e !== "string")) {
    throw new Error("judge response has invalid verdict JSON");
  }
  return { correct: parsed.correct, errors: parsed.errors };
}

const verdictCache = new WeakMap<object, JudgeVerdict>();

export const telemetryCorrectnessScorer = createScorer({
  id: "telemetry-correctness",
  description: "Local LLM judge: validates telemetry values, units, corners, direction, and unsupported claims against fixture truth.",
})
  .generateScore(async ({ run }) => {
    const truth = run.groundTruth && typeof run.groundTruth === "object"
      ? (run.groundTruth as Record<string, unknown>).truth
      : undefined;
    const sourceContext = run.groundTruth && typeof run.groundTruth === "object"
      ? (run.groundTruth as Record<string, unknown>).sourceContext
      : undefined;
    if (truth === undefined || truth === null) return 0;
    if (typeof sourceContext !== "string" || !sourceContext.trim()) return 0;
    const answer = outputToText(run.output);
    if (!answer.trim()) return 0;
    try {
      const verdict = await judge(JSON.stringify({ truth, sourceContext }), answer);
      if (run.groundTruth && typeof run.groundTruth === "object") verdictCache.set(run.groundTruth, verdict);
      return verdict.correct ? 1 : 0;
    } catch {
      return 0;
    }
  })
  .generateReason(({ run, score }) => {
    const truth = run.groundTruth && typeof run.groundTruth === "object" ? (run.groundTruth as Record<string, unknown>).truth : undefined;
    const source = run.groundTruth && typeof run.groundTruth === "object" ? (run.groundTruth as Record<string, unknown>).sourceContext : undefined;
    if (truth === undefined || truth === null) return "telemetry correctness failed: missing groundTruth.truth";
    if (typeof source !== "string" || !source.trim()) return "telemetry correctness failed: missing groundTruth.sourceContext";
    if (!outputToText(run.output).trim()) return "telemetry correctness failed: empty output";
    const cached = run.groundTruth && typeof run.groundTruth === "object" ? verdictCache.get(run.groundTruth) : undefined;
    if (cached?.errors.length) return `telemetry judge found errors: ${cached.errors.join("; ")}`;
    return score >= 1 ? "telemetry judge: answer matches authoritative telemetry truth" : "telemetry correctness failed: judge request or JSON verdict failed";
  });
