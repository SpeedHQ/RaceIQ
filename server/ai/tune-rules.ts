/**
 * applyIntents — deterministic pass 3 of the auto-tune pipeline.
 *
 * Maps LLM-chosen `TuneIntent`s onto a concrete setup object. The LLM never
 * emits raw numbers; it names a component + direction + magnitude, and this
 * table decides the actual step and the JSON path to nudge. Unknown
 * components and out-of-range results are clamped to a no-op so a
 * hallucinated intent can never corrupt a setup file.
 */
import type { GameId } from "../../shared/types";
import type { TuneIntent, TuneMagnitude } from "./schemas";

/** A single tunable knob: where it lives + how far each magnitude moves it. */
interface FieldDef {
  /** Dot/bracket path into the setup object (e.g. "basicSetup.tyres.tyrePressure.0"). */
  path: string;
  /** Step per magnitude, in the field's native raw units (usually clicks). */
  step: Record<TuneMagnitude, number>;
  /** Inclusive clamp range for the resulting raw value. */
  min: number;
  max: number;
  /** Values are integer clicks (round after applying). Default true. */
  integer?: boolean;
}

const CLICK_STEP: Record<TuneMagnitude, number> = { small: 1, medium: 2, large: 4 };

/**
 * Component tables per game. Keys are the `component` strings the intent
 * prompt tells the model to use (see `buildTunePrompt`). ACC paths follow the
 * on-disk `.json` setup structure; AC-EVO paths follow the in-memory setup
 * snapshot captured from telemetry.
 */
const RULES: Record<string, Record<string, FieldDef>> = {
  acc: {
    "Front Anti-Roll Bar": { path: "advancedSetup.mechanicalBalance.aRBFront", step: CLICK_STEP, min: 0, max: 30 },
    "Rear Anti-Roll Bar": { path: "advancedSetup.mechanicalBalance.aRBRear", step: CLICK_STEP, min: 0, max: 30 },
    "Brake Bias": { path: "advancedSetup.mechanicalBalance.brakeBias", step: CLICK_STEP, min: 0, max: 100 },
    "Front Wing": { path: "advancedSetup.aeroBalance.splitter", step: CLICK_STEP, min: 0, max: 10 },
    "Rear Wing": { path: "advancedSetup.aeroBalance.rearWing", step: CLICK_STEP, min: 0, max: 20 },
    "Front Tyre Pressure FL": { path: "basicSetup.tyres.tyrePressure.0", step: CLICK_STEP, min: 0, max: 60 },
    "Front Tyre Pressure FR": { path: "basicSetup.tyres.tyrePressure.1", step: CLICK_STEP, min: 0, max: 60 },
    "Rear Tyre Pressure RL": { path: "basicSetup.tyres.tyrePressure.2", step: CLICK_STEP, min: 0, max: 60 },
    "Rear Tyre Pressure RR": { path: "basicSetup.tyres.tyrePressure.3", step: CLICK_STEP, min: 0, max: 60 },
  },
  "ac-evo": {
    "Front Anti-Roll Bar": { path: "frontARB", step: CLICK_STEP, min: 0, max: 30 },
    "Rear Anti-Roll Bar": { path: "rearARB", step: CLICK_STEP, min: 0, max: 30 },
    "Brake Bias": { path: "brakeBias", step: { small: 0.5, medium: 1, large: 2 }, min: 40, max: 70, integer: false },
    "Front Wing": { path: "frontWing", step: CLICK_STEP, min: 0, max: 20 },
    "Rear Wing": { path: "rearWing", step: CLICK_STEP, min: 0, max: 20 },
  },
};

function tableFor(gameId: GameId): Record<string, FieldDef> | null {
  return RULES[gameId] ?? null;
}

/** Read a dotted/bracketed path; returns undefined when any segment is missing. */
function getByPath(obj: any, path: string): unknown {
  let cur = obj;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** Write a dotted/bracketed path, creating intermediate objects/arrays. */
function setByPath(obj: any, path: string, value: number): boolean {
  const segs = path.split(".");
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (cur[seg] == null || typeof cur[seg] !== "object") return false;
    cur = cur[seg];
  }
  cur[segs[segs.length - 1]] = value;
  return true;
}

export interface AppliedChange {
  component: string;
  path: string;
  from: number;
  to: number;
  direction: TuneIntent["direction"];
  reason: string;
}

export interface ApplyResult {
  /** The mutated setup (same reference as the deep-cloned input). */
  setup: any;
  applied: AppliedChange[];
  skipped: { component: string; reason: string }[];
}

/**
 * Apply intents to a deep clone of `currentSetup`, returning the new setup and
 * an audit trail. Pure w.r.t. the input object (clones before mutating).
 */
export function applyIntents(
  gameId: GameId,
  currentSetup: unknown,
  intents: TuneIntent[],
): ApplyResult {
  const setup = structuredClone(currentSetup);
  const table = tableFor(gameId);
  const applied: AppliedChange[] = [];
  const skipped: { component: string; reason: string }[] = [];

  if (!table) {
    return {
      setup,
      applied,
      skipped: intents.map((i) => ({ component: i.component, reason: `No rules for game ${gameId}` })),
    };
  }

  for (const intent of intents) {
    const def = table[intent.component];
    if (!def) {
      skipped.push({ component: intent.component, reason: "Unknown component" });
      continue;
    }
    const raw = getByPath(setup, def.path);
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      skipped.push({ component: intent.component, reason: `Missing/invalid value at ${def.path}` });
      continue;
    }
    const delta = def.step[intent.magnitude] * (intent.direction === "increase" ? 1 : -1);
    let next = raw + delta;
    if (def.integer !== false) next = Math.round(next);
    next = Math.max(def.min, Math.min(def.max, next));
    if (next === raw) {
      skipped.push({ component: intent.component, reason: "At clamp limit — no change" });
      continue;
    }
    if (!setByPath(setup, def.path, next)) {
      skipped.push({ component: intent.component, reason: `Write failed at ${def.path}` });
      continue;
    }
    applied.push({
      component: intent.component,
      path: def.path,
      from: raw,
      to: next,
      direction: intent.direction,
      reason: intent.reason,
    });
  }

  return { setup, applied, skipped };
}

/** The component names known for a game — embedded in the intent prompt. */
export function knownComponents(gameId: GameId): string[] {
  const table = tableFor(gameId);
  return table ? Object.keys(table) : [];
}
