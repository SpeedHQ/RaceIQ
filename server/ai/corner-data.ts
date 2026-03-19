import type { TelemetryPacket } from "../../shared/types";

interface CornerDef {
  index: number;
  label: string;
  distanceStart: number;
  distanceEnd: number;
}

interface CornerMetrics {
  label: string;
  entrySpeed: number;
  minSpeed: number;
  exitSpeed: number;
  gear: number;
  brakingDistance: number;
  timeInCorner: number;
  avgThrottle: number;
  avgBrake: number;
  throttleOnDist: number;
  balance: "oversteer" | "understeer" | "neutral";
}

function packetSpeed(p: TelemetryPacket, factor: number): number {
  return Math.sqrt(p.VelocityX ** 2 + p.VelocityY ** 2 + p.VelocityZ ** 2) * factor;
}

export function buildCornerData(
  packets: TelemetryPacket[],
  corners: CornerDef[],
  speedUnit: "mph" | "kmh" = "mph"
): string {
  if (corners.length === 0 || packets.length === 0) return "";

  const speedFactor = speedUnit === "kmh" ? 3.6 : 2.237;
  const speedLabel = speedUnit === "kmh" ? "km/h" : "mph";
  const metrics: CornerMetrics[] = [];

  for (const corner of corners) {
    const cornerPackets = packets.filter(
      (p) => p.DistanceTraveled >= corner.distanceStart && p.DistanceTraveled <= corner.distanceEnd
    );
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

    // Find the packet index nearest to corner start, then scan backwards for braking
    const cornerStartDist = corner.distanceStart;
    let nearestIdx = 0;
    let nearestDelta = Infinity;
    for (let i = 0; i < packets.length; i++) {
      const delta = Math.abs(packets[i].DistanceTraveled - cornerStartDist);
      if (delta < nearestDelta) { nearestDelta = delta; nearestIdx = i; }
      if (packets[i].DistanceTraveled > cornerStartDist) break;
    }
    let brakingDistance = 0;
    for (let i = nearestIdx; i >= 0; i--) {
      if (packets[i].Brake > 50) {
        brakingDistance = cornerStartDist - packets[i].DistanceTraveled;
        while (i > 0 && packets[i - 1].Brake > 50) {
          i--;
          brakingDistance = cornerStartDist - packets[i].DistanceTraveled;
        }
        break;
      }
      // Stop scanning if we're too far back (more than 300m before corner)
      if (cornerStartDist - packets[i].DistanceTraveled > 300) break;
    }

    const timeInCorner = cornerPackets.length / 60;
    const avgThrottle = cornerPackets.reduce((s, p) => s + p.Accel / 255, 0) / cornerPackets.length * 100;
    const avgBrake = cornerPackets.reduce((s, p) => s + p.Brake / 255, 0) / cornerPackets.length * 100;

    let throttleOnDist = 0;
    for (const p of cornerPackets) {
      if (p.Accel / 255 > 0.5) {
        throttleOnDist = p.DistanceTraveled - corner.distanceStart;
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
      brakingDistance, timeInCorner, avgThrottle, avgBrake, throttleOnDist, balance,
    });
  }

  if (metrics.length === 0) return "";

  let out = "\n--- Corner-by-Corner Data ---\n";
  out += `Corner | Entry ${speedLabel} | Min ${speedLabel} | Exit ${speedLabel} | Gear | Brake dist m | Time s | Throttle% | Brake% | Throttle-on m | Balance\n`;
  out += "-------|-----------|---------|----------|------|-------------|--------|-----------|--------|--------------|--------\n";
  for (const m of metrics) {
    out += `${m.label.padEnd(6)} | ${m.entrySpeed.toFixed(0).padStart(9)} | ${m.minSpeed.toFixed(0).padStart(7)} | ${m.exitSpeed.toFixed(0).padStart(8)} | ${m.gear.toString().padStart(4)} | ${m.brakingDistance.toFixed(0).padStart(11)} | ${m.timeInCorner.toFixed(1).padStart(6)} | ${m.avgThrottle.toFixed(0).padStart(9)} | ${m.avgBrake.toFixed(0).padStart(5)} | ${m.throttleOnDist.toFixed(0).padStart(12)} | ${m.balance}\n`;
  }

  const sorted = [...metrics].sort((a, b) => {
    const ratioA = a.exitSpeed / (a.entrySpeed || 1);
    const ratioB = b.exitSpeed / (b.entrySpeed || 1);
    return ratioA - ratioB;
  });
  const problems = sorted.slice(0, 5);
  out += `\nTop problem corners (lowest exit/entry speed ratio): ${problems.map(p => p.label).join(", ")}\n`;

  return out;
}
