import type { GearingSample } from "./gearing-telemetry";
import { isSampleValid } from "./gearing-validation";

export interface GearRange {
  gear: number;
  minRpm: number | null;
  maxRpm: number | null;
  minSpeedMps: number | null;
  maxSpeedMps: number | null;
}

/**
 * Scan an array of canonical samples and compute observed min/max RPM and
 * speed (m/s) for each positive gear. Returns sorted array by gear number.
 *
 * Uses isSampleValid() for consistency with powerband chart accumulation.
 */
export function computeGearRanges(packets: GearingSample[]): GearRange[] {
  const stats = new Map<number, { minRpm: number; maxRpm: number; minSpeedMps: number; maxSpeedMps: number }>();

  for (const packet of packets) {
    if (!isSampleValid(packet)) continue;
    const gear = packet.Gear;
    if (gear <= 0) continue;

    const rpm = packet.rpm;
    const speed = packet.speedMps;

    const existing = stats.get(gear);
    if (existing) {
      existing.minRpm = Math.min(existing.minRpm, rpm);
      existing.maxRpm = Math.max(existing.maxRpm, rpm);
      existing.minSpeedMps = Math.min(existing.minSpeedMps, speed);
      existing.maxSpeedMps = Math.max(existing.maxSpeedMps, speed);
    } else {
      stats.set(gear, { minRpm: rpm, maxRpm: rpm, minSpeedMps: speed, maxSpeedMps: speed });
    }
  }

  return Array.from(stats.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([gear, s]) => ({
      gear,
      minRpm: s.minRpm,
      maxRpm: s.maxRpm,
      minSpeedMps: s.minSpeedMps,
      maxSpeedMps: s.maxSpeedMps,
    }));
}

/**
 * Track upshift-only min/max RPM and speed (m/s) from a stream of packets.
 * Returns the current gear ranges, updating only when an upshift is detected.
 *
 * - minRpm = RPM right after upshifting INTO this gear
 * - maxRpm = RPM right before upshifting OUT of this gear
 */
export function updateGearRangesOnUpshift(
  prev: GearingSample | null,
  current: GearingSample,
  existing: GearRange[]
): GearRange[] {
  if (!prev || !isSampleValid(current)) return existing;

  const currentGear = current.Gear;
  const prevGear = prev.Gear;

  if (currentGear <= 0 || prevGear <= 0) return existing;
  if (currentGear <= prevGear) return existing; // Not an upshift

  const prevRpm = prev.rpm;
  const prevSpeed = prev.speedMps;
  const currRpm = current.rpm;
  const currSpeed = current.speedMps;

  const next = existing.map((r) => ({ ...r }));

  // Update previous gear's max (RPM/speed when leaving it)
  const prevIdx = next.findIndex((r) => r.gear === prevGear);
  if (prevIdx !== -1) {
    next[prevIdx] = {
      ...next[prevIdx],
      maxRpm: prevRpm,
      maxSpeedMps: prevSpeed,
    };
  } else {
    next.push({
      gear: prevGear,
      minRpm: null,
      maxRpm: prevRpm,
      minSpeedMps: null,
      maxSpeedMps: prevSpeed,
    });
  }

  // Update current gear's min (RPM/speed when entering it)
  const currIdx = next.findIndex((r) => r.gear === currentGear);
  if (currIdx !== -1) {
    next[currIdx] = {
      ...next[currIdx],
      minRpm: currRpm,
      minSpeedMps: currSpeed,
    };
  } else {
    next.push({
      gear: currentGear,
      minRpm: currRpm,
      maxRpm: null,
      minSpeedMps: currSpeed,
      maxSpeedMps: null,
    });
  }

  return next.sort((a, b) => a.gear - b.gear);
}
