/**
 * AI provider abstraction — supports Claude CLI and Gemini API.
 */

export interface AiResult {
  analysis: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number;
    model: string;
  };
}

export type AiProvider = "claude-cli" | "gemini" | "openai" | "local";

const CLAUDE_MODELS = [
  { id: "haiku", name: "Claude Haiku" },
  { id: "sonnet", name: "Claude Sonnet" },
  { id: "opus", name: "Claude Opus" },
];

export function getClaudeModels() {
  return CLAUDE_MODELS;
}

/** Fetch available Gemini models from the API. Filters to generateContent-capable models. */
export async function getGeminiModels(apiKey: string): Promise<{ id: string; name: string }[]> {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.models ?? [])
      .filter((m: any) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m: any) => ({
        id: m.name.replace("models/", ""),
        name: m.displayName ?? m.name.replace("models/", ""),
      }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Run analysis via Claude CLI (pipe mode). */
export async function runClaudeCli(prompt: string, model?: string): Promise<AiResult> {
  const m = model || "haiku";
  const proc = Bun.spawn(
    ["claude", "-p", "-", "--model", m, "--output-format", "json"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  proc.stdin.write(prompt);
  proc.stdin.end();

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; proc.kill(); }, 90_000);
  const exitCode = await proc.exited;
  clearTimeout(timeout);

  if (timedOut) throw new Error("Analysis timed out");
  if (exitCode !== 0) {
    const stderr = await stderrPromise;
    console.error("[AI] Claude CLI failed:", stderr);
    throw new Error("AI analysis failed. Is Claude CLI installed and authenticated?");
  }

  const raw = await stdoutPromise;
  if (!raw.trim()) throw new Error("AI returned empty response");

  const envelope = JSON.parse(raw.trim());
  const resultText = envelope.result ?? "";
  if (!resultText.trim()) throw new Error("AI returned empty result");

  const jsonStr = extractJson(resultText);

  return {
    analysis: jsonStr,
    usage: {
      inputTokens:
        (envelope.usage?.input_tokens ?? 0) +
        (envelope.usage?.cache_read_input_tokens ?? 0) +
        (envelope.usage?.cache_creation_input_tokens ?? 0),
      outputTokens: envelope.usage?.output_tokens ?? 0,
      costUsd: envelope.total_cost_usd ?? 0,
      durationMs: envelope.duration_ms ?? 0,
      model: Object.keys(envelope.modelUsage ?? {})[0] ?? "claude-haiku",
    },
  };
}

// JSON schema for structured output — enforced by the API, not just the prompt
const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", description: "2-3 sentences assessing overall lap quality, pace, and where the biggest time gains are" },
    pace: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          value: { type: "string" },
          assessment: { type: "string", enum: ["good", "warning", "critical"] },
          detail: { type: "string" },
        },
        required: ["label", "value", "assessment", "detail"],
      },
    },
    handling: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          value: { type: "string" },
          assessment: { type: "string", enum: ["good", "warning", "critical"] },
          detail: { type: "string" },
        },
        required: ["label", "value", "assessment", "detail"],
      },
    },
    corners: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          issue: { type: "string" },
          fix: { type: "string" },
          severity: { type: "string", enum: ["minor", "moderate", "major"] },
        },
        required: ["name", "issue", "fix", "severity"],
      },
    },
    technique: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tip: { type: "string" },
          detail: { type: "string" },
        },
        required: ["tip", "detail"],
      },
    },
    setup: {
      type: "array",
      items: {
        type: "object",
        properties: {
          change: { type: "string" },
          symptom: { type: "string" },
          fix: { type: "string" },
        },
        required: ["change", "symptom", "fix"],
      },
    },
    tuning: {
      type: "array",
      items: {
        type: "object",
        properties: {
          component: { type: "string" },
          current: { type: "string" },
          direction: { type: "string", enum: ["increase", "decrease", "adjust"] },
          target: { type: "string" },
          reason: { type: "string" },
        },
        required: ["component", "current", "direction", "target", "reason"],
      },
    },
  },
  required: ["verdict", "pace", "handling", "corners", "technique", "setup", "tuning"],
};

/** Run analysis via Gemini API. */
export async function runGemini(prompt: string, apiKey: string, model?: string): Promise<AiResult> {
  model = model || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const start = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: ANALYSIS_SCHEMA,
        temperature: 0.3,
      },
    }),
  });

  const durationMs = Math.round(performance.now() - start);

  if (!res.ok) {
    const errBody = await res.text();
    console.error("[AI] Gemini API error:", res.status, errBody);
    if (res.status === 401 || res.status === 403) {
      throw new Error("Invalid Gemini API key. Check your key in Settings.");
    }
    throw new Error(`Gemini API error: ${res.status}`);
  }

  const data = await res.json() as any;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!text.trim()) throw new Error("Gemini returned empty response");

  const jsonStr = extractJson(text);

  const usage = data.usageMetadata ?? {};
  return {
    analysis: jsonStr,
    usage: {
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      costUsd: 0, // Gemini Flash pricing is negligible
      durationMs,
      model,
    },
  };
}

/** Extract and validate JSON from an AI response (strips markdown fences if present). */
function extractJson(text: string): string {
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  JSON.parse(jsonStr); // validate — throws if invalid
  return jsonStr;
}

const OPENAI_MODELS = [
  { id: "gpt-4o-mini", name: "GPT-4o Mini" },
  { id: "gpt-4o", name: "GPT-4o" },
  { id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
  { id: "gpt-4.1-nano", name: "GPT-4.1 Nano" },
];

export function getOpenAiModels() {
  return OPENAI_MODELS;
}

/** Fetch available models from an OpenAI-compatible local endpoint (LM Studio, Ollama, etc.). */
export async function getLocalModels(endpoint: string): Promise<{ id: string; name: string }[]> {
  try {
    const url = endpoint.replace(/\/+$/, "") + "/models";
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.data ?? []).map((m: any) => ({
      id: m.id,
      name: m.id,
    }));
  } catch {
    return [];
  }
}
