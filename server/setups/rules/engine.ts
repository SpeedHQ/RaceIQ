/** Deterministic setup mutation and live knob inspection. */
import type { GameId } from "../../../shared/types";
import type { TuneIntent, TuneMagnitude } from "../../ai/schemas";
import { getRuleTable, knownComponents } from "./catalog";

function getByPath(obj: any, path: string): unknown {
  let current = obj;
  for (const segment of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

function setByPath(obj: any, path: string, value: number): boolean {
  const segments = path.split(".");
  let current = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (current[segment] == null || typeof current[segment] !== "object") return false;
    current = current[segment];
  }
  current[segments[segments.length - 1]] = value;
  return true;
}

export interface AppliedChange {
  component: string;
  /** Every JSON path this knob wrote; symmetric pairs move together. */
  paths: string[];
  from: number;
  to: number;
  direction: TuneIntent["direction"];
  reason: string;
}

export interface ApplyResult {
  /** Mutated deep clone of input setup. */
  setup: any;
  applied: AppliedChange[];
  skipped: { component: string; reason: string }[];
}

/** Apply intents to a deep clone, preserving whole-knob and clamp semantics. */
export function applyIntents(
  gameId: GameId,
  currentSetup: unknown,
  intents: TuneIntent[],
  carModel?: string,
): ApplyResult {
  const setup = structuredClone(currentSetup);
  const table = getRuleTable(gameId, carModel);
  const applied: AppliedChange[] = [];
  const skipped: { component: string; reason: string }[] = [];

  if (!table) {
    return {
      setup,
      applied,
      skipped: intents.map((intent) => ({ component: intent.component, reason: `No rules for game ${gameId}` })),
    };
  }

  for (const intent of intents) {
    const def = table[intent.component];
    if (!def) {
      skipped.push({ component: intent.component, reason: "Unknown component" });
      continue;
    }

    // Read every path first: one missing/non-numeric path skips whole knob.
    const raws: number[] = [];
    let badPath: string | undefined;
    for (const path of def.paths) {
      const value = getByPath(setup, path);
      if (typeof value !== "number" || !Number.isFinite(value)) {
        badPath = path;
        break;
      }
      raws.push(value);
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
    for (const path of def.paths) {
      if (!setByPath(setup, path, next)) {
        writeFailed = path;
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

export interface KnobState {
  component: string;
  /** Current raw value from first path; symmetric pairs share one value. */
  current: number | null;
  min: number;
  max: number;
}

/** Read one knob's current value and hard clamp range. */
export function getKnobState(
  gameId: GameId,
  setup: unknown,
  component: string,
  carModel?: string,
): KnobState | null {
  const table = getRuleTable(gameId, carModel);
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

/** Knob states for every component exposed by game/car catalog. */
export function getAllKnobStates(gameId: GameId, setup: unknown, carModel?: string): KnobState[] {
  return knownComponents(gameId, carModel)
    .map((component) => getKnobState(gameId, setup, component, carModel))
    .filter((knob): knob is KnobState => knob !== null);
}

export interface KnobDescription extends KnobState {
  /** Native step sizes used by preview/apply. */
  step: Record<TuneMagnitude, number>;
}

/** Full grounded knob list for Setup Engineer. */
export function describeKnobs(gameId: GameId, setup: unknown, carModel?: string): KnobDescription[] {
  const table = getRuleTable(gameId, carModel);
  if (!table) return [];
  return knownComponents(gameId, carModel)
    .map((component) => {
      const state = getKnobState(gameId, setup, component, carModel);
      if (!state) return null;
      return { ...state, step: table[component]!.step };
    })
    .filter((knob): knob is KnobDescription => knob !== null);
}
