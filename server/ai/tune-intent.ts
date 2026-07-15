/**
 * requestTuneIntents — pass 2 of the auto-tune pipeline.
 *
 * Feeds the deterministic symptom report to the configured AI provider and
 * gets back structured `TuneIntent`s (which knob, which way, how much). The
 * model is grammar-constrained to `TuneIntentsSchema` — no free-form numbers.
 * Provider dispatch mirrors the lap-analysis flow (settings.aiProvider +
 * keystore secrets), but uses the low-level `runClaudeCli/runGemini/runOpenAi`
 * helpers directly since we want a single structured turn, not a chat agent.
 */
import type { GameId } from "../../shared/types";
import { loadSettings } from "../settings";
import { getSecret } from "../keystore";
import { runGemini, runOpenAi } from "./providers";
import {
  getTuneIntentJsonSchema,
  parseTuneIntents,
  type TuneIntents,
} from "./schemas";
import { knownComponents } from "./tune-rules";
import type { TuneSymptoms } from "./tune-symptoms";

/** Build the structured prompt embedding the symptom report + allowed knobs. */
export function buildTunePrompt(
  gameId: GameId,
  symptoms: TuneSymptoms,
  trackName?: string,
): string {
  const components = knownComponents(gameId);
  const agg = symptoms.aggregate;

  const cornerLines = symptoms.corners
    .map((c) => {
      const phases = c.phases
        .map(
          (p) =>
            `${p.phase}: ${p.balance}` +
            (p.brakeLockup ? " +lockup" : "") +
            (p.bottoming ? " +bottoming" : ""),
        )
        .join("; ");
      return `  ${c.label} — ${phases}`;
    })
    .join("\n");

  const pressure = agg.tyrePressure
    ? `Tyre pressure delta vs target (psi): FL ${agg.tyrePressure.FL.toFixed(1)}, FR ${agg.tyrePressure.FR.toFixed(1)}, RL ${agg.tyrePressure.RL.toFixed(1)}, RR ${agg.tyrePressure.RR.toFixed(1)}`
    : "Tyre pressure data unavailable for this game.";

  return `You are a race engineer tuning a car in ${gameId.toUpperCase()}${trackName ? ` at ${trackName}` : ""}.

Below is a deterministic symptom report derived from the driver's telemetry.
Recommend setup changes as a list of intents. You may ONLY use these component
names (exact strings) — any other component will be ignored:
${components.map((c) => `  - ${c}`).join("\n")}

For each intent choose a direction ("increase" or "decrease") and a magnitude
("small", "medium", or "large"). Never output raw setup numbers. Prefer a small
number of high-confidence changes over many speculative ones.

=== SYMPTOM REPORT ===
Overall balance: ${agg.balance}
Understeer corners: ${agg.understeerCorners.join(", ") || "none"}
Oversteer corners: ${agg.oversteerCorners.join(", ") || "none"}
Brake lockup corners: ${agg.lockupCorners.join(", ") || "none"}
Suspension bottoming corners: ${agg.bottomingCorners.join(", ") || "none"}
${pressure}

Per-corner detail:
${cornerLines || "  (no corners detected)"}

Respond with JSON matching the schema: { "summary": string, "intents": [ { "component", "direction", "magnitude", "reason" } ] }.`;
}

/**
 * Run the intent request against the configured provider and parse the result.
 * Throws (with a user-facing message) when the provider fails or the model
 * returns unparseable output.
 */
export async function requestTuneIntents(
  gameId: GameId,
  symptoms: TuneSymptoms,
  trackName?: string,
): Promise<{ intents: TuneIntents; model: string }> {
  const settings = loadSettings();
  const prompt = buildTunePrompt(gameId, symptoms, trackName);
  const schema = getTuneIntentJsonSchema();

  let raw: string;
  let model: string;

  switch (settings.aiProvider) {
    case "openai": {
      const key = await getSecret("openai-api-key");
      const r = await runOpenAi(prompt, key, settings.aiModel, schema, "tune_intents");
      raw = r.analysis;
      model = r.usage.model;
      break;
    }
    case "local": {
      // Local OpenAI-compatible endpoint (LM Studio / Ollama).
      const base = settings.localEndpoint || "http://localhost:1234/v1";
      const r = await runOpenAiLocal(prompt, base, settings.aiModel, schema);
      raw = r.analysis;
      model = r.usage.model;
      break;
    }
    default: {
      // gemini (and legacy default)
      const key = await getSecret("gemini-api-key");
      const r = await runGemini(prompt, key, settings.aiModel, schema);
      raw = r.analysis;
      model = r.usage.model;
      break;
    }
  }

  const parsed = parseTuneIntents(raw);
  if (!parsed.success) {
    throw new Error("AI returned an invalid tune-intent response. Try again or switch models.");
  }
  return { intents: parsed.data, model };
}

/** OpenAI-compatible call against a local endpoint (no API key required). */
async function runOpenAiLocal(
  prompt: string,
  baseUrl: string,
  model: string,
  schema: object,
): ReturnType<typeof runOpenAi> {
  // runOpenAi hard-codes the OpenAI host, so hit the local endpoint inline.
  const start = performance.now();
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "tune_intents", strict: true, schema },
      },
      temperature: 0.3,
    }),
  });
  const durationMs = Math.round(performance.now() - start);
  if (!res.ok) throw new Error(`Local model error: ${res.status}`);
  const data = (await res.json()) as any;
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error("Local model returned empty response");
  return {
    analysis: text,
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      costUsd: 0,
      durationMs,
      model,
    },
  };
}
