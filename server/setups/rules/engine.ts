/** Deterministic setup mutation and live knob inspection. */
import type { GameId } from "@raceiq/shared/games/ids";
import type { TuneIntent, TuneMagnitude } from "../../ai/schemas";
import { getSvmFieldAccess } from "@raceiq/game-lmu-metadata/setups/capabilities";
import { getSvmFieldDescriptor } from "@raceiq/game-lmu-metadata/setups/fields";
import { parseSVM, writeSVM, type SvmDocument, type SvmEdit } from "@raceiq/game-lmu-metadata/setups/svm";
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

function applyLmuIntents(currentSetup: unknown, intents: TuneIntent[]): ApplyResult<SvmDocument> {
  const setup = currentSetup as SvmDocument;
  const skipped: { component: string; reason: string }[] = [];
  const currentIndices = new Map([...setup.settings].map(([id, setting]) => [id, setting.index]));
  const pending: { id: string; component: string; from: number; to: number; direction: TuneIntent["direction"]; reason: string }[] = [];
  for (const intent of intents) {
    const match = [...setup.settings.keys()]
      .map((id) => {
        const field = getSvmFieldDescriptor(id);
        return [id, field, field ? `${field.label} (${id})` : null] as const;
      })
      .find(([, field, component]) => field && component === intent.component);
    if (!match) {
      skipped.push({ component: intent.component, reason: "Unknown or unavailable LMU setting" });
      continue;
    }
    const [id, field] = match;
    const access = getSvmFieldAccess(setup, id);
    if (!access.editable || !field) {
      skipped.push({ component: intent.component, reason: access.reason ?? "Setting is not editable" });
      continue;
    }
    const from = currentIndices.get(id)!;
    if (!Number.isSafeInteger(from) || from < 0) {
      skipped.push({ component: intent.component, reason: "Current SVM click index is invalid" });
      continue;
    }
    const clicks = { small: 1, medium: 2, large: 4 }[intent.magnitude];
    const to = from + (intent.direction === "increase" ? clicks : -clicks);
    if (to < 0) {
      skipped.push({ component: intent.component, reason: "At minimum SVM click index (0)" });
      continue;
    }
    if (!Number.isSafeInteger(to)) {
      skipped.push({ component: intent.component, reason: "Change exceeds safe SVM click index" });
      continue;
    }
    currentIndices.set(id, to);
    pending.push({ id, component: intent.component, from, to, direction: intent.direction, reason: intent.reason });
  }
  const applied: AppliedChange[] = [];
  const edits: SvmEdit[] = [];
  for (const [id, finalIndex] of currentIndices) {
    const originalIndex = setup.settings.get(id)!.index;
    if (finalIndex === originalIndex) continue;
    edits.push({ id, delta: finalIndex - originalIndex });
    applied.push(...pending
      .filter((change) => change.id === id)
      .map(({ component, from, to, direction, reason }) => ({
        component, paths: [id], from, to, direction, reason,
      })));
  }
  for (const change of pending) {
    if (currentIndices.get(change.id) === setup.settings.get(change.id)!.index) {
      skipped.push({ component: change.component, reason: "Net change is zero after requested changes" });
    }
  }
  if (!edits.length) return { setup, applied, skipped };
  const parsed = parseSVM(writeSVM(setup, edits));
  if (!parsed.ok) throw new Error(`Could not patch LMU setup: ${parsed.error}`);
  return { setup: parsed.document, applied, skipped };
}
/** Apply intents to a deep clone, preserving whole-knob and clamp semantics. */
export function applyIntents<T>(
  gameId: GameId,
  currentSetup: T,
  intents: TuneIntent[],
  carModel?: string,
): ApplyResult<T> {
  if (gameId === "lmu") return applyLmuIntents(currentSetup, intents) as ApplyResult<T>;
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
  min: number | null;
  max: number | null;
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
  if (gameId === "lmu") {
    const document = setup as SvmDocument;
    return [...document.settings.values()]
      .filter((setting) => getSvmFieldAccess(document, setting.id).editable)
      .map((setting) => {
        const field = getSvmFieldDescriptor(setting.id)!;
        const component = `${field.label} (${setting.id})`;
        return { component, current: setting.index, min: null, max: null, step: { small: 1, medium: 2, large: 4 } };
      });
  }
  if (!table) return [];
  return Object.entries(table).map(([component, def]) => ({
    ...knobState(component, def, setup),
    step: def.step,
  }));
}
