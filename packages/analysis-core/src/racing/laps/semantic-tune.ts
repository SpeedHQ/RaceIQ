import type { GameId } from "@raceiq/shared/games/ids";
import { getGame } from "@raceiq/shared/games/registry";
import type { AlignedLapTrace } from "@raceiq/analysis-core/racing/laps/alignment/types";

export interface TuneWheelValues { fl: number; fr: number; rl: number; rr: number }
export interface SemanticTuneSample {
  gameId: GameId;
  trackId?: string;
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

export function wheelValue(sample: SemanticTuneSample, metric: TuneWheelMetric, index: number): number | undefined {
  const values = sample[metric];
  if (!values) return undefined;
  return [values.fl, values.fr, values.rl, values.rr][index];
}

export function semanticTuneSamplesFromAlignedTrace(trace: AlignedLapTrace, gameId: GameId, trackId: string | undefined, distanceMeters: number): SemanticTuneSample[] {
  const fuelUnit = getGame(gameId).telemetry.fuel.packetUnit;
  return Array.from({ length: trace.speedMps.length }, (_, i) => ({
    gameId, trackId, distanceM: trace.frac[i]! * distanceMeters, speedMps: trace.speedMps[i]!,
    positionM: Number.isFinite(trace.positionX[i]) && Number.isFinite(trace.positionZ[i]) ? { x: trace.positionX[i]!, z: trace.positionZ[i]! } : undefined,
    fuel: trace.fuel[i]!, fuelUnit,
    tireWearFraction: trace.tireWear ? { fl: trace.tireWear.FL[i]!, fr: trace.tireWear.FR[i]!, rl: trace.tireWear.RL[i]!, rr: trace.tireWear.RR[i]! } : undefined,
    tireSurfaceTemperatureC: trace.tireTemp ? { fl: trace.tireTemp.FL[i]!, fr: trace.tireTemp.FR[i]!, rl: trace.tireTemp.RL[i]!, rr: trace.tireTemp.RR[i]! } : undefined,
    tireCoreTemperatureC: trace.tireCoreTemp ? { fl: trace.tireCoreTemp.FL[i]!, fr: trace.tireCoreTemp.FR[i]!, rl: trace.tireCoreTemp.RL[i]!, rr: trace.tireCoreTemp.RR[i]! } : undefined,
    tireCarcassMiddleTemperatureC: trace.tireCarcassTemp ? { fl: trace.tireCarcassTemp.FL[i]!, fr: trace.tireCarcassTemp.FR[i]!, rl: trace.tireCarcassTemp.RL[i]!, rr: trace.tireCarcassTemp.RR[i]! } : undefined,
    tirePressurePsi: trace.tirePressure ? { fl: trace.tirePressure.FL[i]!, fr: trace.tirePressure.FR[i]!, rl: trace.tirePressure.RL[i]!, rr: trace.tirePressure.RR[i]! } : undefined,
    brakeTemperatureC: trace.brakeTemp ? { fl: trace.brakeTemp.FL[i]!, fr: trace.brakeTemp.FR[i]!, rl: trace.brakeTemp.RL[i]!, rr: trace.brakeTemp.RR[i]! } : undefined,
  }));
}
