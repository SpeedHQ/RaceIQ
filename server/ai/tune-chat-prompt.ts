/**
 * System prompt for the tuning-session setup chat (plan Phase D).
 *
 * A setup-scoped conversation the driver has *before* asking for the next tune:
 * the AI is a race engineer discussing THIS car+track setup. It reasons over
 *   - the current setup values (summarised, not a raw JSON dump),
 *   - the deterministic symptom report (telemetryToSymptoms) for the stint's
 *     representative lap, and
 *   - the applied-change history across the session's setup versions.
 *
 * Hard rule (parity §4d): the deterministic engine owns the maths. The chat
 * recommends DIRECTIONS and reasoning and must NOT fabricate authoritative
 * click-by-click setup numbers — those come from Save & recommend.
 *
 * Kept separate from `chat-prompt.ts` (the lap-analysis chat) on purpose: that
 * prompt is telemetry+corner-analysis-scoped; this one is setup+symptom-scoped.
 */
import type { GameId } from "../../shared/types";
import { aiLanguageInstruction } from "../../shared/locales";
import type { TuneSymptoms } from "./tune-symptoms";
import { formatTireTempSymptoms } from "./tune-tire-symptoms";
import { formatDamperSymptoms } from "./tune-damper-symptoms";
import { formatWeightTransferSymptoms } from "./tune-weight-transfer";

/** A single applied setup change, mirroring tune-rules' AppliedChange. */
interface AppliedChangeLike {
  component?: unknown;
  from?: unknown;
  to?: unknown;
  direction?: unknown;
  reason?: unknown;
}

/** The subset of a tuning test the prompt needs to render version history. */
export interface TuneChatTest {
  version: number;
  label: string;
  /** JSON string of AppliedChange[] (null for a base/un-applied version). */
  appliedChanges: string | null;
  driverComment: string | null;
  engine: string | null;
}

/** The subset of a tuning session the prompt needs for car/track identity. */
export interface TuneChatSession {
  name: string;
  carName: string | null;
  trackName: string | null;
}

export interface TuneChatPromptInput {
  gameId: GameId;
  session: TuneChatSession;
  /** Setup versions under evaluation, oldest-first (v1 base → latest). */
  tests: TuneChatTest[];
  /** Deterministic symptom report over the representative lap; null when the
   *  session has no analysable lap yet (legacy/empty telemetry). */
  symptoms: TuneSymptoms | null;
  /** Human-readable summary of the active setup's values; null when no setup
   *  file could be read. */
  currentSetupSummary: string | null;
  /** UI/AI language code (e.g. "en", "de"). Steers prose language. */
  language?: string;
}

/**
 * Flatten a parsed setup JSON blob into a compact, bounded list of
 * `path: value` lines. ACC / AC-EVO save raw game-specific nested JSON (not the
 * Forza TuneSettings shape `format-tune.ts` expects), so we summarise generically
 * rather than dump the whole blob. Only numeric / boolean / short-array leaves
 * are kept, capped to keep the prompt small.
 */
export function summariseSetupJson(setup: unknown, maxLines = 60): string | null {
  if (setup == null || typeof setup !== "object") return null;
  const lines: string[] = [];
  let truncated = false;

  const walk = (value: unknown, path: string) => {
    if (lines.length >= maxLines) {
      truncated = true;
      return;
    }
    if (value == null) return;
    if (Array.isArray(value)) {
      // Only render short arrays of primitives (e.g. gear ratios, per-corner
      // pressures); skip arrays of objects to avoid ballooning the summary.
      if (value.length > 0 && value.length <= 8 && value.every((v) => typeof v === "number" || typeof v === "string")) {
        lines.push(`${path}: [${value.join(", ")}]`);
      }
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, path ? `${path}.${k}` : k);
      }
      return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${path}: ${value}`);
    }
  };

  walk(setup, "");
  if (lines.length === 0) return null;
  const capped = lines.slice(0, maxLines);
  if (truncated) capped.push("… (more values omitted)");
  return capped.join("\n");
}

/** Render the deterministic symptom report as prose (mirrors tune-intent). */
export function formatSymptoms(symptoms: TuneSymptoms): string {
  const agg = symptoms.aggregate;
  const cornerLines = symptoms.corners
    .map((c) => {
      const phases = c.phases
        .map((p) => {
          const flags = [
            p.balance !== "neutral" ? p.balance : null,
            p.brakeLockup ? "brake lockup" : null,
            p.bottoming ? "bottoming" : null,
          ].filter(Boolean);
          return `${p.phase}: ${flags.length ? flags.join("/") : "neutral"}`;
        })
        .join("; ");
      const band = c.speedBand ? ` [${c.speedBand}]` : "";
      return `  ${c.label}${band} — ${phases}`;
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

/** Render the applied-change history across the session's setup versions. */
function formatHistory(tests: TuneChatTest[]): string {
  if (tests.length === 0) return "  (no setup versions yet)";
  return tests
    .map((t) => {
      let changes = "base setup — no changes applied";
      if (t.appliedChanges) {
        try {
          const parsed = JSON.parse(t.appliedChanges) as AppliedChangeLike[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            changes = parsed
              .map((ch) => {
                const comp = String(ch.component ?? "?");
                const from = ch.from;
                const to = ch.to;
                const dir = ch.direction ? ` (${ch.direction})` : "";
                return `${comp} ${from}→${to}${dir}`;
              })
              .join(", ");
          }
        } catch {
          /* malformed — keep the default label */
        }
      }
      const comment = t.driverComment ? ` — driver: "${t.driverComment}"` : "";
      const engine = t.engine ? ` [${t.engine}]` : "";
      return `  v${t.version} ${t.label}${engine}: ${changes}${comment}`;
    })
    .join("\n");
}

export function buildTuneChatSystemPrompt(input: TuneChatPromptInput): string {
  const { gameId, session, tests, symptoms, currentSetupSummary, language = "en" } = input;
  const car = session.carName ?? "the car";
  const track = session.trackName ? ` at ${session.trackName}` : "";

  const setupBlock = currentSetupSummary
    ? `--- CURRENT SETUP VALUES (evidence only — NOT a prescription) ---\n${currentSetupSummary}`
    : "--- CURRENT SETUP VALUES ---\n(no setup file available for the active version)";

  const symptomBlock = symptoms
    ? `--- SYMPTOM REPORT (deterministic, from the stint's representative lap) ---\n${formatSymptoms(symptoms)}`
    : "--- SYMPTOM REPORT ---\n(no analysable lap yet — discuss the setup from the driver's feel and the current values above)";

  return `You are a sharp, decisive GT3 / endurance race engineer working the setup for ${car}${track} in ${gameId.toUpperCase()} (session "${session.name}"). The driver talks to you between runs about how the car feels and what to change.

HOW TO ANSWER
- Be decisive. When the driver describes a symptom, give the recommendation directly: name the change as a DIRECTION and a relative amount — soften/stiffen, add/reduce, raise/lower, small/medium/large — and say WHY it helps the balance (e.g. "Soften the front ARB a touch to free up slow-corner entry — it lets the front tyre bite before the rear catches up").
- Lead with the answer, not with questions. Do NOT end messages by asking "would you like me to suggest some directions?" or "shall I recommend changes?" — just make the recommendation. Ask at most ONE short clarifying question, and only when you genuinely cannot proceed without it.
- Keep it tight: a couple of short paragraphs or a few bullets. Address the driver as "you". No JSON.

HARD RULES
- A deterministic engine — not you — computes the exact clicks/values. Never state a specific number as "the" setting, and never recite the current setup values back as if they were your prescription. The values below are EVIDENCE for your reasoning only; talk in directions and relative amounts and let the engine do the maths.
- You have NO lap-comparison feature and NO access to any lap ids, other laps, or telemetry beyond the single symptom report below. NEVER invent lap ids, reference a "lap 36", claim to compare laps, or cite data that is not in this prompt. If something isn't here, say you'd need a driven lap for it — don't fabricate it.
- When the driver is happy with a direction, tell them to hit "Generate setup" — that applies the changes you've discussed and the engine works out the exact clicks. This works even before they've driven a lap.${aiLanguageInstruction(language)}

${setupBlock}

${symptomBlock}

--- SETUP VERSION HISTORY (oldest first) ---
${formatHistory(tests)}`;
}
