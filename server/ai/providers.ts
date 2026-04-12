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

export type AiProvider = "gemini" | "openai" | "local";

const AI_PROVIDERS = [
  { id: "gemini", name: "Google Gemini" },
  { id: "openai", name: "OpenAI" },
  { id: "local", name: "Local (LM Studio / Ollama)" },
];

export function getProviders() {
  return AI_PROVIDERS;
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

// JSON schema for structured output — used by Gemini and OpenAI
export const ANALYSIS_SCHEMA = {
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
    braking: {
      type: "array",
      items: {
        type: "object",
        properties: {
          corner: { type: "string" },
          assessment: { type: "string", enum: ["good", "warning", "critical"] },
          brakePoint: { type: "string" },
          detail: { type: "string" },
        },
        required: ["corner", "assessment", "brakePoint", "detail"],
      },
    },
    throttle: {
      type: "array",
      items: {
        type: "object",
        properties: {
          corner: { type: "string" },
          assessment: { type: "string", enum: ["good", "warning", "critical"] },
          throttlePoint: { type: "string" },
          detail: { type: "string" },
        },
        required: ["corner", "assessment", "throttlePoint", "detail"],
      },
    },
    coaching: {
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
          component: { type: "string", description: "Setup component name (e.g. Front Springs, Rear ARB)" },
          symptom: { type: "string", description: "What the telemetry shows (e.g. rear instability under braking)" },
          fix: { type: "string", description: "What to change and why" },
          current: { type: "string", description: "Current numeric value with unit (e.g. '750 lb/in', '2.5 deg', '52%'). MUST include a number." },
          target: { type: "string", description: "Suggested numeric target with unit (e.g. '650 lb/in', '1.8 deg', '48%'). MUST include a number." },
          direction: { type: "string", enum: ["increase", "decrease", "adjust"] },
        },
        required: ["component", "symptom", "fix", "current", "target", "direction"],
      },
    },
  },
  required: ["verdict", "pace", "handling", "corners", "braking", "throttle", "coaching", "setup"],
};

/**
 * JSON schema for the per-segment inputs-comparison analysis.
 * Matches the `InputsAnalysis` shape consumed by CompareAiPanel.
 */
export const INPUTS_COMPARE_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", description: "1-2 sentence top-line summary of input differences." },
    segments: {
      type: "array",
      description: "ONE entry per track segment, in the order given by the prompt. MUST NOT be empty.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Segment name from the prompt's segment list." },
          type: { type: "string", enum: ["corner", "straight"] },
          deltaSeconds: { type: "number", description: "Lap A time minus Lap B time for this segment, in seconds. Positive = A slower." },
          throttle: { type: "string", description: "1 sentence on throttle differences." },
          brake: { type: "string", description: "1 sentence on brake differences." },
          steering: { type: "string", description: "1 sentence on steering differences." },
          severity: { type: "string", enum: ["minor", "moderate", "major"] },
        },
        required: ["name", "type", "deltaSeconds", "throttle", "brake", "steering", "severity"],
      },
    },
    coaching: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tip: { type: "string", description: "Actionable change in 1 sentence." },
          detail: { type: "string", description: "Why and how, 1-2 sentences." },
          targetLap: { type: "string", enum: ["A", "B"] },
        },
        required: ["tip", "detail", "targetLap"],
      },
    },
  },
  required: ["verdict", "segments", "coaching"],
};

/** Run analysis via Gemini API. */
export async function runGemini(
  prompt: string,
  apiKey: string,
  model?: string,
  schema: object = ANALYSIS_SCHEMA,
): Promise<AiResult> {
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
        responseSchema: schema,
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

/** Run analysis via OpenAI API. */
export async function runOpenAi(
  prompt: string,
  apiKey: string,
  model?: string,
  schema: object = ANALYSIS_SCHEMA,
  schemaName: string = "lap_analysis",
): Promise<AiResult> {
  model = model || "gpt-4o-mini";
  const start = performance.now();
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: { name: schemaName, strict: true, schema },
      },
      temperature: 0.3,
    }),
  });
  const durationMs = Math.round(performance.now() - start);

  if (!res.ok) {
    const errBody = await res.text();
    console.error("[AI] OpenAI API error:", res.status, errBody);
    if (res.status === 401) throw new Error("Invalid OpenAI API key. Check your key in Settings.");
    throw new Error(`OpenAI API error: ${res.status}`);
  }

  const data = await res.json() as any;
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error("OpenAI returned empty response");

  const jsonStr = extractJson(text);
  const usage = data.usage ?? {};
  return {
    analysis: jsonStr,
    usage: {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      costUsd: 0,
      durationMs,
      model,
    },
  };
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
