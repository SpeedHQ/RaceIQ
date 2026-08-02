/**
 * symptomsToIntents — deterministic pass 2 of the auto-tune pipeline.
 *
 * The LLM-free counterpart to `requestTuneIntents` (tune-intent.ts). Given the
 * same `TuneSymptoms` report, it emits the same `{component, direction,
 * magnitude, reason}` intents that `applyIntents` consumes, so rule engine and
 * setup writer remain deterministic and the whole one-button flow works with no
 * network call or local model (the user's local model 400s).
 *
 * Approach: walk every corner/phase symptom, map each to a component nudge with
 * a weight scaled by how strong the imbalance is, and accumulate a signed score
 * per component (increase +, decrease −). Opposing nudges on the same knob net
 * out. Emit the top few by magnitude. Driver feel notes *bias* the scores — they
 * bump an agreeing telemetry symptom or add a single small, flagged intent, but
 * never override the physics.
 *
 * Every component string here must exist in setup rule catalog's `knownComponents`
 * for the game, or `applyIntents` clamps it to a safe no-op.
 */
import type { GameId } from "../../shared/types";
import type { TuneIntent, TuneMagnitude } from "./schemas";
import type { Balance, Phase, SpeedBand, TuneSymptoms } from "./tune-symptoms";

export interface RecommendOptions {
  /** Free-text driver feel ("loose on entry", "understeer in slow hairpins").
   *  Biases scores; never overrides telemetry. Max ~500 chars upstream. */
  driverNotes?: string;
  /** How many intents to emit at most. Default 3 (§4d: "top N=3"). */
  maxIntents?: number;
}

// Magnitude of the front-minus-rear slip imbalance (rad) → contribution weight.
// BALANCE_THRESHOLD (~0.02) is the floor at which a phase is non-neutral at all.
function balanceWeight(magnitudeRad: number): number {
  const m = Math.abs(magnitudeRad);
  if (m < 0.05) return 1;
  if (m < 0.1) return 2;
  return 3;
}

// psi delta vs target → contribution weight for a tyre-pressure nudge.
function pressureWeight(deltaPsi: number): number {
  const d = Math.abs(deltaPsi);
  if (d >= 3) return 3;
  if (d >= 1.5) return 2;
  return 1;
}

// Summed |score| → intent magnitude bucket.
function scoreToMagnitude(absScore: number): TuneMagnitude {
  if (absScore <= 1.5) return "small";
  if (absScore <= 3.5) return "medium";
  return "large";
}

type Dir = TuneIntent["direction"];

interface Accum {
  score: number; // signed: increase +, decrease −
  reasons: string[];
}

/** Only these tyre-pressure knobs exist in the rules table (ACC). */
const PRESSURE_COMPONENT: Record<"FL" | "FR" | "RL" | "RR", string> = {
  FL: "Front Tyre Pressure FL",
  FR: "Front Tyre Pressure FR",
  RL: "Rear Tyre Pressure RL",
  RR: "Rear Tyre Pressure RR",
};

export function symptomsToIntents(
  symptoms: TuneSymptoms,
  gameId: GameId,
  options: RecommendOptions = {},
): TuneIntent[] {
  const acc = new Map<string, Accum>();
  const add = (component: string, dir: Dir, weight: number, reason: string) => {
    if (weight <= 0) return;
    const signed = dir === "increase" ? weight : -weight;
    const e = acc.get(component) ?? { score: 0, reasons: [] };
    e.score += signed;
    if (reason && !e.reasons.includes(reason)) e.reasons.push(reason);
    acc.set(component, e);
  };

  // Track which balances the telemetry actually showed, so a driver note that
  // contradicts the data can be flagged as unconfirmed.
  const telemetryBalances = new Set<Balance>();

  // ── Handling: per corner, per phase ───────────────────────────────────────
  for (const corner of symptoms.corners) {
    const band = corner.speedBand;
    for (const phase of corner.phases) {
      if (phase.balance !== "neutral") telemetryBalances.add(phase.balance);
      const w = balanceWeight(phase.balanceMagnitude);
      emitHandling(add, phase.balance, band, phase.phase, w, corner.label);
      if (phase.brakeLockup) {
        // Front lockup is the common case — shift bias rearward. Nets against an
        // entry-oversteer forward nudge on the same knob (intended, §4d).
        add("Brake Bias", "decrease", 1, `${corner.label} brake lockup → brake bias rearward`);
      }
    }
  }

  // ── Tyre pressure (ACC only — the only game whose rules table has the
  //    per-wheel pressure paths; AC-Evo also reports null deltas) ─────────────
  const tp = gameId === "acc" ? symptoms.aggregate.tyrePressure : null;
  if (tp) {
    (["FL", "FR", "RL", "RR"] as const).forEach((wheel) => {
      const delta = tp[wheel];
      if (Math.abs(delta) < 1.0) return;
      // +delta = above target → lower pressure; −delta = below → raise.
      const dir: Dir = delta > 0 ? "decrease" : "increase";
      add(
        PRESSURE_COMPONENT[wheel],
        dir,
        pressureWeight(delta),
        `${wheel} ${delta > 0 ? "+" : ""}${delta.toFixed(1)} psi vs target → ${dir === "decrease" ? "lower" : "raise"}`,
      );
    });
  }

  // ── Driver feel notes: bias, never override ────────────────────────────────
  applyDriverNotes(add, options.driverNotes, telemetryBalances);

  // ── Resolve: net opposing, drop no-ops, take the strongest few ─────────────
  const MIN_SCORE = 1;
  const max = options.maxIntents ?? 3;
  const intents: TuneIntent[] = [];
  const ranked = [...acc.entries()]
    .filter(([, e]) => Math.abs(e.score) >= MIN_SCORE)
    .sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score))
    .slice(0, max);

  for (const [component, e] of ranked) {
    intents.push({
      component,
      direction: e.score > 0 ? "increase" : "decrease",
      magnitude: scoreToMagnitude(Math.abs(e.score)),
      reason: e.reasons.join("; "),
    });
  }
  return intents;
}

/** Map one balance/band/phase symptom onto a component nudge. */
function emitHandling(
  add: (component: string, dir: Dir, weight: number, reason: string) => void,
  balance: Balance,
  band: SpeedBand | undefined,
  phase: Phase,
  weight: number,
  label: string,
): void {
  if (weight <= 0) return;
  const isFast = band === "fast";
  const bandTxt = band ? `${band} ` : "";

  if (balance === "understeer") {
    if (isFast) {
      // Aero-dominated: free the front by trimming rear downforce.
      add("Rear Wing", "decrease", weight, `${label} fast understeer → less rear wing`);
    } else {
      // Mechanical: soften the front roll stiffness.
      add("Front Anti-Roll Bar", "decrease", weight, `${label} ${bandTxt}understeer → softer front ARB`);
    }
  } else if (balance === "oversteer") {
    if (isFast) {
      add("Rear Wing", "increase", weight, `${label} fast oversteer → more rear wing`);
    } else if (phase === "entry") {
      // Entry (off-throttle/braking) oversteer → move brake bias forward.
      add("Brake Bias", "increase", weight, `${label} entry oversteer → brake bias forward`);
    } else {
      add("Rear Anti-Roll Bar", "decrease", weight, `${label} ${phase} oversteer → softer rear ARB`);
    }
  }
}

interface FeelHint {
  balance: Balance;
  band?: SpeedBand;
  phase?: Phase;
}

/** Very small keyword matcher — deterministic, no LLM (§4f: keywords first). */
function parseDriverNotes(notes: string): FeelHint[] {
  const t = notes.toLowerCase();
  const hints: FeelHint[] = [];

  const band: SpeedBand | undefined = /slow|hairpin|low[-\s]?speed/.test(t)
    ? "slow"
    : /fast|high[-\s]?speed|sweeper/.test(t)
      ? "fast"
      : undefined;
  const phase: Phase | undefined = /entry|turn[-\s]?in|on the brakes|braking/.test(t)
    ? "entry"
    : /exit|on power|on throttle|corner exit/.test(t)
      ? "exit"
      : undefined;

  if (/oversteer|loose|snap|tail (steps|comes)|spins?\b|too much rotation/.test(t)) {
    hints.push({ balance: "oversteer", band, phase });
  }
  if (/understeer|push(es|ing)?\b|plou?gh|tight|won'?t turn|no front/.test(t)) {
    hints.push({ balance: "understeer", band, phase });
  }
  return hints;
}

function applyDriverNotes(
  add: (component: string, dir: Dir, weight: number, reason: string) => void,
  notes: string | undefined,
  telemetryBalances: Set<Balance>,
): void {
  if (!notes || !notes.trim()) return;
  for (const hint of parseDriverNotes(notes)) {
    const confirmed = telemetryBalances.has(hint.balance);
    // Agreeing hint bumps the telemetry symptom one step; a lone (unconfirmed)
    // hint adds at most a single small intent, flagged.
    const tag = confirmed ? "(driver-reported)" : "(driver-reported, unconfirmed by telemetry)";
    emitHandling(add, hint.balance, hint.band, hint.phase ?? "mid", 1, `Driver feel ${tag}`);
  }
}
