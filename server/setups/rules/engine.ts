/** Deterministic setup mutation and live knob inspection. */
import type { GameId } from "../../../shared/types";
import type { TuneIntent, TuneMagnitude } from "../../ai/schemas";
import { getRuleTable, type FieldDef } from "./catalog";

function isPathContainer(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}

function getByPath(obj: unknown, path: string): unknown {
  let current = obj;
  for (const segment of path.split(".")) {
    if (!isPathContainer(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function setByPath(obj: unknown, path: string, value: number): boolean {
  const segments = path.split(".");
  let current = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    if (!isPathContainer(current)) return false;
    current = current[segments[i]];
  }
  if (!isPathContainer(current)) return false;
  current[segments[segments.length - 1]] = value;
  return true;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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

export interface ApplyResult<T = unknown> {
  /** Mutated deep clone of input setup. */
  setup: T;
  applied: AppliedChange[];
  skipped: { component: string; reason: string }[];
}

/** Apply intents to a deep clone, preserving whole-knob and clamp semantics. */
export function applyIntents<T>(
  gameId: GameId,
  currentSetup: T,
  intents: TuneIntent[],
  carModel?: string,
): ApplyResult<T> {
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
    const firstPath = def.paths[0];
    const current = getByPath(setup, firstPath);
    if (!isFiniteNumber(current)) {
      skipped.push({ component: intent.component, reason: `Missing/invalid value at ${firstPath}` });
      continue;
    }
    let badPath: string | undefined;
    for (let i = 1; i < def.paths.length; i++) {
      const path = def.paths[i];
      if (!isFiniteNumber(getByPath(setup, path))) {
        badPath = path;
        break;
      }
    }
    if (badPath) {
      skipped.push({ component: intent.component, reason: `Missing/invalid value at ${badPath}` });
      continue;
    }

    const delta = def.step[intent.magnitude] * (intent.direction === "increase" ? 1 : -1);
    let next = current + delta;
    if (def.integer !== false) next = Math.round(next);
    next = Math.max(def.min, Math.min(def.max, next));
    if (next === current) {
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
      from: current,
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

function knobState(component: string, def: FieldDef, setup: unknown): KnobState {
  const raw = getByPath(setup, def.paths[0]);
  return {
    component,
    current: isFiniteNumber(raw) ? raw : null,
    min: def.min,
    max: def.max,
  };
}

/** Knob states for every component exposed by game/car catalog. */
export function getAllKnobStates(gameId: GameId, setup: unknown, carModel?: string): KnobState[] {
  const table = getRuleTable(gameId, carModel);
  if (!table) return [];
  return Object.entries(table).map(([component, def]) => knobState(component, def, setup));
}

export interface KnobDescription extends KnobState {
  /** Native step sizes used by preview/apply. */
  step: Record<TuneMagnitude, number>;
}

/** Full grounded knob list for Setup Engineer. */
export function describeKnobs(gameId: GameId, setup: unknown, carModel?: string): KnobDescription[] {
  const table = getRuleTable(gameId, carModel);
  if (!table) return [];
  return Object.entries(table).map(([component, def]) => ({
    ...knobState(component, def, setup),
    step: def.step,
  }));
}
