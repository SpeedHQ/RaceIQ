import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

export interface CornerDef {
  index: number;
  label: string;
  distanceStart: number;
  distanceEnd: number;
}

export interface CornerMetrics {
  label: string;
  entrySpeed: number;
  minSpeed: number;
  exitSpeed: number;
  gear: number;
  /** Signed metres from corner entry to nearest observed brake onset: positive before, negative after. */
  brakeOnsetDistanceM: number | null;
  timeInCorner: number;
  avgThrottle: number;
  avgBrake: number;
  throttleOnDist: number;
  balance: "oversteer" | "understeer" | "neutral";
}

function packetSpeed(p: TelemetryPacket, factor: number): number {
  return Math.sqrt(p.VelocityX ** 2 + p.VelocityY ** 2 + p.VelocityZ ** 2) * factor;
}

/**
 * Pure per-corner telemetry math. Single source of truth for corner metrics —
 * `buildCornerData` (prompt string) and `getCornerMetricsTool` (structured tool
 * output) both consume this. Corners with no packets in range are skipped, so
 * the returned array may be shorter than `corners`.
 */
export function computeCornerMetrics(
  packets: TelemetryPacket[],
  corners: CornerDef[],
  speedUnit: "mph" | "kmh" = "mph"
): CornerMetrics[] {
  if (corners.length === 0 || packets.length === 0) return [];

  const speedFactor = speedUnit === "kmh" ? 3.6 : 2.237;
  // Corner definitions use metres from lap start; telemetry may retain a
  // nonzero absolute distance origin on later laps.
  const distanceOrigin = packets[0].DistanceTraveled;
  const metrics: CornerMetrics[] = [];

  for (const corner of corners) {
    const cornerPackets = packets.filter((p) => {
      const distance = p.DistanceTraveled - distanceOrigin;
      return distance >= corner.distanceStart && distance <= corner.distanceEnd;
    });
    if (cornerPackets.length === 0) continue;

    const speeds = cornerPackets.map(p => packetSpeed(p, speedFactor));
    const entrySpeed = speeds[0];
    const minSpeed = Math.min(...speeds);
    const exitSpeed = speeds[speeds.length - 1];

    const gearCounts = new Map<number, number>();
    for (const p of cornerPackets) {
      gearCounts.set(p.Gear, (gearCounts.get(p.Gear) ?? 0) + 1);
    }
    let gear = 1;
    let maxCount = 0;
    for (const [g, c] of gearCounts) {
      if (g > 0 && c > maxCount) { gear = g; maxCount = c; }
    }

    // Brake onset can fall after a detected corner boundary. Scan the approach
    // and corner for an actual pedal transition; zero is a valid measured value,
    // so keep missing observations null instead of presenting them as zero.
    const cornerStartDist = corner.distanceStart;
    const brakeThreshold = 13; // ~5% of the normalized 0..255 pedal channel
    let nearestBrakeOnsetDistanceM: number | null = null;
    let nearestBrakeOnsetOffset = Infinity;
    for (let i = 1; i < packets.length; i++) {
      const packet = packets[i];
      const packetDistance = packet.DistanceTraveled - distanceOrigin;
      if (packetDistance < cornerStartDist - 300) continue;
      if (packetDistance > corner.distanceEnd) break;
      if (packet.Brake > brakeThreshold && packets[i - 1].Brake <= brakeThreshold) {
        const offset = cornerStartDist - packetDistance;
        if (Math.abs(offset) < nearestBrakeOnsetOffset) {
          nearestBrakeOnsetDistanceM = offset;
          nearestBrakeOnsetOffset = Math.abs(offset);
        }
      }
    }
    const brakeOnsetDistanceM = nearestBrakeOnsetDistanceM;

    const timeInCorner = cornerPackets.length / 60;
    const avgThrottle = cornerPackets.reduce((s, p) => s + p.Accel / 255, 0) / cornerPackets.length * 100;
    const avgBrake = cornerPackets.reduce((s, p) => s + p.Brake / 255, 0) / cornerPackets.length * 100;

    let throttleOnDist = 0;
    for (const p of cornerPackets) {
      if (p.Accel / 255 > 0.5) {
        throttleOnDist = p.DistanceTraveled - distanceOrigin - corner.distanceStart;
        break;
      }
    }

    const avgFrontSlip = cornerPackets.reduce((s, p) =>
      s + (Math.abs(p.TireSlipAngleFL) + Math.abs(p.TireSlipAngleFR)) / 2, 0) / cornerPackets.length;
    const avgRearSlip = cornerPackets.reduce((s, p) =>
      s + (Math.abs(p.TireSlipAngleRL) + Math.abs(p.TireSlipAngleRR)) / 2, 0) / cornerPackets.length;
    const balance = avgRearSlip > avgFrontSlip * 1.3 ? "oversteer"
      : avgFrontSlip > avgRearSlip * 1.3 ? "understeer" : "neutral";

    metrics.push({
      label: corner.label, entrySpeed, minSpeed, exitSpeed, gear,
      brakeOnsetDistanceM, timeInCorner, avgThrottle, avgBrake, throttleOnDist, balance,
    });
  }

  return metrics;
}

export function buildCornerData(
  packets: TelemetryPacket[],
  corners: CornerDef[],
  speedUnit: "mph" | "kmh" = "mph"
): string {
  const speedLabel = speedUnit === "kmh" ? "km/h" : "mph";
  const metrics = computeCornerMetrics(packets, corners, speedUnit);

  if (metrics.length === 0) return "";

  let out = "\n--- Corner-by-Corner Data ---\n";
  out += `Corner | Entry ${speedLabel} | Min ${speedLabel} | Exit ${speedLabel} | Gear | Brake onset Δm* | Time s | Throttle% | Brake% | Throttle-on m | Balance\n`;
  out += "-------|-----------|---------|----------|------|---------------|--------|-----------|--------|--------------|--------\n";
  for (const m of metrics) {
    const brakeOnset = m.brakeOnsetDistanceM == null ? "unknown" : `${m.brakeOnsetDistanceM >= 0 ? "+" : ""}${m.brakeOnsetDistanceM.toFixed(0)}`;
    out += `${m.label.padEnd(6)} | ${m.entrySpeed.toFixed(0).padStart(9)} | ${m.minSpeed.toFixed(0).padStart(7)} | ${m.exitSpeed.toFixed(0).padStart(8)} | ${m.gear.toString().padStart(4)} | ${brakeOnset.padStart(13)} | ${m.timeInCorner.toFixed(1).padStart(6)} | ${m.avgThrottle.toFixed(0).padStart(9)} | ${m.avgBrake.toFixed(0).padStart(5)} | ${m.throttleOnDist.toFixed(0).padStart(12)} | ${m.balance}\n`;
  }
  out += "* Brake onset offset from corner entry; positive = before entry, negative = after entry. Unknown = no pedal onset observed in the 300 m approach or corner.\n";

  const sorted = [...metrics].sort((a, b) => {
    const ratioA = a.exitSpeed / (a.entrySpeed || 1);
    const ratioB = b.exitSpeed / (b.entrySpeed || 1);
    return ratioA - ratioB;
  });
  const problems = sorted.slice(0, 5);
  out += `\nTop problem corners (lowest exit/entry speed ratio): ${problems.map(p => p.label).join(", ")}\n`;

  return out;
}
