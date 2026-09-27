import type { TrackCorner } from "../../../hooks/track-queries";
import { sampleAt } from "../../../lib/stint-traces";
import type { LapTrace } from "../../../lib/stint-traces";
export const BRAKE_ACTIVE_THRESHOLD = 0.05;
export const THROTTLE_PICKUP_THRESHOLD = 0.3;
export const FULL_THROTTLE_THRESHOLD = 0.95;
export interface CornerInputMetric {
  corner: TrackCorner;
  frac: number;
  brakeOnsetFrac: number | null;
  brakeReleaseFrac: number | null;
  peakBrakeInput: number | null;
  brakingDistanceM: number | null;
  trailBrakingDistanceM: number | null;
  brakeOnsetSpreadM: number | null;
  throttlePickupFrac: number | null;
  fullThrottleFrac: number | null;
  pickupToFullThrottleS: number | null;
  throttlePickupSpreadM: number | null;
  exitSpeedKmh: number | null;
  brakeOnsets: number[];
  throttlePickups: number[];
}
function std(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}
function firstIndex(trace: LapTrace, start: number, end: number, predicate: (index: number) => boolean): number | null {
  for (let i = 0; i < trace.n; i++) if (trace.frac[i] >= start && trace.frac[i] <= end && predicate(i)) return i;
  return null;
}
export function buildCornerInputMetrics(traces: LapTrace[], bestLapId: number | null, corners: TrackCorner[], cornerFracs: number[], nominalSpanMeters: number): CornerInputMetric[] {
  if (traces.length === 0 || corners.length === 0) return [];
  const best = traces.find((trace) => trace.lapId === bestLapId) ?? traces[0];
  return corners.map((corner, index) => {
    const apex = Math.max(corner.distanceStart, Math.min(corner.distanceEnd, corner.apexDistance ?? cornerFracs[index] ?? (corner.distanceStart + corner.distanceEnd) / 2));
    const brakeStart = Math.max(0, corner.distanceStart - (nominalSpanMeters > 0 ? 300 / nominalSpanMeters : 0));
    const brakeOnsets: number[] = [];
    const throttlePickups: number[] = [];
    const bestBrake = firstIndex(best, brakeStart, corner.distanceEnd, (i) => best.brake[i] > BRAKE_ACTIVE_THRESHOLD);
    let release: number | null = null;
    let peakBrakeInput: number | null = null;
    if (bestBrake != null) {
      let peak = bestBrake;
      for (let i = bestBrake; i < best.n && best.frac[i] <= corner.distanceEnd; i++) if (best.brake[i] > best.brake[peak]) peak = i;
      peakBrakeInput = best.brake[peak];
      const releaseIndex = firstIndex(best, best.frac[peak], corner.distanceEnd, (i) => best.brake[i] <= BRAKE_ACTIVE_THRESHOLD);
      release = releaseIndex == null ? best.frac[peak] : best.frac[releaseIndex];
    }
    for (const trace of traces) {
      const brake = firstIndex(trace, brakeStart, corner.distanceEnd, (i) => trace.brake[i] > BRAKE_ACTIVE_THRESHOLD);
      if (brake != null) brakeOnsets.push(trace.frac[brake]);
      const pickup = firstIndex(trace, apex, corner.distanceEnd, (i) => trace.throttle[i] > THROTTLE_PICKUP_THRESHOLD);
      if (pickup != null) throttlePickups.push(trace.frac[pickup]);
    }
    const pickup = firstIndex(best, apex, corner.distanceEnd, (i) => best.throttle[i] > THROTTLE_PICKUP_THRESHOLD);
    const full = pickup == null ? null : firstIndex(best, best.frac[pickup], corner.distanceEnd, (i) => best.throttle[i] >= FULL_THROTTLE_THRESHOLD);
    return {
      corner,
      frac: cornerFracs[index] ?? apex,
      brakeOnsetFrac: bestBrake == null ? null : best.frac[bestBrake],
      brakeReleaseFrac: release,
      peakBrakeInput,
      brakingDistanceM: bestBrake != null && release != null && nominalSpanMeters > 0 ? (release - best.frac[bestBrake]) * nominalSpanMeters : null,
      trailBrakingDistanceM: release != null && nominalSpanMeters > 0 ? Math.max(0, release - apex) * nominalSpanMeters : null,
      brakeOnsetSpreadM: nominalSpanMeters > 0 && brakeOnsets.length >= 2 ? (std(brakeOnsets) ?? 0) * nominalSpanMeters : null,
      throttlePickupFrac: pickup == null ? null : best.frac[pickup],
      fullThrottleFrac: full == null ? null : best.frac[full],
      pickupToFullThrottleS: pickup != null && full != null ? best.timeS[full] - best.timeS[pickup] : null,
      throttlePickupSpreadM: nominalSpanMeters > 0 && throttlePickups.length >= 2 ? (std(throttlePickups) ?? 0) * nominalSpanMeters : null,
      exitSpeedKmh: sampleAt(best, "speedKmh", corner.distanceEnd),
      brakeOnsets,
      throttlePickups,
    };
  });
}
