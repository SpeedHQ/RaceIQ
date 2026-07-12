import type { TelemetryPacket } from "../shared/types";
import { tryGetGame } from "../shared/games/registry";

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
  lap: {
    lapNumber: number;
    lapTime: number;
    isValid: boolean;
    carOrdinal?: number;
    trackOrdinal?: number;
  },
  packets: TelemetryPacket[],
  unit: UnitSystem = "metric",
  temperatureUnit?: TemperatureUnit,
): string {
  const first = packets[0];
  const adapter = first.gameId ? tryGetGame(first.gameId) : undefined;
  const className = adapter?.carClassNames?.[first.CarClass] ?? String(first.CarClass);
  const drivetrainName = adapter?.drivetrainNames?.[first.DrivetrainType] ?? String(first.DrivetrainType);

  const speedUnit = unitToSpeed(unit);
  const tempUnit = temperatureUnit ?? unitToTemp(unit);
  const srcTemp = first.gameId === "fm-2023" ? ("F" as const) : ("C" as const);
  const speedFactor = speedUnit === "kmh" ? 3.6 : 2.237;
  const speedLabel = speedUnit === "kmh" ? "km/h" : "mph";
  const tempLabel = tempUnit === "C" ? "C" : "F";

  // Speed calculations
  const speeds = packets.map((p) => Math.sqrt(p.VelocityX ** 2 + p.VelocityY ** 2 + p.VelocityZ ** 2) * speedFactor);
  const minSpeed = Math.min(...speeds);
  const maxSpeed = Math.max(...speeds);
  const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;

  // RPM
  const rpms = packets.map((p) => p.CurrentEngineRpm);
  const minRpm = Math.min(...rpms);
  const maxRpm = Math.max(...rpms);
  const avgRpm = rpms.reduce((a, b) => a + b, 0) / rpms.length;

  // Throttle/Brake (0-255 -> percentage)
  const throttles = packets.map((p) => p.Accel / 255);
  const avgThrottle = throttles.reduce((a, b) => a + b, 0) / throttles.length;
  const fullThrottle = throttles.filter((t) => t > 0.95).length / throttles.length;

  const brakes = packets.map((p) => p.Brake / 255);
  const avgBrake = brakes.reduce((a, b) => a + b, 0) / brakes.length;
  const fullBrake = brakes.filter((b) => b > 0.95).length / brakes.length;

  // Tire temps — Forza sends Fahrenheit, F1/ACC send Celsius
  const avgTireTempFL = convertTemp(packets.reduce((a, p) => a + p.TireTempFL, 0) / packets.length, tempUnit, srcTemp);
  const avgTireTempFR = convertTemp(packets.reduce((a, p) => a + p.TireTempFR, 0) / packets.length, tempUnit, srcTemp);
  const avgTireTempRL = convertTemp(packets.reduce((a, p) => a + p.TireTempRL, 0) / packets.length, tempUnit, srcTemp);
  const avgTireTempRR = convertTemp(packets.reduce((a, p) => a + p.TireTempRR, 0) / packets.length, tempUnit, srcTemp);

  // Gear distribution
  const gearCounts = new Map<number, number>();
  for (const p of packets) {
    gearCounts.set(p.Gear, (gearCounts.get(p.Gear) ?? 0) + 1);
  }
  const gearDist = Array.from(gearCounts.entries())
    .filter(([gear]) => gear > 0) // Skip neutral/reverse
    .sort(([a], [b]) => a - b)
    .map(([gear, count]) => {
      const pct = ((count / packets.length) * 100).toFixed(0);
      const gearName = gear === 11 ? "R" : `${gear}`;
      return `${gearName}: ${pct}%`;
    })
    .join(" | ");

  // Top 5 braking zones by speed delta
  const brakingZones = findBrakingZones(packets, speeds);

  // Suspension travel
  const avgSuspFL = packets.reduce((a, p) => a + p.SuspensionTravelMFL, 0) / packets.length;
  const avgSuspFR = packets.reduce((a, p) => a + p.SuspensionTravelMFR, 0) / packets.length;
  const avgSuspRL = packets.reduce((a, p) => a + p.SuspensionTravelMRL, 0) / packets.length;
  const avgSuspRR = packets.reduce((a, p) => a + p.SuspensionTravelMRR, 0) / packets.length;

  // Tire wear (use last packet values)
  const last = packets[packets.length - 1];

  // Format lap time
  const mins = Math.floor(lap.lapTime / 60);
  const secs = lap.lapTime % 60;
  const lapTimeStr = `${mins}:${secs.toFixed(3).padStart(6, "0")}`;

  let output = `=== Forza Motorsport Lap Export ===
Car: #${first.CarOrdinal} | Class: ${className} (PI ${first.CarPerformanceIndex}) | Drivetrain: ${drivetrainName}
Track: #${lap.trackOrdinal ?? 0} | Lap: ${lap.lapNumber} | Time: ${lapTimeStr} | Valid: ${lap.isValid ? "Yes" : "No"}

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

Paste this into a Claude conversation for tuning advice.`;

  return output;
}

export interface BrakingZone {
  startSpeed: number;
  endSpeed: number;
  distance: number; // DistanceTraveled at brake point
}

export function findBrakingZones(packets: TelemetryPacket[], speeds: number[]): BrakingZone[] {
  const zones: BrakingZone[] = [];
  let inBraking = false;
  let brakeStartIdx = 0;
  let peakSpeed = 0;

  for (let i = 1; i < packets.length; i++) {
    const braking = packets[i].Brake > 50; // ~20% brake threshold

    if (braking && !inBraking) {
      // Start of braking zone
      inBraking = true;
      brakeStartIdx = i;
      peakSpeed = speeds[i - 1];
    } else if (!braking && inBraking) {
      // End of braking zone
      inBraking = false;
      const minSpeedInZone = Math.min(...speeds.slice(brakeStartIdx, i));
      const delta = peakSpeed - minSpeedInZone;
      if (delta > 10) {
        // Only record significant braking
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
