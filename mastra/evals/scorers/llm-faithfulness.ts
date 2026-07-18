/**
 * Model-graded faithfulness scorer (LLM-as-judge).
 *
 * Unlike the other scorers in this folder (deterministic, rule-based), this
 * one asks a *local* LLM to judge whether an agent's answer is grounded in
 * the source context it was given — i.e. does it invent numbers, corners, or
 * claims that contradict / aren't supported by the telemetry/prompt the agent
 * actually saw?
 *
 * Judge model runs in LM Studio (OpenAI-compatible server). Defaults:
 *   base URL: http://localhost:1234/v1
 *   model:    google/gemma-4-e2b
 * Override with EVAL_JUDGE_BASE_URL / EVAL_JUDGE_MODEL.
 *
 * gemma-4-e2b is tiny (~2B), so the rubric is deliberately near-binary and
 * decoding is grammar-constrained (response_format: json_schema) + temp 0 to
 * keep the verdict stable. Do NOT ask this judge for fine-grained gradients.
 *
 * Works for BOTH:
 *   - lap-analyst  (structured JSON output — stringified before judging)
 *   - setup-engineer (freeform conversational text)
 *
 * `groundTruth.sourceContext` must carry the exact input the agent saw
 * (telemetry summary, prompt, prior turns). Without it the scorer returns 1
 * (nothing to contradict) so it never blocks a run it can't actually grade.
 */
import { createScorer } from "@mastra/core/evals";
import { parseAnalystOutput } from "../../../server/ai/schemas";

const JUDGE_BASE_URL = process.env.EVAL_JUDGE_BASE_URL ?? "http://localhost:1234/v1";
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? "google/gemma-4-e2b";
const JUDGE_API_KEY = process.env.EVAL_JUDGE_API_KEY ?? "lm-studio"; // LM Studio ignores the value

interface JudgeVerdict {
  faithful: boolean;
  contradictions: string[];
}

const JUDGE_JSON_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "faithfulness_verdict",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        faithful: {
          type: "boolean",
          description: "true if every factual claim in the ANSWER is supported by or consistent with the SOURCE",
        },
        contradictions: {
          type: "array",
          items: { type: "string" },
          description: "short list of claims that contradict or aren't supported by the SOURCE (empty if faithful)",
        },
      },
      required: ["faithful", "contradictions"],
    },
  },
} as const;

const SYSTEM_PROMPT =
  `You are a strict grader checking a race-engineering AI answer for faithfulness to its source data. ` +
  `The SOURCE is the telemetry/context the AI was given. The ANSWER is what it produced. ` +
  `Flag a claim ONLY when it clearly contradicts the SOURCE or states a specific number/corner/fact the SOURCE does not support. ` +
  `General coaching advice, tone, and reasonable inference are fine and should NOT be flagged. ` +
  `Reply with JSON only.`;

/** Flatten any agent output (analyst JSON or freeform string) into text. */
function outputToText(output: unknown): string {
  if (typeof output === "string") {
    const parsed = parseAnalystOutput(output);
    if (parsed.success) return stringifyAnalyst(parsed.data);
    return output;
  }
  const parsed = parseAnalystOutput(output);
  if (parsed.success) return stringifyAnalyst(parsed.data);
  return JSON.stringify(output ?? "");
}

function stringifyAnalyst(a: ReturnType<typeof parseAnalystOutput> extends { success: true; data: infer D } ? D : never): string {
  const parts: string[] = [a.verdict];
  for (const m of a.pace) parts.push(`${m.label}: ${m.value} — ${m.detail}`);
  for (const m of a.handling) parts.push(`${m.label}: ${m.value} — ${m.detail}`);
  for (const c of a.corners) parts.push(`${c.name}: ${c.issue} → ${c.fix}`);
  for (const t of a.technique) parts.push(`${t.tip}: ${t.detail}`);
  for (const s of a.setup) parts.push(`${s.component}: ${s.current} → ${s.target} (${s.symptom})`);
  return parts.join("\n");
}

async function judge(source: string, answer: string): Promise<JudgeVerdict> {
  const res = await fetch(`${JUDGE_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${JUDGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      temperature: 0,
      response_format: JUDGE_JSON_SCHEMA,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `SOURCE:\n${source}\n\nANSWER:\n${answer}\n\nIs the ANSWER faithful to the SOURCE?` },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`judge request failed: ${res.status} ${res.statusText} — is LM Studio serving ${JUDGE_MODEL} at ${JUDGE_BASE_URL}?`);
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(content) as Partial<JudgeVerdict>;
  return {
    faithful: parsed.faithful === true,
    contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions : [],
  };
}

// Cache the verdict between generateScore/generateReason for the same run.
const verdictCache = new WeakMap<object, JudgeVerdict>();

/**
 * LLM-as-judge faithfulness scorer. Score is binary: 1.0 faithful, 0.0 not.
 * Requires `groundTruth.sourceContext` (the input the agent saw).
 */
export const llmFaithfulnessScorer = createScorer({
  id: "llm-faithfulness",
  description: "Local LLM judge: is the agent answer grounded in the source context it was given?",
})
  .generateScore(async ({ run }) => {
    const source: string = run.groundTruth?.sourceContext ?? "";
    if (!source.trim()) return 1; // nothing to contradict — don't block

    const answer = outputToText(run.output);
    if (!answer.trim()) return 0;

    const verdict = await judge(source, answer);
    if (run.groundTruth && typeof run.groundTruth === "object") {
      verdictCache.set(run.groundTruth as object, verdict);
    }
    return verdict.faithful ? 1 : 0;
  })
  .generateReason(({ run, score }) => {
    const source: string = run.groundTruth?.sourceContext ?? "";
    if (!source.trim()) return "no sourceContext supplied — faithfulness not graded (default pass)";

    const cached =
      run.groundTruth && typeof run.groundTruth === "object"
        ? verdictCache.get(run.groundTruth as object)
        : undefined;
    if (score >= 1) return "judge: answer is faithful to the source context";
    if (cached && cached.contradictions.length > 0) {
      return `judge flagged unsupported/contradicted claims: ${cached.contradictions.join("; ")}`;
    }
    return "judge: answer not faithful to the source context";
  });
