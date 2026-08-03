import type { GameId } from "@shared/games/ids";

// Kunos stores ACC/EVO setups as nested JSON with in-game "click" values
// (integers on fixed scales). The form edits the same integer values so
// round-trips are lossless; the labels show the real-world meaning.

export type Arity = "scalar" | "corners" | "axles";

export interface FieldDef {
  path: string;
  label: string;
  arity: Arity;
  hint?: string;
  step?: number;
  min?: number;
}

export interface SectionDef {
  key: string;
  label: string;
  fields: FieldDef[];
}

// Per-corner labels: FL, FR, RL, RR (ACC/EVO wheel order).
export const CORNER_LABELS = ["FL", "FR", "RL", "RR"] as const;
export const AXLE_LABELS = ["Front", "Rear"] as const;

const ACC_COMMON: SectionDef[] = [
  {
    key: "basicSetup.tyres",
    label: "Tyres",
    fields: [
      { path: "basicSetup.tyres.tyreCompound", label: "Compound", arity: "scalar", hint: "0 = dry, 1 = wet" },
      { path: "basicSetup.tyres.tyrePressure", label: "Pressure (clicks)", arity: "corners", hint: "20.3 psi + n × 0.1" },
    ],
  },
  {
    key: "basicSetup.alignment",
    label: "Alignment",
    fields: [
      { path: "basicSetup.alignment.camber", label: "Camber (clicks)", arity: "corners" },
      { path: "basicSetup.alignment.toe", label: "Toe (clicks)", arity: "corners" },
      { path: "basicSetup.alignment.casterLF", label: "Caster LF", arity: "scalar" },
      { path: "basicSetup.alignment.casterRF", label: "Caster RF", arity: "scalar" },
    ],
  },
  {
    key: "basicSetup.electronics",
    label: "Electronics",
    fields: [
      { path: "basicSetup.electronics.tC1", label: "TC1", arity: "scalar" },
      { path: "basicSetup.electronics.tC2", label: "TC2", arity: "scalar" },
      { path: "basicSetup.electronics.abs", label: "ABS", arity: "scalar" },
      { path: "basicSetup.electronics.eCUMap", label: "ECU Map", arity: "scalar" },
      { path: "basicSetup.electronics.fuelMix", label: "Fuel Mix", arity: "scalar" },
      { path: "basicSetup.electronics.telemetryLaps", label: "Telemetry Laps", arity: "scalar" },
    ],
  },
  {
    key: "basicSetup.strategy",
    label: "Strategy",
    fields: [
      { path: "basicSetup.strategy.fuel", label: "Fuel (L)", arity: "scalar" },
      { path: "basicSetup.strategy.tyreSet", label: "Tyre Set", arity: "scalar" },
      { path: "basicSetup.strategy.frontBrakePadCompound", label: "Front Brake Pads", arity: "scalar" },
      { path: "basicSetup.strategy.rearBrakePadCompound", label: "Rear Brake Pads", arity: "scalar" },
    ],
  },
  {
    key: "advancedSetup.mechanicalBalance",
    label: "Suspension",
    fields: [
      { path: "advancedSetup.mechanicalBalance.aRBFront", label: "Front Anti Roll Bar", arity: "scalar" },
      { path: "advancedSetup.mechanicalBalance.brakeBias", label: "Brake Bias (clicks)", arity: "scalar" },
      { path: "basicSetup.alignment.steerRatio", label: "Steer Ratio", arity: "scalar" },
      { path: "advancedSetup.mechanicalBalance.wheelRate", label: "Wheel Rate", arity: "corners" },
      { path: "advancedSetup.mechanicalBalance.bumpStopRateUp", label: "Bumpstop Rate", arity: "corners" },
      { path: "advancedSetup.mechanicalBalance.bumpStopWindow", label: "Bumpstop Range", arity: "corners" },
    ],
  },
  {
    key: "advancedSetup.rear",
    label: "Rear",
    fields: [
      { path: "advancedSetup.mechanicalBalance.aRBRear", label: "Anti Roll Bar", arity: "scalar" },
      { path: "advancedSetup.mechanicalBalance.preloadDifferential", label: "Differential Preload", arity: "scalar" },
    ],
  },
  {
    key: "advancedSetup.dampers",
    label: "Dampers",
    fields: [
      { path: "advancedSetup.dampers.bumpSlow", label: "Bump Slow", arity: "corners" },
      { path: "advancedSetup.dampers.bumpFast", label: "Bump Fast", arity: "corners" },
      { path: "advancedSetup.dampers.reboundSlow", label: "Rebound Slow", arity: "corners" },
      { path: "advancedSetup.dampers.reboundFast", label: "Rebound Fast", arity: "corners" },
    ],
  },
  {
    key: "advancedSetup.aeroBalance",
    label: "Aero & Ride",
    fields: [
      { path: "advancedSetup.aeroBalance.rideHeight", label: "Ride Height", arity: "corners" },
      { path: "advancedSetup.aeroBalance.splitter", label: "Splitter", arity: "scalar" },
      { path: "advancedSetup.aeroBalance.rearWing", label: "Rear Wing", arity: "scalar" },
      { path: "advancedSetup.aeroBalance.brakeDuct", label: "Brake Duct", arity: "axles" },
    ],
  },
  {
    key: "advancedSetup.drivetrain",
    label: "Drivetrain",
    fields: [
      { path: "advancedSetup.drivetrain.preload", label: "Diff Preload", arity: "scalar" },
    ],
  },
];

const AC_EVO_SUSPENSION: SectionDef = {
  key: "advancedSetup.suspension",
  label: "Suspension Presets",
  fields: [
    { path: "advancedSetup.suspension.bumpstops", label: "Bumpstops", arity: "corners" },
    { path: "advancedSetup.suspension.packers", label: "Packers", arity: "corners" },
    { path: "advancedSetup.suspension.helperSprings", label: "Helper Springs", arity: "corners" },
  ],
};

export function getSchemaForGame(gameId: GameId): SectionDef[] {
  if (gameId === "acc") return ACC_COMMON;
  if (gameId === "ac-evo") return [...ACC_COMMON, AC_EVO_SUSPENSION];
  return [];
}

// ── Nested-object helpers (round-trip safe) ────────────────────────────────
// get/set walk the dotted path; set creates missing intermediate objects.

export function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function setByPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    const next = cur[p];
    if (next == null || typeof next !== "object" || Array.isArray(next)) {
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

export function arityLength(arity: Arity): number {
  if (arity === "corners") return 4;
  if (arity === "axles") return 2;
  return 1;
}

export function arityLabels(arity: Arity): readonly string[] {
  if (arity === "corners") return CORNER_LABELS;
  if (arity === "axles") return AXLE_LABELS;
  return [];
}
