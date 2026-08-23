import type { GameId } from "@shared/games/ids";
import { getGame } from "@shared/games/registry";
import type { LiveTelemetryView } from "@/lib/live-telemetry-view";
import type { SemanticReplayFrame } from "../../hooks/laps";

export interface TuneWheelValues {
  fl: number;
  fr: number;
  rl: number;
  rr: number;
}

export interface SemanticTuneSample {
  gameId: GameId;
  trackOrdinal?: number;
  positionM?: { x: number; z: number };
  distanceM?: number;
  speedMps?: number;
  tireTemperatureC?: TuneWheelValues;
  brakeTemperatureC?: TuneWheelValues;
  tirePressurePsi?: TuneWheelValues;
  tireWearFraction?: TuneWheelValues;
  fuelLiters?: number;
  fuelFraction?: number;
}

export type TuneWheelMetric = "tireTemperatureC" | "brakeTemperatureC" | "tirePressurePsi" | "tireWearFraction";

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function wheelValues(value: unknown): TuneWheelValues | undefined {
  if (!Array.isArray(value) || value.length < 4 || !value.slice(0, 4).every((item) => typeof item === "number" && Number.isFinite(item))) return undefined;
  return { fl: value[0], fr: value[1], rl: value[2], rr: value[3] };
}

function sampleFromValues(gameId: GameId, values: Readonly<Record<string, unknown>>): SemanticTuneSample {
  const positionX = finiteNumber(values["motion.position-x"]);
  const positionZ = finiteNumber(values["motion.position-z"]);
  const fuel = finiteNumber(values["fuel.fuel"]);
  const fuelUnit = getGame(gameId).telemetry.fuel.packetUnit;
  return {
    gameId,
    distanceM: finiteNumber(values["timing.distance-traveled"]),
    speedMps: finiteNumber(values["motion.speed"]),
    trackOrdinal: finiteNumber(values["identity.track-ordinal"]),
    positionM: positionX === undefined || positionZ === undefined ? undefined : { x: positionX, z: positionZ },
    tireTemperatureC: wheelValues(values["tire.temperature.average"]),
    brakeTemperatureC: wheelValues(values["brakes.brake-temp"]),
    tirePressurePsi: wheelValues(values["tires.tire-pressure"]),
    tireWearFraction: wheelValues(values["tires.tire-wear"]),
    fuelLiters: fuelUnit === "litre" ? fuel : undefined,
    fuelFraction: fuelUnit === "fraction" ? fuel : undefined,
  };
}

export function semanticSamples(gameId: GameId, frames: SemanticReplayFrame[] | undefined): SemanticTuneSample[] {
  return (frames ?? [])
    .filter((frame) => frame.simulator === gameId)
    .map((frame) => {
      const values = Object.fromEntries(
        frame.values.filter((entry) => (!entry.state || entry.state === "ok") && (!entry.freshness || entry.freshness === "fresh")).map((entry) => [entry.semanticId, entry.value]),
      );
      return sampleFromValues(gameId, values);
    });
}

export function semanticTuneSampleFromView(view: LiveTelemetryView): SemanticTuneSample {
  const fuelUnit = getGame(view.simulator).telemetry.fuel.packetUnit;
  return {
    gameId: view.simulator,
    distanceM: view.motion.distanceM,
    speedMps: view.motion.speedMps,
    trackOrdinal: view.identity.trackOrdinal,
    positionM: view.motion.position,
    tireTemperatureC: view.tires.temperatureC,
    brakeTemperatureC: view.tires.brakeTemperatureC,
    tirePressurePsi: view.tires.pressurePsi,
    tireWearFraction: view.tires.wear,
    fuelLiters: fuelUnit === "litre" ? view.fuel.amount : undefined,
    fuelFraction: fuelUnit === "fraction" ? view.fuel.amount : undefined,
  };
}

export function wheelValue(sample: SemanticTuneSample, metric: TuneWheelMetric, index: number): number | undefined {
  const values = sample[metric];
  if (!values) return undefined;
  return [values.fl, values.fr, values.rl, values.rr][index];
}
