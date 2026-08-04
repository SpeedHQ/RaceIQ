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
