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
import { getAcEvoCarByDisplayName } from "../../shared/ac-evo-car-data";
import type { TuneIntent, TuneMagnitude } from "./schemas";

/**
 * A single tunable knob: where it lives + how far each magnitude moves it.
 *
 * `paths` lists every JSON path this knob controls. Most knobs are a single
 * scalar (one-element array). Symmetric axle knobs (ride height, dampers)
 * list the pair of array indices that must move together (e.g. front ride
 * height = rideHeight[0] and rideHeight[1]) — `applyIntents` reads the first
 * path as the base value, computes one clamped delta, and writes it to every
 * path so the knob stays a single driver-facing change (one AppliedChange).
 */
interface FieldDef {
  /** Dot/bracket paths into the setup object, applied in lockstep. */
  paths: string[];
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
    "Front Anti-Roll Bar": { paths: ["advancedSetup.mechanicalBalance.aRBFront"], step: CLICK_STEP, min: 0, max: 30 },
    "Rear Anti-Roll Bar": { paths: ["advancedSetup.mechanicalBalance.aRBRear"], step: CLICK_STEP, min: 0, max: 30 },
    "Brake Bias": { paths: ["advancedSetup.mechanicalBalance.brakeBias"], step: CLICK_STEP, min: 0, max: 100 },
    "Front Wing": { paths: ["advancedSetup.aeroBalance.splitter"], step: CLICK_STEP, min: 0, max: 10 },
    "Rear Wing": { paths: ["advancedSetup.aeroBalance.rearWing"], step: CLICK_STEP, min: 0, max: 20 },
    "Front Tyre Pressure FL": { paths: ["basicSetup.tyres.tyrePressure.0"], step: CLICK_STEP, min: 0, max: 60 },
    "Front Tyre Pressure FR": { paths: ["basicSetup.tyres.tyrePressure.1"], step: CLICK_STEP, min: 0, max: 60 },
    "Rear Tyre Pressure RL": { paths: ["basicSetup.tyres.tyrePressure.2"], step: CLICK_STEP, min: 0, max: 60 },
    "Rear Tyre Pressure RR": { paths: ["basicSetup.tyres.tyrePressure.3"], step: CLICK_STEP, min: 0, max: 60 },

    // Ride height, dampers, and diff preload — added for the Setup Engineer
    // grounding fix (docs/setup-engineer-tools-plan.md §2). Paths verified
    // against a real ACC setup JSON export. Ranges are conservative
    // ACC click-index clamps and may need per-car-class scaling later (plan
    // §5 risk) — GT3 cars generally sit well inside these bounds.
    "Front Ride Height": {
      paths: ["advancedSetup.aeroBalance.rideHeight.0", "advancedSetup.aeroBalance.rideHeight.1"],
      step: CLICK_STEP,
      min: 50,
      max: 100,
    },
    "Rear Ride Height": {
      paths: ["advancedSetup.aeroBalance.rideHeight.2", "advancedSetup.aeroBalance.rideHeight.3"],
      step: CLICK_STEP,
      min: 55,
      max: 110,
    },
    "Front Bump": {
      paths: ["advancedSetup.dampers.bumpSlow.0", "advancedSetup.dampers.bumpSlow.1"],
      step: CLICK_STEP,
      min: 0,
      max: 20,
    },
    "Rear Bump": {
      paths: ["advancedSetup.dampers.bumpSlow.2", "advancedSetup.dampers.bumpSlow.3"],
      step: CLICK_STEP,
      min: 0,
      max: 20,
    },
    "Front Rebound": {
      paths: ["advancedSetup.dampers.reboundSlow.0", "advancedSetup.dampers.reboundSlow.1"],
      step: CLICK_STEP,
      min: 0,
      max: 20,
    },
    "Rear Rebound": {
      paths: ["advancedSetup.dampers.reboundSlow.2", "advancedSetup.dampers.reboundSlow.3"],
      step: CLICK_STEP,
      min: 0,
      max: 20,
    },
    "Diff Preload": {
      paths: ["advancedSetup.drivetrain.preload"],
      step: CLICK_STEP,
      min: 0,
      max: 100,
    },
  },
  "ac-evo": {
    "Front Anti-Roll Bar": { paths: ["frontARB"], step: CLICK_STEP, min: 0, max: 30 },
    "Rear Anti-Roll Bar": { paths: ["rearARB"], step: CLICK_STEP, min: 0, max: 30 },
    "Brake Bias": { paths: ["brakeBias"], step: { small: 0.5, medium: 1, large: 2 }, min: 40, max: 70, integer: false },
    "Front Wing": { paths: ["frontWing"], step: CLICK_STEP, min: 0, max: 20 },
    "Rear Wing": { paths: ["rearWing"], step: CLICK_STEP, min: 0, max: 20 },
    // Ride height / dampers intentionally left out for AC-Evo: its in-memory
    // setup snapshot (captured from telemetry, not a setup JSON) doesn't have
    // a verified shape for these fields yet — add once confirmed against a
    // real snapshot (plan §2/§5).
  },
  // F1 2025 — flat `F1CarSetup` value model (no nested paths, unlike ACC).
  // Ranges are NOT invented: min/max below are the observed min/max of each
  // field across all 24 track folders in the bundled community catalog
  // (`shared/tunes/f1-25/f1laps/*/setups.json`, read via `loadCatalogEntries()`
  // / `TRACK_CATALOG` in `server/ai/f1-setup-catalog.ts`), computed by
  // aggregating every `CatalogEntry.setup` across the bundle. `engineBraking`
  // and `fuelLoad` are deliberately omitted — the catalog carries no data for
  // either field, so no non-fabricated range exists for them. `Brake Bias`
  // targets the packet's `brakeBias` path but its range is sourced from the
  // catalog's `frontBrakeBias` field (packet has one combined bias value,
  // catalog stores it as a front-axle setting — same 50–60 scale).
  "f1-2025": {
    "Front Wing": { paths: ["frontWing"], step: CLICK_STEP, min: 0, max: 50 },
    "Rear Wing": { paths: ["rearWing"], step: CLICK_STEP, min: 0, max: 50 },
    "On-Throttle Diff": { paths: ["onThrottle"], step: CLICK_STEP, min: 10, max: 100 },
    "Off-Throttle Diff": { paths: ["offThrottle"], step: CLICK_STEP, min: 10, max: 100 },
    "Front Camber": { paths: ["frontCamber"], step: { small: 0.1, medium: 0.2, large: 0.4 }, min: -3.5, max: -2.5, integer: false },
    "Rear Camber": { paths: ["rearCamber"], step: { small: 0.1, medium: 0.2, large: 0.4 }, min: -2, max: -1, integer: false },
    "Front Toe": { paths: ["frontToe"], step: { small: 0.02, medium: 0.05, large: 0.1 }, min: 0, max: 0.2, integer: false },
    "Rear Toe": { paths: ["rearToe"], step: { small: 0.02, medium: 0.05, large: 0.1 }, min: 0.1, max: 0.25, integer: false },
    "Front Suspension": { paths: ["frontSuspension"], step: CLICK_STEP, min: 1, max: 41 },
    "Rear Suspension": { paths: ["rearSuspension"], step: CLICK_STEP, min: 1, max: 41 },
    "Front Anti-Roll Bar": { paths: ["frontAntiRollBar"], step: CLICK_STEP, min: 1, max: 21 },
    "Rear Anti-Roll Bar": { paths: ["rearAntiRollBar"], step: CLICK_STEP, min: 1, max: 21 },
    "Front Ride Height": { paths: ["frontRideHeight"], step: CLICK_STEP, min: 15, max: 34 },
    "Rear Ride Height": { paths: ["rearRideHeight"], step: CLICK_STEP, min: 40, max: 60 },
    "Brake Pressure": { paths: ["brakePressure"], step: CLICK_STEP, min: 90, max: 100 },
    "Brake Bias": { paths: ["brakeBias"], step: CLICK_STEP, min: 50, max: 60 },
    "Front Left Tyre Pressure": { paths: ["frontLeftTyrePressure"], step: { small: 0.1, medium: 0.3, large: 0.5 }, min: 22.5, max: 29.5, integer: false },
    "Front Right Tyre Pressure": { paths: ["frontRightTyrePressure"], step: { small: 0.1, medium: 0.3, large: 0.5 }, min: 22.5, max: 29.5, integer: false },
    "Rear Left Tyre Pressure": { paths: ["rearLeftTyrePressure"], step: { small: 0.1, medium: 0.3, large: 0.5 }, min: 20.5, max: 26.5, integer: false },
    "Rear Right Tyre Pressure": { paths: ["rearRightTyrePressure"], step: { small: 0.1, medium: 0.3, large: 0.5 }, min: 20.5, max: 26.5, integer: false },
  },
};

// Per-car ranges extracted from AC Evo game data (content.kspkg → carsetuplimits)
// by scripts/extract-acevo-setup-ranges.ts. Keyed by carModel → snapshot field
// name (matches FieldDef.paths[0] for "ac-evo"). `null` = not tunable on car.
// ACC has no equivalent: its car data is encrypted (.kunosblob inside the UE4
// pak), so ACC stays on the per-game global clamps above.
import acEvoRangesJson from "../../shared/games/ac-evo/setup-ranges.json";

export interface CarRange {
  min: number;
  max: number;
  step: number;
}
const AC_EVO_CAR_RANGES = acEvoRangesJson as unknown as Record<string, Record<string, CarRange | null>>;

/** Raw extracted per-car AC Evo ranges (snapshot-field-keyed), or null when the
 *  car has no extracted data. Used by the setup-file viewer to draw range bars.
 *  Accepts either the model slug ("audi_r8_lms_gt3_evo_2") or the display name
 *  ("Audi R8 LMS GT3 Evo II" — what the Setups folder is named on disk). */
export function getAcEvoCarRanges(carModel?: string): Record<string, CarRange | null> | null {
  if (!carModel) return null;
  const direct = AC_EVO_CAR_RANGES[carModel];
  if (direct) return direct;
  const car = getAcEvoCarByDisplayName(carModel);
  return (car && AC_EVO_CAR_RANGES[car.model]) ?? null;
}

/**
 * Per-game rule table, narrowed to a specific car when per-car data exists.
 * - Component marked `null` for the car ⇒ dropped (never suggested, rejected on apply).
 * - Component with extracted min/max/step ⇒ clamps and step sizes replaced.
 * - Car (or game) without per-car data ⇒ per-game global table unchanged.
 */
function tableFor(gameId: GameId, carModel?: string): Record<string, FieldDef> | null {
  const base = RULES[gameId] ?? null;
  if (!base || gameId !== "ac-evo" || !carModel) return base;
  const car = AC_EVO_CAR_RANGES[carModel];
  if (!car) return base;
  const narrowed: Record<string, FieldDef> = {};
  for (const [component, def] of Object.entries(base)) {
    const key = def.paths[0];
    if (!(key in car)) {
      narrowed[component] = def; // no per-car data for this field — keep global
      continue;
    }
    const r = car[key];
    if (r === null) continue; // not tunable on this car
    narrowed[component] = {
      ...def,
      min: r.min,
      max: r.max,
      step: { small: r.step, medium: r.step * 2, large: r.step * 4 },
      integer: Number.isInteger(r.step) && Number.isInteger(r.min) ? def.integer : false,
    };
  }
  return narrowed;
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
  /** Every JSON path this knob wrote (1 for scalars, 2 for symmetric axle pairs). */
  paths: string[];
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
  carModel?: string,
): ApplyResult {
  const setup = structuredClone(currentSetup);
  const table = tableFor(gameId, carModel);
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
    // Read every path first — if any is missing/non-numeric, skip the whole
    // knob rather than partially applying (e.g. one ride-height index but not
    // its pair).
    const raws: number[] = [];
    let badPath: string | undefined;
    for (const p of def.paths) {
      const v = getByPath(setup, p);
      if (typeof v !== "number" || !Number.isFinite(v)) {
        badPath = p;
        break;
      }
      raws.push(v);
    }
    if (badPath) {
      skipped.push({ component: intent.component, reason: `Missing/invalid value at ${badPath}` });
      continue;
    }
    const raw = raws[0];
    const delta = def.step[intent.magnitude] * (intent.direction === "increase" ? 1 : -1);
    let next = raw + delta;
    if (def.integer !== false) next = Math.round(next);
    next = Math.max(def.min, Math.min(def.max, next));
    if (next === raw) {
      skipped.push({ component: intent.component, reason: "At clamp limit — no change" });
      continue;
    }
    let writeFailed: string | undefined;
    for (const p of def.paths) {
      if (!setByPath(setup, p, next)) {
        writeFailed = p;
        break;
      }
    }
    if (writeFailed) {
      skipped.push({ component: intent.component, reason: `Write failed at ${writeFailed}` });
      continue;
    }
    applied.push({
      component: intent.component,
      paths: def.paths,
      from: raw,
      to: next,
      direction: intent.direction,
      reason: intent.reason,
    });
  }

  return { setup, applied, skipped };
}

/** The component names known for a game — embedded in the intent prompt. */
export function knownComponents(gameId: GameId, carModel?: string): string[] {
  const table = tableFor(gameId, carModel);
  return table ? Object.keys(table) : [];
}

export interface KnobState {
  component: string;
  /** Current raw value (first path only — symmetric pairs share one value). */
  current: number | null;
  min: number;
  max: number;
}

/**
 * Read a single knob's current value + clamp range out of a live setup object.
 * Used by the setup-engineer agent's `get_current_setup` tool so the model only
 * ever sees knobs it can actually move (plan §3). Returns null when the game
 * has no rules table or the component is unknown.
 */
export function getKnobState(gameId: GameId, setup: unknown, component: string, carModel?: string): KnobState | null {
  const table = tableFor(gameId, carModel);
  const def = table?.[component];
  if (!def) return null;
  const raw = getByPath(setup, def.paths[0]);
  return {
    component,
    current: typeof raw === "number" && Number.isFinite(raw) ? raw : null,
    min: def.min,
    max: def.max,
  };
}

/** `getKnobState` for every knob the game exposes — the full grounded knob list. */
export function getAllKnobStates(gameId: GameId, setup: unknown, carModel?: string): KnobState[] {
  return knownComponents(gameId, carModel)
    .map((c) => getKnobState(gameId, setup, c, carModel))
    .filter((k): k is KnobState => k !== null);
}

export interface KnobDescription extends KnobState {
  /** Per-magnitude step size in the knob's native units — how far
   *  small/medium/large actually move it (what `preview_change` /
   *  `apply_changes` will do). */
  step: Record<TuneMagnitude, number>;
}

/**
 * `getAllKnobStates` plus each knob's per-magnitude step size — the full
 * grounded knob list the Setup Engineer agent's `get_current_setup` tool
 * returns (plan §3): current value + clamp range + how far a click moves it.
 */
/**
 * Prompt block listing each knob's hard clamp range for the matched car —
 * injected into the intent prompts so the model doesn't waste intents pushing
 * a knob past its limit. Only real per-car data is surfaced: when the car has
 * no extracted ranges (or the game has none), the block says the ranges are
 * unknown instead of echoing global fallback clamps as if they were the car's.
 */
export function renderKnobLimitsBlock(gameId: GameId, carModel?: string): string {
  const header = "=== KNOB LIMITS (hard clamps — intents past these are wasted) ===";
  const matched = gameId === "ac-evo" && !!carModel && !!AC_EVO_CAR_RANGES[carModel];
  if (!matched) {
    return `${header}\nTuning ranges unknown for this car — prefer small/medium magnitudes; the engine clamps to real limits.`;
  }
  const table = tableFor(gameId, carModel)!;
  const lines = Object.entries(table)
    .map(([component, def]) => `  - ${component}: ${def.min} to ${def.max} (small step ${def.step.small})`)
    .join("\n");
  return `${header}\n${lines}\nDo not suggest "increase" on a knob already at max, or "decrease" at min.`;
}

export function describeKnobs(gameId: GameId, setup: unknown, carModel?: string): KnobDescription[] {
  const table = tableFor(gameId, carModel);
  if (!table) return [];
  return knownComponents(gameId, carModel)
    .map((component) => {
      const state = getKnobState(gameId, setup, component, carModel);
      if (!state) return null;
      return { ...state, step: table[component]!.step };
    })
    .filter((k): k is KnobDescription => k !== null);
}
