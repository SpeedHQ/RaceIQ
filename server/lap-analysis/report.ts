import { lapClassificationLabel, type ClassifiedLap } from "../../shared/racing/laps/classification";
import { eligibilityDecisionText } from "../../shared/racing/quality/display";
import { isEligibilityUsable, resolveEligibilityDecision, type QualitySnapshotEvidence } from "../../shared/racing/quality/policies";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { tryGetGame } from "../../shared/games/registry";
import type { FindingRecord } from "../../shared/racing/findings/types";
import { renderFindingsReport } from "../../shared/racing/findings/render";

export type UnitSystem = "metric" | "imperial";
export type TemperatureUnit = "C" | "F";

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
  packets: TelemetryPacket[],
  unit: UnitSystem = "metric",
  temperatureUnit?: TemperatureUnit,
  findings?: readonly FindingRecord[],
): string {
  const decision = resolveEligibilityDecision(lap, "corner-trace");
  if (!isEligibilityUsable(decision)) throw new Error(eligibilityDecisionText(decision));
  const first = packets[0];
  const adapter = first.gameId ? tryGetGame(first.gameId) : undefined;
  const className = adapter?.carClassNames?.[first.CarClass] ?? String(first.CarClass);
  const drivetrainName = adapter?.drivetrainNames?.[first.DrivetrainType] ?? String(first.DrivetrainType);

  const speedUnit = unitToSpeed(unit);
  const tempUnit = temperatureUnit ?? unitToTemp(unit);
  const srcTemp = adapter?.telemetry.tireTemperature.packetUnit === "fahrenheit" ? ("F" as const) : ("C" as const);
  const speedFactor = speedUnit === "kmh" ? 3.6 : 2.237;
  const speedLabel = speedUnit === "kmh" ? "km/h" : "mph";
  const tempLabel = tempUnit === "C" ? "C" : "F";

  // Collect all packet aggregates in one pass; speeds remain available for
  // braking-zone detection.
  const speeds = new Array<number>(packets.length);
  let minSpeed = Infinity;
  let maxSpeed = -Infinity;
  let speedSum = 0;
  let minRpm = Infinity;
  let maxRpm = -Infinity;
  let rpmSum = 0;
  let throttleSum = 0;
  let fullThrottleCount = 0;
  let brakeSum = 0;
  let fullBrakeCount = 0;
  let tireTempFLSum = 0;
  let tireTempFRSum = 0;
  let tireTempRLSum = 0;
  let tireTempRRSum = 0;
  let suspensionFLSum = 0;
  let suspensionFRSum = 0;
  let suspensionRLSum = 0;
  let suspensionRRSum = 0;
  const gearCounts = new Map<number, number>();

  for (let index = 0; index < packets.length; index++) {
    const packet = packets[index];
    const speed = Math.sqrt(packet.VelocityX ** 2 + packet.VelocityY ** 2 + packet.VelocityZ ** 2) * speedFactor;
    speeds[index] = speed;
    minSpeed = Math.min(minSpeed, speed);
    maxSpeed = Math.max(maxSpeed, speed);
    speedSum += speed;

    minRpm = Math.min(minRpm, packet.CurrentEngineRpm);
    maxRpm = Math.max(maxRpm, packet.CurrentEngineRpm);
    rpmSum += packet.CurrentEngineRpm;

    const throttle = packet.Accel / 255;
    throttleSum += throttle;
    if (throttle > 0.95) fullThrottleCount++;
    const brake = packet.Brake / 255;
    brakeSum += brake;
    if (brake > 0.95) fullBrakeCount++;

    tireTempFLSum += packet.TireTempFL;
    tireTempFRSum += packet.TireTempFR;
    tireTempRLSum += packet.TireTempRL;
    tireTempRRSum += packet.TireTempRR;
    suspensionFLSum += packet.SuspensionTravelMFL;
    suspensionFRSum += packet.SuspensionTravelMFR;
    suspensionRLSum += packet.SuspensionTravelMRL;
    suspensionRRSum += packet.SuspensionTravelMRR;
    gearCounts.set(packet.Gear, (gearCounts.get(packet.Gear) ?? 0) + 1);
  }

  const packetCount = packets.length;
  const avgSpeed = speedSum / packetCount;
  const avgRpm = rpmSum / packetCount;
  const avgThrottle = throttleSum / packetCount;
  const fullThrottle = fullThrottleCount / packetCount;
  const avgBrake = brakeSum / packetCount;
  const fullBrake = fullBrakeCount / packetCount;
  const avgTireTempFL = convertTemp(tireTempFLSum / packetCount, tempUnit, srcTemp);
  const avgTireTempFR = convertTemp(tireTempFRSum / packetCount, tempUnit, srcTemp);
  const avgTireTempRL = convertTemp(tireTempRLSum / packetCount, tempUnit, srcTemp);
  const avgTireTempRR = convertTemp(tireTempRRSum / packetCount, tempUnit, srcTemp);
  const avgSuspFL = suspensionFLSum / packetCount;
  const avgSuspFR = suspensionFRSum / packetCount;
  const avgSuspRL = suspensionRLSum / packetCount;
  const avgSuspRR = suspensionRRSum / packetCount;

  const gearDist = Array.from(gearCounts.entries())
    .filter(([gear]) => gear > 0) // Skip neutral/reverse
    .sort(([a], [b]) => a - b)
    .map(([gear, count]) => {
      const pct = ((count / packetCount) * 100).toFixed(0);
      const gearName = gear === 11 ? "R" : `${gear}`;
      return `${gearName}: ${pct}%`;
    })
    .join(" | ");

  const brakingZones = findBrakingZones(packets, speeds);

  // Tire wear (use last packet values)
  const last = packets[packets.length - 1];

  // Format lap time
  const mins = Math.floor(lap.lapTime / 60);
  const secs = lap.lapTime % 60;
  const lapTimeStr = `${mins}:${secs.toFixed(3).padStart(6, "0")}`;

  let output = `=== RaceIQ Lap Export ===
Car: #${first.CarOrdinal} | Class: ${className} (PI ${first.CarPerformanceIndex}) | Drivetrain: ${drivetrainName}
Track: #${lap.trackOrdinal ?? 0} | Lap: ${lap.lapNumber} | Time: ${lapTimeStr} | Valid: ${lap.isValid ? "Yes" : "No"} | Classification: ${lapClassificationLabel(lap)}

--- Performance Summary ---
Speed (${speedLabel}):    min=${minSpeed.toFixed(1)}  avg=${avgSpeed.toFixed(1)}  max=${maxSpeed.toFixed(1)}
RPM:            min=${Math.round(minRpm)}  avg=${Math.round(avgRpm)}  max=${Math.round(maxRpm)}
Throttle:       avg=${(avgThrottle * 100).toFixed(0)}%   full=${(fullThrottle * 100).toFixed(0)}%
Brake:          avg=${(avgBrake * 100).toFixed(0)}%   full=${(fullBrake * 100).toFixed(0)}%

--- Tire Temps (avg ${tempLabel}) ---
FL: ${Math.round(avgTireTempFL)}  FR: ${Math.round(avgTireTempFR)}  RL: ${Math.round(avgTireTempRL)}  RR: ${Math.round(avgTireTempRR)}

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
FL: ${avgSuspFL.toFixed(4)}m  FR: ${avgSuspFR.toFixed(4)}m  RL: ${avgSuspRL.toFixed(4)}m  RR: ${avgSuspRR.toFixed(4)}m

--- Tire Wear ---
FL: ${last.TireWearFL.toFixed(2)}  FR: ${last.TireWearFR.toFixed(2)}  RL: ${last.TireWearRL.toFixed(2)}  RR: ${last.TireWearRR.toFixed(2)}
${findings ? `
--- Deterministic Findings ---
${renderFindingsReport(findings)}
` : ""}
Paste this into a Claude conversation for tuning advice.`;

  return output;
}

interface BrakingZone {
  startSpeed: number;
  endSpeed: number;
  distance: number; // DistanceTraveled at brake point
}

function findBrakingZones(packets: TelemetryPacket[], speeds: number[]): BrakingZone[] {
  const zones: BrakingZone[] = [];
  let inBraking = false;
  let brakeStartIdx = 0;
  let peakSpeed = 0;
  let minSpeedInZone = Infinity;

  for (let i = 1; i < packets.length; i++) {
    const braking = packets[i].Brake > 50; // ~20% brake threshold

    if (braking) {
      if (!inBraking) {
        inBraking = true;
        brakeStartIdx = i;
        peakSpeed = speeds[i - 1];
        minSpeedInZone = speeds[i];
      } else {
        minSpeedInZone = Math.min(minSpeedInZone, speeds[i]);
      }
    } else if (inBraking) {
      inBraking = false;
      const delta = peakSpeed - minSpeedInZone;
      if (delta > 10) {
        zones.push({
          startSpeed: peakSpeed,
          endSpeed: minSpeedInZone,
          distance: packets[brakeStartIdx].DistanceTraveled,
        });
      }
    }
  }

  // Sort by speed delta descending
  zones.sort((a, b) => b.startSpeed - b.endSpeed - (a.startSpeed - a.endSpeed));
  return zones.slice(0, 5);
}
