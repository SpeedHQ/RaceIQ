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
  tireSurfaceTemperatureC?: TuneWheelValues;
  tireCoreTemperatureC?: TuneWheelValues;
  tireCarcassMiddleTemperatureC?: TuneWheelValues;
  brakeTemperatureC?: TuneWheelValues;
  tirePressurePsi?: TuneWheelValues;
  tireWearFraction?: TuneWheelValues;
  fuel?: number;
  fuelUnit: "litre" | "fraction";
}

export type TuneWheelMetric = "tireSurfaceTemperatureC" | "tireCoreTemperatureC" | "tireCarcassMiddleTemperatureC" | "brakeTemperatureC" | "tirePressurePsi" | "tireWearFraction";

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
    tireSurfaceTemperatureC: wheelValues(values["tire.temperature.surface.representative"]),
    tireCoreTemperatureC: wheelValues(values["tire.temperature.core"]),
    tireCarcassMiddleTemperatureC: wheelValues(values["tire.temperature.carcass.middle"]),
    brakeTemperatureC: wheelValues(values["brakes.brake-temp"]),
    tirePressurePsi: wheelValues(values["tires.tire-pressure"]),
    tireWearFraction: wheelValues(values["tires.tire-wear"]),
    fuel,
    fuelUnit,
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
  const surface = view.tires.surfaceTemperatureC;
  const surfaceValues = surface
    ? [surface.fl.representative, surface.fr.representative, surface.rl.representative, surface.rr.representative]
    : [];
  const tireSurfaceTemperatureC = surfaceValues.length === 4 && surfaceValues.every((value): value is number => typeof value === "number" && Number.isFinite(value))
    ? { fl: surfaceValues[0], fr: surfaceValues[1], rl: surfaceValues[2], rr: surfaceValues[3] }
    : undefined;
  const carcass = view.tires.carcassTemperatureC;
  const carcassValues = carcass
    ? [carcass.fl.middle, carcass.fr.middle, carcass.rl.middle, carcass.rr.middle]
    : [];
  const tireCarcassMiddleTemperatureC = carcassValues.length === 4 && carcassValues.every((value): value is number => typeof value === "number" && Number.isFinite(value))
    ? { fl: carcassValues[0], fr: carcassValues[1], rl: carcassValues[2], rr: carcassValues[3] }
    : undefined;
  return {
    gameId: view.simulator,
    distanceM: view.motion.distanceM,
    speedMps: view.motion.speedMps,
    trackOrdinal: view.identity.trackOrdinal,
    positionM: view.motion.position,
    tireSurfaceTemperatureC,
    tireCoreTemperatureC: view.tires.coreTemperatureC,
    tireCarcassMiddleTemperatureC,
    brakeTemperatureC: view.tires.brakeTemperatureC,
    tirePressurePsi: view.tires.pressurePsi,
    tireWearFraction: view.tires.wear,
    fuel: view.fuel.amount,
    fuelUnit,
  };
}

export function wheelValue(sample: SemanticTuneSample, metric: TuneWheelMetric, index: number): number | undefined {
  const values = sample[metric];
  if (!values) return undefined;
  return [values.fl, values.fr, values.rl, values.rr][index];
}
import type { AlignedLapTrace } from "@shared/racing/laps/alignment/types";

export function semanticTuneSamplesFromAlignedTrace(trace: AlignedLapTrace, gameId: GameId, trackOrdinal: number | undefined, distanceMeters: number): SemanticTuneSample[] {
  const fuelUnit = getGame(gameId).telemetry.fuel.packetUnit;
  return Array.from({ length: trace.speedMps.length }, (_, i) => ({
    gameId,
    trackOrdinal,
    distanceM: trace.frac[i]! * distanceMeters,
    speedMps: trace.speedMps[i]!,
    positionM: Number.isFinite(trace.positionX[i]) && Number.isFinite(trace.positionZ[i]) ? { x: trace.positionX[i]!, z: trace.positionZ[i]! } : undefined,
    fuel: trace.fuel[i]!,
    fuelUnit,
    tireWearFraction: trace.tireWear ? { fl: trace.tireWear.FL[i]!, fr: trace.tireWear.FR[i]!, rl: trace.tireWear.RL[i]!, rr: trace.tireWear.RR[i]! } : undefined,
    tireSurfaceTemperatureC: trace.tireTemp ? { fl: trace.tireTemp.FL[i]!, fr: trace.tireTemp.FR[i]!, rl: trace.tireTemp.RL[i]!, rr: trace.tireTemp.RR[i]! } : undefined,
    tireCoreTemperatureC: trace.tireCoreTemp ? { fl: trace.tireCoreTemp.FL[i]!, fr: trace.tireCoreTemp.FR[i]!, rl: trace.tireCoreTemp.RL[i]!, rr: trace.tireCoreTemp.RR[i]! } : undefined,
    tireCarcassMiddleTemperatureC: trace.tireCarcassTemp ? { fl: trace.tireCarcassTemp.FL[i]!, fr: trace.tireCarcassTemp.FR[i]!, rl: trace.tireCarcassTemp.RL[i]!, rr: trace.tireCarcassTemp.RR[i]! } : undefined,
    tirePressurePsi: trace.tirePressure ? { fl: trace.tirePressure.FL[i]!, fr: trace.tirePressure.FR[i]!, rl: trace.tirePressure.RL[i]!, rr: trace.tirePressure.RR[i]! } : undefined,
    brakeTemperatureC: trace.brakeTemp ? { fl: trace.brakeTemp.FL[i]!, fr: trace.brakeTemp.FR[i]!, rl: trace.brakeTemp.RL[i]!, rr: trace.brakeTemp.RR[i]! } : undefined,
  }));
}
