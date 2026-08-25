import type { SemanticTuneSample, TuneWheelMetric } from "../semantic-tune";
import { wheelValue } from "../semantic-tune";

export interface CornerSnap {
  tempC?: number;
  wear?: number;
  pressure?: number;
  brakeTemp?: number;
}

/** End-of-lap canonical tire snapshot: averaged values and final wear. */
export function tireSnapshot(samples: SemanticTuneSample[]): Record<"FL" | "FR" | "RL" | "RR", CornerSnap> | null {
  if (samples.length === 0) return null;
  const last = samples[samples.length - 1];
  const average = (metric: TuneWheelMetric, index: number): number | undefined => {
    const values = samples.map((sample) => wheelValue(sample, metric, index)).filter((value): value is number => value !== undefined);
    return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
  };
  const corners = ["FL", "FR", "RL", "RR"] as const;
  const snapshots = {} as Record<(typeof corners)[number], CornerSnap>;
  for (let index = 0; index < corners.length; index++) {
    const tempC = average("tireTemperatureC", index);
    const wear = wheelValue(last, "tireWearFraction", index);
    snapshots[corners[index]] = {
      tempC,
      wear,
      pressure: average("tirePressurePsi", index),
      brakeTemp: average("brakeTemperatureC", index),
    };
  }
  return snapshots;
}
