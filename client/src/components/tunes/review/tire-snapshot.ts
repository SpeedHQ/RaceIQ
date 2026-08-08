import type { TelemetryPacket } from "@shared/telemetry/types";

export interface CornerSnap {
  tempC: number;
  wear: number;
  pressure: number;
  brakeTemp: number;
}

/** End-of-lap tyre snapshot: averaged temp/pressure/brake-temp, wear at end. */
export function tireSnapshot(pkts: TelemetryPacket[]): Record<"FL" | "FR" | "RL" | "RR", CornerSnap> | null {
  if (pkts.length === 0) return null;
  const last = pkts[pkts.length - 1];
  const avg = (sel: (p: TelemetryPacket) => number | undefined) => {
    let s = 0;
    for (const p of pkts) s += sel(p) ?? 0;
    return s / pkts.length;
  };
  return {
    FL: { tempC: avg((p) => p.TireTempFL), wear: last.TireWearFL, pressure: avg((p) => p.TirePressureFrontLeft), brakeTemp: avg((p) => p.BrakeTempFrontLeft) },
    FR: { tempC: avg((p) => p.TireTempFR), wear: last.TireWearFR, pressure: avg((p) => p.TirePressureFrontRight), brakeTemp: avg((p) => p.BrakeTempFrontRight) },
    RL: { tempC: avg((p) => p.TireTempRL), wear: last.TireWearRL, pressure: avg((p) => p.TirePressureRearLeft), brakeTemp: avg((p) => p.BrakeTempRearLeft) },
    RR: { tempC: avg((p) => p.TireTempRR), wear: last.TireWearRR, pressure: avg((p) => p.TirePressureRearRight), brakeTemp: avg((p) => p.BrakeTempRearRight) },
  };
}
import type { SemanticTuneSample } from "../semantic-tune";
import { wheelValue } from "../semantic-tune";

export function semanticTireSnapshot(samples: SemanticTuneSample[]): Record<"FL" | "FR" | "RL" | "RR", CornerSnap> | null {
  if (samples.length === 0) return null;
  const last = samples[samples.length - 1];
  const avg = (id: keyof SemanticTuneSample["values"], i: number) => {
    const values = samples.map((s) => wheelValue(s, id, i)).filter((v): v is number => v != null);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  }
  return {
    FL: { tempC: avg("tire.temperature.average", 0), wear: wheelValue(last, "tires.tire-wear", 0) ?? 0, pressure: avg("tires.tire-pressure", 0), brakeTemp: avg("brakes.brake-temp", 0) },
    FR: { tempC: avg("tire.temperature.average", 1), wear: wheelValue(last, "tires.tire-wear", 1) ?? 0, pressure: avg("tires.tire-pressure", 1), brakeTemp: avg("brakes.brake-temp", 1) },
    RL: { tempC: avg("tire.temperature.average", 2), wear: wheelValue(last, "tires.tire-wear", 2) ?? 0, pressure: avg("tires.tire-pressure", 2), brakeTemp: avg("brakes.brake-temp", 2) },
    RR: { tempC: avg("tire.temperature.average", 3), wear: wheelValue(last, "tires.tire-wear", 3) ?? 0, pressure: avg("tires.tire-pressure", 3), brakeTemp: avg("brakes.brake-temp", 3) },
  };
}
