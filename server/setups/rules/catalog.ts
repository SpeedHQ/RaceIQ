/** Setup rule catalog: component grammar, paths, steps, and hard clamps. */
import type { GameId } from "../../../shared/games/ids";
import { getAcEvoCarByDisplayName } from "../../../shared/racing/cars/ac-evo"
import acEvoRangesJson from "../../../shared/games/ac-evo/setup-ranges.json";
import type { TuneMagnitude } from "../../ai/schemas";

/** A tunable driver-facing knob and every storage path it controls. */
export interface FieldDef {
  paths: string[];
  step: Record<TuneMagnitude, number>;
  min: number;
  max: number;
  /** Values are integer clicks by default. */
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
    "Front Anti-Roll Bar": { paths: ["frontARB"], step: CLICK_STEP, min: 0, max: 30 },
    "Rear Anti-Roll Bar": { paths: ["rearARB"], step: CLICK_STEP, min: 0, max: 30 },
    "Brake Bias": { paths: ["brakeBias"], step: { small: 0.5, medium: 1, large: 2 }, min: 40, max: 70, integer: false },
    "Front Wing": { paths: ["frontWing"], step: CLICK_STEP, min: 0, max: 20 },
    "Rear Wing": { paths: ["rearWing"], step: CLICK_STEP, min: 0, max: 20 },
  },
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

interface CarRange {
  min: number;
  max: number;
  step: number;
}

const AC_EVO_CAR_RANGES = acEvoRangesJson as unknown as Record<string, Record<string, CarRange | null>>;

/** Extracted per-car AC Evo ranges, addressed by slug or display name. */
export function getAcEvoCarRanges(carModel?: string): Record<string, CarRange | null> | null {
  if (!carModel) return null;
  const direct = AC_EVO_CAR_RANGES[carModel];
  if (direct) return direct;
  const car = getAcEvoCarByDisplayName(carModel);
  return (car && AC_EVO_CAR_RANGES[car.model]) ?? null;
}

/** Per-game rule table narrowed by extracted AC Evo per-car capabilities. */
export function getRuleTable(gameId: GameId, carModel?: string): Record<string, FieldDef> | null {
  const base = RULES[gameId] ?? null;
  if (!base || gameId !== "ac-evo" || !carModel) return base;
  const car = AC_EVO_CAR_RANGES[carModel];
  if (!car) return base;

  const narrowed: Record<string, FieldDef> = {};
  for (const [component, def] of Object.entries(base)) {
    const key = def.paths[0];
    if (!(key in car)) {
      narrowed[component] = def;
      continue;
    }
    const range = car[key];
    if (range === null) continue;
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
  const matched = gameId === "ac-evo" && !!carModel && !!AC_EVO_CAR_RANGES[carModel];
  if (!matched) {
    return `${header}\nTuning ranges unknown for this car — prefer small/medium magnitudes; the engine clamps to real limits.`;
  }
  const table = getRuleTable(gameId, carModel)!;
  const lines = Object.entries(table)
    .map(([component, def]) => `  - ${component}: ${def.min} to ${def.max} (small step ${def.step.small})`)
    .join("\n");
  return `${header}\n${lines}\nDo not suggest "increase" on a knob already at max, or "decrease" at min.`;
}
