/**
 * AI provider abstraction — supports Claude CLI and Gemini API.
 */

import { extractJson } from "./extract-json";
import { AiProviderError } from "./provider-error";
import { buildGoogleThinkingProviderOptions } from "./google-provider-options";
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

export type ModelListResult = {
  models: { id: string; name: string; contextLength?: number }[];
  error: string | null;
};



/** Fetch available Gemini models from the API. Filters to generateContent-capable models. */
/** Fetch available Gemini models from the API. Filters to generateContent-capable models. */
export async function getGeminiModelsDetailed(apiKey: string): Promise<ModelListResult> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    console.info(`[AI] GET ${url}`);
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const message = `Gemini models request failed (${res.status} ${res.statusText})${body ? `: ${body.slice(0, 240)}` : ""}`;
      console.warn(`[AI] ${message}`);
      return { models: [], error: message };
    }
    console.info(`[AI] ${res.status} ${res.statusText} ${url}`);
    const data = await res.json() as any;
    const models = (data.models ?? [])
      .filter((m: any) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m: any) => ({
        id: m.name.replace("models/", ""),
        name: m.displayName ?? m.name.replace("models/", ""),
      }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name));
    return { models, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[AI] Gemini models list request errored:", message);
    return { models: [], error: message };
  }
}

export async function getGeminiModels(apiKey: string): Promise<{ id: string; name: string }[]> {
  const result = await getGeminiModelsDetailed(apiKey);
  return result.models;
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

export type GeminiRequestOptions = {
  prompt: string;
  apiKey: string;
  model?: string;
  schema?: object;
  temperature?: number;
  maxOutputTokens?: number;
  thinkingBudget?: number | null;
};

export async function runGeminiRequest(options: GeminiRequestOptions): Promise<AiResult> {
  const model = options.model || "gemini-flash-latest";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${options.apiKey}`;
  const generationConfig: Record<string, unknown> = {
    temperature: options.temperature ?? 0.3,
  };
  if (options.maxOutputTokens != null) generationConfig.maxOutputTokens = options.maxOutputTokens;
  Object.assign(generationConfig, buildGoogleThinkingProviderOptions(model, options.thinkingBudget ?? null));
  if (options.schema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = options.schema;
  }

  const start = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: options.prompt }] }],
      generationConfig,
    }),
  });
  const durationMs = Math.round(performance.now() - start);

  if (!res.ok) {
    const errBody = await res.text();
    console.error("[AI] Gemini API error:", res.status, errBody);
    throw new AiProviderError(
      res.status === 401 || res.status === 403
        ? "Invalid Gemini API key. Check your key in Settings."
        : `Gemini API error: ${res.status}`,
      {
        code: "upstream",
        provider: "gemini",
        modelId: model,
        statusCode: res.status,
        isRetryable: res.status >= 500,
        responseBody: errBody,
      },
    );
  }

  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!text.trim()) throw new Error("Gemini returned empty response");
  const analysis = options.schema ? extractJson(text) : text.trim();
  const usage = data.usageMetadata ?? {};
  return {
    analysis,
    usage: {
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      costUsd: 0,
      durationMs,
      model,
    },
  };
}

/** Run structured analysis via Gemini API. */
export async function runGemini(
  prompt: string,
  apiKey: string,
  model?: string,
  schema: object = ANALYSIS_SCHEMA,
): Promise<AiResult> {
  return runGeminiRequest({ prompt, apiKey, model, schema });
}

export type OpenAiRequestOptions = {
  prompt: string;
  apiKey?: string;
  endpoint?: string;
  model?: string;
  schema?: object;
  schemaName?: string;
  temperature?: number;
  maxOutputTokens?: number;
};

/** Run a request against OpenAI or an OpenAI-compatible endpoint. */
export async function runOpenAiCompatible(options: OpenAiRequestOptions): Promise<AiResult> {
  const model = options.model || "gpt-4o-mini";
  const endpoint = (options.endpoint || "https://api.openai.com/v1").replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: options.prompt }],
    temperature: options.temperature ?? 0.3,
  };
  if (options.maxOutputTokens != null) body.max_tokens = options.maxOutputTokens;
  if (options.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: options.schemaName || "lap_analysis", strict: true, schema: options.schema },
    };
  }

  const start = performance.now();
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const durationMs = Math.round(performance.now() - start);

  if (!res.ok) {
    const errBody = await res.text();
    console.error("[AI] OpenAI-compatible API error:", res.status, errBody);
    throw new AiProviderError(
      res.status === 401
        ? "Invalid OpenAI API key. Check your key in Settings."
        : `OpenAI API error: ${res.status}`,
      {
        code: "upstream",
        provider: endpoint === "https://api.openai.com/v1" ? "openai" : "local",
        modelId: model,
        statusCode: res.status,
        isRetryable: res.status >= 500,
        responseBody: errBody,
      },
    );
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error("OpenAI returned empty response");
  const analysis = options.schema ? extractJson(text) : text.trim();
  const usage = data.usage ?? {};
  return {
    analysis,
    usage: {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      costUsd: 0,
      durationMs,
      model,
    },
  };
}

/** Run structured analysis via OpenAI API. */
export async function runOpenAi(
  prompt: string,
  apiKey: string,
  model?: string,
  schema: object = ANALYSIS_SCHEMA,
  schemaName: string = "lap_analysis",
): Promise<AiResult> {
  return runOpenAiCompatible({ prompt, apiKey, model, schema, schemaName });
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

/** Fetch per-model context lengths from LM Studio's native REST API (`/api/v0/models`).
 * Non-fatal: plain OpenAI-compatible servers (Ollama, llama.cpp) won't have this endpoint —
 * returns an empty map on any failure. */
async function getLmStudioContextLengths(endpoint: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const base = endpoint.replace(/\/+$/, "").replace(/\/v1$/, "");
    const res = await fetch(`${base}/api/v0/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return map;
    const data = await res.json() as any;
    for (const m of data.data ?? []) {
      const ctx = m.loaded_context_length ?? m.max_context_length;
      if (m.id && typeof ctx === "number" && ctx > 0) map.set(m.id, ctx);
    }
  } catch {
    // LM Studio native API unavailable — context lengths simply omitted.
  }
  return map;
}

/** Fetch available models from an OpenAI-compatible local endpoint (LM Studio, Ollama, etc.). */
export async function getLocalModelsDetailed(endpoint: string): Promise<ModelListResult> {
  try {
    const url = endpoint.replace(/\/+$/, "") + "/models";
    console.info(`[AI] GET ${url}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    console.info(`[AI] ${res.status} ${res.statusText} ${url}`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const message = `Local models request failed (${res.status} ${res.statusText})${body ? `: ${body.slice(0, 240)}` : ""}`;
      console.warn(`[AI] ${message}`);
      return { models: [], error: message };
    }
    const data = await res.json() as any;
    const contextByModel = await getLmStudioContextLengths(endpoint);
    return {
      models: (data.data ?? []).map((m: any) => ({
        id: m.id,
        name: m.id,
        contextLength: contextByModel.get(m.id),
      })),
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[AI] Local models list request errored:", message);
    return { models: [], error: message };
  }
}

export async function getLocalModels(endpoint: string): Promise<{ id: string; name: string }[]> {
  const result = await getLocalModelsDetailed(endpoint);
  return result.models;
}
