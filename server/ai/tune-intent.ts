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
import { formatTireTempSymptoms } from "./tune-tire-symptoms";
import { formatDamperSymptoms } from "./tune-damper-symptoms";
import { formatWeightTransferSymptoms } from "./tune-weight-transfer";

/** Render the deterministic symptom report as compact prompt text. Shared by the
 *  telemetry-driven and chat-driven intent prompts. */
function renderSymptomReport(symptoms: TuneSymptoms): string {
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
      const lltd =
        c.load?.lltdFront != null ? ` [LLTD ${(c.load.lltdFront * 100).toFixed(0)}% front]` : "";
      return `  ${c.label} — ${phases}${lltd}`;
    })
    .join("\n");

  const pressure = agg.tyrePressure
    ? `Tyre pressure delta vs target (psi): FL ${agg.tyrePressure.FL.toFixed(1)}, FR ${agg.tyrePressure.FR.toFixed(1)}, RL ${agg.tyrePressure.RL.toFixed(1)}, RR ${agg.tyrePressure.RR.toFixed(1)}`
    : "Tyre pressure data unavailable for this game.";

  return `Overall balance: ${agg.balance}
Understeer corners: ${agg.understeerCorners.join(", ") || "none"}
Oversteer corners: ${agg.oversteerCorners.join(", ") || "none"}
Brake lockup corners: ${agg.lockupCorners.join(", ") || "none"}
Suspension bottoming corners: ${agg.bottomingCorners.join(", ") || "none"}
${pressure}
${formatTireTempSymptoms(agg.tyreTemp)}
${formatDamperSymptoms(agg.damper)}
${formatWeightTransferSymptoms(agg.weightTransfer)}

Per-corner detail:
${cornerLines || "  (no corners detected)"}`;
}

/** Build the structured prompt embedding the symptom report + allowed knobs. */
export function buildTunePrompt(
  gameId: GameId,
  symptoms: TuneSymptoms,
  trackName?: string,
  carModel?: string,
): string {
  const components = knownComponents(gameId, carModel);

  return `You are a race engineer tuning a car in ${gameId.toUpperCase()}${trackName ? ` at ${trackName}` : ""}.

Below is a deterministic symptom report derived from the driver's telemetry.
Recommend setup changes as a list of intents. You may ONLY use these component
names (exact strings) — any other component will be ignored:
${components.map((c) => `  - ${c}`).join("\n")}

For each intent choose a direction ("increase" or "decrease") and a magnitude
("small", "medium", or "large"). Never output raw setup numbers. Prefer a small
number of high-confidence changes over many speculative ones.

=== SYMPTOM REPORT ===
${renderSymptomReport(symptoms)}

Respond with JSON matching the schema: { "summary": string, "intents": [ { "component", "direction", "magnitude", "reason" } ] }.`;
}

/**
 * Build the intent prompt for the PRE-DRIVE "Generate setup from chat" flow.
 *
 * No telemetry required: the driver's stated feel in the conversation (plus the
 * current setup values as evidence, and the symptom report when a lap exists)
 * drives the picks. Same guardrail as `buildTunePrompt` — the model names a
 * component + direction + magnitude only; the deterministic rules own the clicks.
 */
export function buildTuneChatIntentPrompt(
  gameId: GameId,
  opts: {
    conversation: string;
    currentSetupSummary: string | null;
    symptoms?: TuneSymptoms | null;
    trackName?: string;
    carModel?: string;
  },
): string {
  const components = knownComponents(gameId, opts.carModel);

  const setupBlock = opts.currentSetupSummary
    ? `\n=== CURRENT SETUP VALUES (evidence only — do NOT echo these back as targets) ===\n${opts.currentSetupSummary}\n`
    : "";
  const symptomBlock = opts.symptoms
    ? `\n=== TELEMETRY SYMPTOM REPORT (from a driven lap) ===\n${renderSymptomReport(opts.symptoms)}\n`
    : "";

  return `You are a GT3 / endurance race engineer tuning a car in ${gameId.toUpperCase()}${opts.trackName ? ` at ${opts.trackName}` : ""}.

The driver has been discussing how the car feels in the conversation below. Turn
that discussion — together with the current setup values and any telemetry — into
concrete setup CHANGES expressed as intents.

You may ONLY use these component names (exact strings) — any other component is
ignored:
${components.map((c) => `  - ${c}`).join("\n")}

For each intent choose a direction ("increase" or "decrease") and a magnitude
("small", "medium", or "large"), with a one-line reason tied to what the driver
said. NEVER output raw setup numbers — a deterministic engine converts your
intents into exact clicks. Prefer a few high-confidence changes driven by the
driver's stated feel over many speculative ones. If the conversation gives no
actionable direction, return an empty intents array.
${setupBlock}${symptomBlock}
=== CONVERSATION (oldest first) ===
${opts.conversation}

Respond with JSON matching the schema: { "summary": string, "intents": [ { "component", "direction", "magnitude", "reason" } ] }.`;
}

/**
 * Dispatch a single grammar-constrained intent turn to the configured auto-tune
 * provider. Shared by `requestTuneIntents` (telemetry) and
 * `requestTuneIntentsFromChat` (conversation) so the provider plumbing lives in
 * one place. Returns the raw model text + resolved model id.
 */
async function runTuneIntentProvider(
  prompt: string,
  schema: object,
): Promise<{ raw: string; model: string }> {
  const settings = loadSettings();

  // Auto-tune has its own provider/model so the user can point it at a
  // different model than lap analysis. Fall back to the shared analysis
  // provider for settings written before auto-tune had its own entry.
  const provider = settings.autoTuneProvider || settings.aiProvider;
  const tuneModel = settings.autoTuneModel || settings.aiModel;

  switch (provider) {
    case "openai": {
      const key = await getSecret("openai-api-key");
      const r = await runOpenAi(prompt, key, tuneModel, schema, "tune_intents");
      return { raw: r.analysis, model: r.usage.model };
    }
    case "local": {
      // Local OpenAI-compatible endpoint (LM Studio / Ollama).
      const base = settings.localEndpoint || "http://localhost:1234/v1";
      const r = await runOpenAiLocal(prompt, base, tuneModel, schema);
      return { raw: r.analysis, model: r.usage.model };
    }
    default: {
      // gemini (and legacy default)
      const key = await getSecret("gemini-api-key");
      const r = await runGemini(prompt, key, tuneModel, schema);
      return { raw: r.analysis, model: r.usage.model };
    }
  }
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
  carModel?: string,
): Promise<{ intents: TuneIntents; model: string }> {
  const prompt = buildTunePrompt(gameId, symptoms, trackName, carModel);
  const { raw, model } = await runTuneIntentProvider(prompt, getTuneIntentJsonSchema());

  const parsed = parseTuneIntents(raw);
  if (!parsed.success) {
    throw new Error("AI returned an invalid tune-intent response. Try again or switch models.");
  }
  return { intents: parsed.data, model };
}

/**
 * Pre-drive intent request: propose setup intents from the setup CHAT
 * conversation + current setup values (and telemetry symptoms when a lap
 * exists). No stint required — this is how the driver tunes from feel before
 * running a lap. The LLM only names component + direction + magnitude; the
 * deterministic `applyIntents` rules still own every click (parity §4d).
 */
export async function requestTuneIntentsFromChat(
  gameId: GameId,
  opts: {
    conversation: string;
    currentSetupSummary: string | null;
    symptoms?: TuneSymptoms | null;
    trackName?: string;
    carModel?: string;
  },
): Promise<{ intents: TuneIntents; model: string }> {
  const prompt = buildTuneChatIntentPrompt(gameId, opts);
  const { raw, model } = await runTuneIntentProvider(prompt, getTuneIntentJsonSchema());

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
