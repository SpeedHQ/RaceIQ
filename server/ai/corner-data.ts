import { semanticLapFrames, type SemanticLapFrame } from "../../shared/racing/analysis/laps/semantic-frame";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";

export interface CornerDef {
  index: number;
  label: string;
  distanceStart: number;
  distanceEnd: number;
}

export interface CornerMetrics {
  label: string;
  entrySpeed: number | null;
  minSpeed: number | null;
  exitSpeed: number | null;
  gear: number | null;
  brakingDistance: number | null;
  timeInCorner: number | null;
  avgThrottle: number | null;
  avgBrake: number | null;
  throttleOnDist: number | null;
  balance: "oversteer" | "understeer" | "neutral" | null;
}

function packetSpeed(p: SemanticLapFrame, factor: number): number | undefined {
  const [vx, vy, vz] = p.velocityMps;
  if (typeof vx !== "number" || !Number.isFinite(vx) || typeof vy !== "number" || !Number.isFinite(vy) || typeof vz !== "number" || !Number.isFinite(vz)) {
    return undefined;
  }
  const speed = Math.sqrt(vx * vx + vy * vy + vz * vz) * factor;
  return Number.isFinite(speed) ? speed : undefined;
}

function formatCornerValue(value: number | null, digits: number): string {
  return value == null ? "unavailable" : value.toFixed(digits);
}

/**
 * Pure per-corner telemetry math. Single source of truth for corner metrics —
 * `buildCornerData` (prompt string) and `getCornerMetricsTool` (structured tool
 * output) both consume this. Corners with no packets in range are skipped, so
 * the returned array may be shorter than `corners`.
 */
export function computeCornerMetrics(samples: readonly SemanticTelemetrySample[], corners: CornerDef[], speedUnit: "mph" | "kmh" = "mph"): CornerMetrics[] {
  const packets = semanticLapFrames(samples);
  const validCorners = corners.filter((corner) => Number.isFinite(corner.distanceStart) && Number.isFinite(corner.distanceEnd) && corner.distanceEnd >= corner.distanceStart);
  if (validCorners.length === 0 || packets.length === 0) return [];

  const speedFactor = speedUnit === "kmh" ? 3.6 : 2.237;
  const metrics: CornerMetrics[] = [];

  for (const corner of validCorners) {
    const cornerPackets = packets.filter(
      (packet): packet is SemanticLapFrame & { readonly distanceM: number } =>
        typeof packet.distanceM === "number" && Number.isFinite(packet.distanceM) && packet.distanceM >= corner.distanceStart && packet.distanceM <= corner.distanceEnd,
    );
    if (cornerPackets.length === 0) continue;

    const speeds = cornerPackets.map((p) => packetSpeed(p, speedFactor)).filter((speed): speed is number => Number.isFinite(speed));
    const entrySpeed = speeds[0] ?? null;
    const minSpeed = speeds.length > 0 ? Math.min(...speeds) : null;
    const exitSpeed = speeds.length > 0 ? speeds[speeds.length - 1] : null;

    const gearCounts = new Map<number, number>();
    for (const p of cornerPackets) {
      if (typeof p.gear === "number" && Number.isInteger(p.gear) && p.gear > 0) gearCounts.set(p.gear, (gearCounts.get(p.gear) ?? 0) + 1);
    }
    let gear: number | null = null;
    let maxCount = 0;
    for (const [g, count] of gearCounts) {
      if (count > maxCount) {
        gear = g;
        maxCount = count;
      }
    }

    // Find the packet index nearest to corner start, then scan backwards for braking
    const cornerStartDist = corner.distanceStart;
    let nearestIdx = 0;
    let nearestDelta = Infinity;
    for (let i = 0; i < packets.length; i++) {
      const distance = packets[i]?.distanceM;
      if (typeof distance !== "number" || !Number.isFinite(distance)) continue;
      const delta = Math.abs(distance - cornerStartDist);
      if (delta < nearestDelta) {
        nearestDelta = delta;
        nearestIdx = i;
      }
      if (distance > cornerStartDist) break;
    }
    let brakingDistance: number | null = null;
    for (let i = nearestIdx; i >= 0; i--) {
      const packet = packets[i];
      if (!packet || typeof packet.distanceM !== "number" || !Number.isFinite(packet.distanceM)) continue;
      if (typeof packet.brakeInput === "number" && Number.isFinite(packet.brakeInput) && packet.brakeInput > 50) {
        brakingDistance = cornerStartDist - packet.distanceM;
        while (i > 0) {
          const previous = packets[i - 1];
          if (!previous || typeof previous.brakeInput !== "number" || !Number.isFinite(previous.brakeInput) || previous.brakeInput <= 50) {
            break;
          }
          i--;
          const distance = packets[i]?.distanceM;
          if (typeof distance === "number" && Number.isFinite(distance)) brakingDistance = cornerStartDist - distance;
        }
        break;
      }
      if (cornerStartDist - packet.distanceM > 300) break;
    }

    const firstObservedAt = cornerPackets[0]?.observedAtMs;
    const lastObservedAt = cornerPackets[cornerPackets.length - 1]?.observedAtMs;
    const timeInCorner =
      typeof firstObservedAt === "number" && Number.isFinite(firstObservedAt) && typeof lastObservedAt === "number" && Number.isFinite(lastObservedAt) && lastObservedAt >= firstObservedAt
        ? (lastObservedAt - firstObservedAt) / 1000
        : null;
    let throttleSum = 0;
    let throttleCount = 0;
    let brakeSum = 0;
    let brakeCount = 0;
    let throttleOnDist: number | null = null;
    let frontSlipSum = 0;
    let rearSlipSum = 0;
    let slipCount = 0;
    for (const packet of cornerPackets) {
      if (typeof packet.throttleInput === "number" && Number.isFinite(packet.throttleInput)) {
        throttleSum += packet.throttleInput / 255;
        throttleCount++;
        if (throttleOnDist == null && packet.throttleInput / 255 > 0.5) throttleOnDist = packet.distanceM - corner.distanceStart;
      }
      if (typeof packet.brakeInput === "number" && Number.isFinite(packet.brakeInput)) {
        brakeSum += packet.brakeInput / 255;
        brakeCount++;
      }
      const [frontLeft, frontRight, rearLeft, rearRight] = packet.tireSlipAngleRad;
      if (
        typeof frontLeft === "number" &&
        Number.isFinite(frontLeft) &&
        typeof frontRight === "number" &&
        Number.isFinite(frontRight) &&
        typeof rearLeft === "number" &&
        Number.isFinite(rearLeft) &&
        typeof rearRight === "number" &&
        Number.isFinite(rearRight)
      ) {
        frontSlipSum += (Math.abs(frontLeft) + Math.abs(frontRight)) / 2;
        rearSlipSum += (Math.abs(rearLeft) + Math.abs(rearRight)) / 2;
        slipCount++;
      }
    }
    const avgThrottle = throttleCount > 0 ? (throttleSum / throttleCount) * 100 : null;
    const avgBrake = brakeCount > 0 ? (brakeSum / brakeCount) * 100 : null;
    const balance =
      slipCount > 0 ? (rearSlipSum / slipCount > (frontSlipSum / slipCount) * 1.3 ? "oversteer" : frontSlipSum / slipCount > (rearSlipSum / slipCount) * 1.3 ? "understeer" : "neutral") : null;

    metrics.push({
      label: corner.label,
      entrySpeed,
      minSpeed,
      exitSpeed,
      gear,
      brakingDistance,
      timeInCorner,
      avgThrottle,
      avgBrake,
      throttleOnDist,
      balance,
    });
  }

  return metrics;
}

export function buildCornerData(samples: readonly SemanticTelemetrySample[], corners: CornerDef[], speedUnit: "mph" | "kmh" = "mph"): string {
  const speedLabel = speedUnit === "kmh" ? "km/h" : "mph";
  const metrics = computeCornerMetrics(samples, corners, speedUnit);

  if (metrics.length === 0) return "";

  let out = "\n--- Corner-by-Corner Data ---\n";
  out += `Corner | Entry ${speedLabel} | Min ${speedLabel} | Exit ${speedLabel} | Gear | Brake dist m | Time s | Throttle% | Brake% | Throttle-on m | Balance\n`;
  out += "-------|-----------|---------|----------|------|-------------|--------|-----------|--------|--------------|--------\n";
  for (const metric of metrics) {
    out += `${metric.label.padEnd(6)} | ${formatCornerValue(metric.entrySpeed, 0).padStart(9)} | ${formatCornerValue(metric.minSpeed, 0).padStart(7)} | ${formatCornerValue(metric.exitSpeed, 0).padStart(8)} | ${(metric.gear?.toString() ?? "unavailable").padStart(4)} | ${formatCornerValue(metric.brakingDistance, 0).padStart(11)} | ${formatCornerValue(metric.timeInCorner, 1).padStart(6)} | ${formatCornerValue(metric.avgThrottle, 0).padStart(9)} | ${formatCornerValue(metric.avgBrake, 0).padStart(5)} | ${formatCornerValue(metric.throttleOnDist, 0).padStart(12)} | ${metric.balance ?? "unavailable"}\n`;
  }

  const sorted = [...metrics].sort((left, right) => {
    const leftRatio = left.entrySpeed != null && left.exitSpeed != null && left.entrySpeed > 0 ? left.exitSpeed / left.entrySpeed : Infinity;
    const rightRatio = right.entrySpeed != null && right.exitSpeed != null && right.entrySpeed > 0 ? right.exitSpeed / right.entrySpeed : Infinity;
    return leftRatio - rightRatio;
  });
  const problems = sorted.slice(0, 5);
  out += `\nTop problem corners (lowest exit/entry speed ratio): ${problems.map((p) => p.label).join(", ")}\n`;

  return out;
}
