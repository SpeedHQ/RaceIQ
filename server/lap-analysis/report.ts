import { lapClassificationLabel, type ClassifiedLap } from "../../shared/racing/laps/classification";
import { eligibilityDecisionText } from "../../shared/racing/quality/display";
import { isEligibilityUsable, resolveEligibilityDecision, type QualitySnapshotEvidence } from "../../shared/racing/quality/policies";
import { semanticLapFrames, type SemanticLapFrame } from "../../shared/racing/analysis/laps/semantic-frame";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import type { FindingRecord } from "../../shared/racing/findings/types";
import { renderFindingsReport } from "../../shared/racing/findings/render";

export type UnitSystem = "metric" | "imperial";
export type TemperatureUnit = "C" | "F";

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function unitToSpeed(unit: UnitSystem) {
  return unit === "metric" ? ("kmh" as const) : ("mph" as const);
}
function unitToTemp(unit: UnitSystem): TemperatureUnit {
  return unit === "metric" ? "C" : "F";
}

function convertTemp(value: number, unit: "F" | "C", source: "F" | "C" = "F"): number {
  if (source === unit) return value;
  return source === "F" ? ((value - 32) * 5) / 9 : (value * 9) / 5 + 32;
}

function formatFinite(value: number | undefined, digits = 0): string {
  return finiteNumber(value) ? value.toFixed(digits) : "unavailable";
}

/**
 * Generate a Claude-formatted lap export summary.
 */
export function generateExport(
  lap: ClassifiedLap &
    QualitySnapshotEvidence & {
      lapNumber: number;
      lapTime: number;
      isValid: boolean;
      carOrdinal?: number;
      trackOrdinal?: number;
    },
  samples: readonly SemanticTelemetrySample[],
  unit: UnitSystem = "metric",
  temperatureUnit?: TemperatureUnit,
  findings?: readonly FindingRecord[],
): string {
  const packets = semanticLapFrames(samples);
  const decision = resolveEligibilityDecision(lap, "corner-trace");
  if (!isEligibilityUsable(decision)) throw new Error(eligibilityDecisionText(decision));
  if (packets.length === 0) return "";

  const speedUnit = unitToSpeed(unit);
  const tempUnit = temperatureUnit ?? unitToTemp(unit);
  const srcTemp = "C" as const;
  const speedFactor = speedUnit === "kmh" ? 3.6 : 2.237;
  const speedLabel = speedUnit === "kmh" ? "km/h" : "mph";
  const tempLabel = tempUnit === "C" ? "C" : "F";

  // Collect finite evidence per channel. A missing channel must not pollute a
  // valid aggregate or fabricate zero-valued telemetry.
  const speeds = new Array<number | undefined>(packets.length);
  let minSpeed = Infinity;
  let maxSpeed = -Infinity;
  let speedSum = 0;
  let speedCount = 0;
  let minRpm = Infinity;
  let maxRpm = -Infinity;
  let rpmSum = 0;
  let rpmCount = 0;
  let throttleSum = 0;
  let throttleCount = 0;
  let fullThrottleCount = 0;
  let brakeSum = 0;
  let brakeCount = 0;
  let fullBrakeCount = 0;
  const tireTemperatureSums = [0, 0, 0, 0];
  const tireTemperatureCounts = [0, 0, 0, 0];
  const suspensionSums = [0, 0, 0, 0];
  const suspensionCounts = [0, 0, 0, 0];
  const gearCounts = new Map<number, number>();

  for (let index = 0; index < packets.length; index++) {
    const packet = packets[index];
    const [vx, vy, vz] = packet.velocityMps;
    if (finiteNumber(vx) && finiteNumber(vy) && finiteNumber(vz)) {
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz) * speedFactor;
      if (finiteNumber(speed)) {
        speeds[index] = speed;
        minSpeed = Math.min(minSpeed, speed);
        maxSpeed = Math.max(maxSpeed, speed);
        speedSum += speed;
        speedCount++;
      }
    }

    if (finiteNumber(packet.engineRpm)) {
      minRpm = Math.min(minRpm, packet.engineRpm);
      maxRpm = Math.max(maxRpm, packet.engineRpm);
      rpmSum += packet.engineRpm;
      rpmCount++;
    }

    if (finiteNumber(packet.throttleInput)) {
      const throttle = packet.throttleInput / 255;
      throttleSum += throttle;
      throttleCount++;
      if (throttle > 0.95) fullThrottleCount++;
    }
    if (finiteNumber(packet.brakeInput)) {
      const brake = packet.brakeInput / 255;
      brakeSum += brake;
      brakeCount++;
      if (brake > 0.95) fullBrakeCount++;
    }

    for (let wheel = 0; wheel < 4; wheel++) {
      const temperature = packet.tireTemperature[wheel];
      if (finiteNumber(temperature)) {
        tireTemperatureSums[wheel] += temperature;
        tireTemperatureCounts[wheel]++;
      }
      const travel = packet.suspensionTravelM[wheel];
      if (finiteNumber(travel)) {
        suspensionSums[wheel] += travel;
        suspensionCounts[wheel]++;
      }
    }
    if (finiteNumber(packet.gear) && Number.isInteger(packet.gear)) {
      gearCounts.set(packet.gear, (gearCounts.get(packet.gear) ?? 0) + 1);
    }
  }

  const avgSpeed = speedCount > 0 ? speedSum / speedCount : undefined;
  const avgRpm = rpmCount > 0 ? rpmSum / rpmCount : undefined;
  const avgThrottle = throttleCount > 0 ? throttleSum / throttleCount : undefined;
  const fullThrottle = throttleCount > 0 ? fullThrottleCount / throttleCount : undefined;
  const avgBrake = brakeCount > 0 ? brakeSum / brakeCount : undefined;
  const fullBrake = brakeCount > 0 ? fullBrakeCount / brakeCount : undefined;
  const avgTireTemperatures = tireTemperatureSums.map((sum, wheel) => (tireTemperatureCounts[wheel] > 0 ? convertTemp(sum / tireTemperatureCounts[wheel], tempUnit, srcTemp) : undefined));
  const avgSuspensionTravel = suspensionSums.map((sum, wheel) => (suspensionCounts[wheel] > 0 ? sum / suspensionCounts[wheel] : undefined));

  const gearTotal = Array.from(gearCounts.values()).reduce((sum, count) => sum + count, 0);
  const gearDist =
    gearTotal > 0
      ? Array.from(gearCounts.entries())
          .filter(([gear]) => gear > 0) // Skip neutral/reverse
          .sort(([a], [b]) => a - b)
          .map(([gear, count]) => {
            const pct = ((count / gearTotal) * 100).toFixed(0);
            const gearName = gear === 11 ? "R" : `${gear}`;
            return `${gearName}: ${pct}%`;
          })
          .join(" | ")
      : "unavailable";

  const brakingZones = findBrakingZones(packets, speeds);

  // Tire wear (use last packet values)
  const last = packets[packets.length - 1];

  const lapTimeStr = finiteNumber(lap.lapTime) ? `${Math.floor(lap.lapTime / 60)}:${(lap.lapTime % 60).toFixed(3).padStart(6, "0")}` : "unavailable";

  let output = `=== RaceIQ Lap Export ===
Car: #${lap.carOrdinal ?? "unavailable"} | Class: unavailable | Drivetrain: unavailable
Track: #${lap.trackOrdinal ?? "unavailable"} | Lap: ${lap.lapNumber} | Time: ${lapTimeStr} | Valid: ${lap.isValid ? "Yes" : "No"} | Classification: ${lapClassificationLabel(lap)}

--- Performance Summary ---
Speed (${speedLabel}):    min=${formatFinite(speedCount > 0 ? minSpeed : undefined, 1)}  avg=${formatFinite(avgSpeed, 1)}  max=${formatFinite(speedCount > 0 ? maxSpeed : undefined, 1)}
RPM:            min=${formatFinite(rpmCount > 0 ? minRpm : undefined)}  avg=${formatFinite(avgRpm)}  max=${formatFinite(rpmCount > 0 ? maxRpm : undefined)}
Throttle:       avg=${formatFinite(avgThrottle == null ? undefined : avgThrottle * 100)}%   full=${formatFinite(fullThrottle == null ? undefined : fullThrottle * 100)}%
Brake:          avg=${formatFinite(avgBrake == null ? undefined : avgBrake * 100)}%   full=${formatFinite(fullBrake == null ? undefined : fullBrake * 100)}%

--- Tire Temps (avg ${tempLabel}) ---
FL: ${formatFinite(avgTireTemperatures[0])}  FR: ${formatFinite(avgTireTemperatures[1])}  RL: ${formatFinite(avgTireTemperatures[2])}  RR: ${formatFinite(avgTireTemperatures[3])}

--- Gear Distribution ---
${gearDist}

--- Braking Zones (top 5 by speed delta) ---
`;

  for (let i = 0; i < Math.min(5, brakingZones.length); i++) {
    const bz = brakingZones[i];
    output += `${i + 1}. Speed ${bz.startSpeed.toFixed(0)}->${bz.endSpeed.toFixed(0)} ${speedLabel} at ${bz.distance.toFixed(0)}m\n`;
  }

  output += `
--- Suspension Travel (avg m) ---
FL: ${formatFinite(avgSuspensionTravel[0], 4)}m  FR: ${formatFinite(avgSuspensionTravel[1], 4)}m  RL: ${formatFinite(avgSuspensionTravel[2], 4)}m  RR: ${formatFinite(avgSuspensionTravel[3], 4)}m

--- Tire Wear ---
FL: ${formatFinite(last?.tireWear[0], 2)}  FR: ${formatFinite(last?.tireWear[1], 2)}  RL: ${formatFinite(last?.tireWear[2], 2)}  RR: ${formatFinite(last?.tireWear[3], 2)}
${
  findings
    ? `
--- Deterministic Findings ---
${renderFindingsReport(findings)}
`
    : ""
}
Paste this into a Claude conversation for tuning advice.`;

  return output;
}

interface BrakingZone {
  startSpeed: number;
  endSpeed: number;
  distance: number; // DistanceTraveled at brake point
}

function findBrakingZones(packets: SemanticLapFrame[], speeds: readonly (number | undefined)[]): BrakingZone[] {
  const zones: BrakingZone[] = [];
  let inBraking = false;
  let brakeStartIdx = 0;
  let peakSpeed: number | undefined;
  let minSpeedInZone: number | undefined;

  for (let i = 1; i < packets.length; i++) {
    const brake = packets[i].brakeInput;
    const previousSpeed = speeds[i - 1];
    const speed = speeds[i];
    const braking = finiteNumber(brake) && brake > 50 && finiteNumber(speed);

    if (braking) {
      if (!inBraking) {
        inBraking = finiteNumber(previousSpeed);
        if (!inBraking) continue;
        brakeStartIdx = i;
        peakSpeed = previousSpeed;
        minSpeedInZone = speed;
      } else if (finiteNumber(minSpeedInZone)) {
        minSpeedInZone = Math.min(minSpeedInZone, speed);
      }
    } else if (inBraking) {
      inBraking = false;
      const distance = packets[brakeStartIdx].distanceM;
      if (finiteNumber(peakSpeed) && finiteNumber(minSpeedInZone) && finiteNumber(distance) && peakSpeed - minSpeedInZone > 10) {
        zones.push({ startSpeed: peakSpeed, endSpeed: minSpeedInZone, distance });
      }
    }
  }

  zones.sort((a, b) => b.startSpeed - b.endSpeed - (a.startSpeed - a.endSpeed));
  return zones.slice(0, 5);
}
