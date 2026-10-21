/** Setup rule catalog: component grammar, paths, steps, and hard clamps. */
import type { GameId } from "@raceiq/shared/games/ids";
import { getAcEvoCarByDisplayName } from "@raceiq/game-ac-evo-metadata/racing/cars/ac-evo"
import acEvoRangesJson from "@raceiq/game-ac-evo-metadata/setup-ranges.json";
import type { TuneMagnitude } from "../../ai/schemas";

/** A tunable driver-facing knob and every storage path it controls. */
export interface FieldDef {
  paths: string[];
  step: Record<TuneMagnitude, number>;
  min: number;
  max: number;
  unit?: string;
  rangeKey?: string;
  integer?: boolean;
}
function scaledSteps(step: number): Record<TuneMagnitude, number> {
  return { small: step, medium: step * 2, large: step * 4 };
}

const CLICK_STEP = scaledSteps(1);

/** Component strings are prompt grammar and persisted applied-change labels. */
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
    "Diff Preload": { paths: ["advancedSetup.drivetrain.preload"], step: CLICK_STEP, min: 0, max: 100 },
  },
  "ac-evo": {
    "Front Anti-Roll Bar": { paths: ["frontARB"], step: CLICK_STEP, min: 0, max: 30, unit: "clicks" },
    "Rear Anti-Roll Bar": { paths: ["rearARB"], step: CLICK_STEP, min: 0, max: 30, unit: "clicks" },
    "Brake Bias": { paths: ["brakeBias"], step: { small: 0.5, medium: 1, large: 2 }, min: 40, max: 70, integer: false, unit: "%" },
    "Front Wing": { paths: ["frontWing"], step: CLICK_STEP, min: 0, max: 20, unit: "clicks" },
    "Front Ride Height": { paths: ["frontRideHeight"], step: CLICK_STEP, min: 50, max: 200, unit: "mm" },
    "Rear Ride Height": { paths: ["rearRideHeight"], step: CLICK_STEP, min: 50, max: 200, unit: "mm" },
    "Rear Wing": { paths: ["rearWing"], step: CLICK_STEP, min: 0, max: 20, unit: "clicks" },
    "Diff Preload": { paths: ["diffPreload"], step: CLICK_STEP, min: 0, max: 300, unit: "Nm" },
    "Front Left Slow Bump": { paths: ["frontLeftBump"], rangeKey: "frontBump", step: CLICK_STEP, min: 1, max: 20, unit: "clicks" },
    "Front Right Slow Bump": { paths: ["frontRightBump"], rangeKey: "frontBump", step: CLICK_STEP, min: 1, max: 20, unit: "clicks" },
    "Rear Left Slow Bump": { paths: ["rearLeftBump"], rangeKey: "rearBump", step: CLICK_STEP, min: 1, max: 20, unit: "clicks" },
    "Rear Right Slow Bump": { paths: ["rearRightBump"], rangeKey: "rearBump", step: CLICK_STEP, min: 1, max: 20, unit: "clicks" },
  },
  "f1-2025": {
    "Front Wing": { paths: ["frontWing"], step: CLICK_STEP, min: 0, max: 50, unit: "clicks" },
    "Rear Wing": { paths: ["rearWing"], step: CLICK_STEP, min: 0, max: 50, unit: "clicks" },
    "On-Throttle Diff": { paths: ["onThrottle"], step: CLICK_STEP, min: 10, max: 100, unit: "%" },
    "Off-Throttle Diff": { paths: ["offThrottle"], step: CLICK_STEP, min: 10, max: 100, unit: "%" },
    "Front Camber": { paths: ["frontCamber"], step: { small: 0.1, medium: 0.2, large: 0.4 }, min: -3.5, max: -2.5, integer: false, unit: "°" },
    "Rear Camber": { paths: ["rearCamber"], step: { small: 0.1, medium: 0.2, large: 0.4 }, min: -2, max: -1, integer: false, unit: "°" },
    "Front Toe": { paths: ["frontToe"], step: { small: 0.02, medium: 0.05, large: 0.1 }, min: 0, max: 0.2, integer: false, unit: "°" },
    "Rear Toe": { paths: ["rearToe"], step: { small: 0.02, medium: 0.05, large: 0.1 }, min: 0.1, max: 0.25, integer: false, unit: "°" },
    "Front Suspension": { paths: ["frontSuspension"], step: CLICK_STEP, min: 1, max: 41, unit: "clicks" },
    "Rear Suspension": { paths: ["rearSuspension"], step: CLICK_STEP, min: 1, max: 41, unit: "clicks" },
    "Front Anti-Roll Bar": { paths: ["frontAntiRollBar"], step: CLICK_STEP, min: 1, max: 21, unit: "clicks" },
    "Rear Anti-Roll Bar": { paths: ["rearAntiRollBar"], step: CLICK_STEP, min: 1, max: 21, unit: "clicks" },
    "Front Ride Height": { paths: ["frontRideHeight"], step: CLICK_STEP, min: 15, max: 34, unit: "clicks" },
    "Rear Ride Height": { paths: ["rearRideHeight"], step: CLICK_STEP, min: 40, max: 60, unit: "clicks" },
    "Brake Pressure": { paths: ["brakePressure"], step: CLICK_STEP, min: 90, max: 100, unit: "%" },
    "Brake Bias": { paths: ["brakeBias"], step: CLICK_STEP, min: 50, max: 60, unit: "%" },
    "Front Left Tyre Pressure": { paths: ["frontLeftTyrePressure"], step: { small: 0.1, medium: 0.3, large: 0.5 }, min: 22.5, max: 29.5, integer: false, unit: "psi" },
    "Front Right Tyre Pressure": { paths: ["frontRightTyrePressure"], step: { small: 0.1, medium: 0.3, large: 0.5 }, min: 22.5, max: 29.5, integer: false, unit: "psi" },
    "Rear Left Tyre Pressure": { paths: ["rearLeftTyrePressure"], step: { small: 0.1, medium: 0.3, large: 0.5 }, min: 20.5, max: 26.5, integer: false, unit: "psi" },
    "Rear Right Tyre Pressure": { paths: ["rearRightTyrePressure"], step: { small: 0.1, medium: 0.3, large: 0.5 }, min: 20.5, max: 26.5, integer: false, unit: "psi" },
  },
};

export interface CarRange {
  min: number;
  max: number;
  step: number;
}
export interface FixedCarRange {
  status: "fixed";
}
export type AcEvoRange = CarRange | FixedCarRange | null;

const AC_EVO_CAR_RANGES = acEvoRangesJson as unknown as Record<string, Record<string, AcEvoRange>>;

/** Extracted per-car AC Evo ranges, addressed by slug or display name. */
export function getAcEvoCarRanges(carModel?: string): Record<string, AcEvoRange> | null {
  if (!carModel) return null;
  const direct = AC_EVO_CAR_RANGES[carModel];
  if (direct) return direct;
  const car = getAcEvoCarByDisplayName(carModel);
  return (car && AC_EVO_CAR_RANGES[car.model]) ?? null;
}

export type SetupCapabilityStatus = "adjustable" | "fixed" | "unavailable";
export interface SetupCapability {
  control: string;
  status: SetupCapabilityStatus;
  unit: string | null;
  min: number | null;
  max: number | null;
  step: number | null;
  gameVersion: string | null;
  carVersion: string | null;
  trackConstraints: readonly string[];
}

/** One authoritative per-game/car capability view; null versions mean unknown. */
export function getSetupCapabilities(gameId: GameId, carModel?: string): SetupCapability[] {
  const table = RULES[gameId] ?? {};
  if (gameId !== "ac-evo") {
    return Object.entries(table).map(([, def]) => ({
      control: def.rangeKey ?? def.paths[0]!,
      status: "adjustable",
      unit: def.unit ?? null,
      min: def.min,
      max: def.max,
      step: def.step.small,
      gameVersion: null,
      carVersion: null,
      trackConstraints: [],
    }));
  }
  const ranges = getAcEvoCarRanges(carModel);
  const capabilityFor = (control: string, range: AcEvoRange): SetupCapability => {
    const def = Object.values(table).find((candidate) =>
      (candidate.rangeKey ?? candidate.paths[0]) === control,
    );
    if (range == null) return {
      control, status: "unavailable", unit: def?.unit ?? null,
      min: null, max: null, step: null, gameVersion: null, carVersion: null, trackConstraints: [],
    };
    if ("status" in range) return {
      control, status: "fixed", unit: null,
      min: null, max: null, step: null, gameVersion: null, carVersion: null, trackConstraints: [],
    };
    return {
      control, status: "adjustable", unit: def?.unit ?? null,
      min: range.min, max: range.max, step: range.step,
      gameVersion: null, carVersion: null, trackConstraints: [],
    };
  };
  if (!ranges) {
    return Object.entries(table).map(([, def]) => ({
      control: def.rangeKey ?? def.paths[0]!,
      status: "unavailable",
      unit: def.unit ?? null,
      min: null, max: null, step: null, gameVersion: null, carVersion: null, trackConstraints: [],
    }));
  }
  return Object.entries(ranges).map(([control, range]) => capabilityFor(control, range));
}

/** Prompt-ready capability contract from the same rule/range catalog. */
export function renderSetupCapabilityBlock(gameId: GameId, carModel?: string): string {
  const capabilities = getSetupCapabilities(gameId, carModel);
  const lines = capabilities.map((capability) => {
    const labels = Object.entries(RULES[gameId] ?? {})
      .filter(([, def]) => (def.rangeKey ?? def.paths[0]) === capability.control)
      .map(([label]) => label);
    const label = labels.length ? labels.join(" / ") : capability.control;
    const values = capability.status === "adjustable"
      ? `; ${capability.min}–${capability.max}; step ${capability.step}; unit ${capability.unit ?? "unknown"}`
      : "";
    return `  - ${label}: ${capability.status}${values}`;
  });
  return [
    "=== SETUP CAPABILITIES (authoritative; omit fixed/unavailable controls and numeric targets without known units) ===",
    "Game version: unknown; car version: unknown; track constraints: none established.",
    ...lines,
  ].join("\n");
}

/** Per-game rule table narrowed by extracted AC Evo per-car capabilities. */
export function getRuleTable(gameId: GameId, carModel?: string): Record<string, FieldDef> | null {
  const base = RULES[gameId] ?? null;
  if (!base) return null;
  if (gameId !== "ac-evo" || !carModel) return base;
  const car = AC_EVO_CAR_RANGES[carModel] ?? (() => {
    const car = getAcEvoCarByDisplayName(carModel);
    return car ? AC_EVO_CAR_RANGES[car.model] : undefined;
  })();
  if (!car) return base;

  const narrowed: Record<string, FieldDef> = {};
  for (const [component, def] of Object.entries(base)) {
    const key = def.rangeKey ?? def.paths[0]!;
    const range = car[key];
    // A matched car's catalog is authoritative: absent/null means unavailable.
    if (!range || "status" in range) continue;
    narrowed[component] = {
      ...def,
      min: range.min,
      max: range.max,
      step: scaledSteps(range.step),
      integer: Number.isInteger(range.step) && Number.isInteger(range.min) ? def.integer : false,
    };
  }
  return narrowed;
}

/** Component names known for game/car, embedded verbatim in intent prompts. */
export function knownComponents(gameId: GameId, carModel?: string): string[] {
  const table = getRuleTable(gameId, carModel);
  return table ? Object.keys(table) : [];
}

/** Prompt block listing hard clamp ranges for a matched AC Evo car. */
export function renderKnobLimitsBlock(gameId: GameId, carModel?: string): string {
  const header = "=== KNOB LIMITS (hard clamps — intents past these are wasted) ===";
  const matched = gameId === "ac-evo" && !!getAcEvoCarRanges(carModel);
  if (!matched) {
    return `${header}\nTuning ranges unknown for this car — prefer small/medium magnitudes; the engine clamps to real limits.`;
  }
  const table = getRuleTable(gameId, carModel)!;
  const lines = Object.entries(table)
    .map(([component, def]) => `  - ${component}: ${def.min} to ${def.max} (small step ${def.step.small})`)
    .join("\n");
  return `${header}\n${lines}\nDo not suggest "increase" on a knob already at max, or "decrease" at min.`;
}
