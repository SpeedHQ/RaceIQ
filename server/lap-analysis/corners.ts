import { semanticLapFrames } from "../../shared/racing/analysis/laps/semantic-frame";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import { speedMphFromPacket, steerScaleFor } from "./metrics";

export interface Corner {
  index: number;
  label: string; // "T1", "T2", etc.
  distanceStart: number; // meters from lap start
  distanceEnd: number; // meters from lap start
  /** Minimum smoothed speed within the corner span, in km/h. Drives the
   *  slow/medium/fast band in tune-symptoms. Optional so older callers and
   *  hand-built Corner literals (tests) stay valid. */
  minSpeedKph?: number;
  /** Distance (m from lap start) of the minimum-speed point — the apex. */
  apexDistance?: number;
}

// m/s → km/h; speedMph gives mph, so mph → km/h is × 1.60934.
const MPH_TO_KPH = 1.60934;

/**
 * Smooth an array of numbers with a rolling average.
 */
function rollingAverage(data: number[], window: number): number[] {
  const half = Math.floor(window / 2);
  const result: number[] = new Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const start = Math.max(0, i - half);
    const end = Math.min(data.length - 1, i + half);
    let sum = 0;
    for (let j = start; j <= end; j++) {
      sum += data[j];
    }
    result[i] = sum / (end - start + 1);
  }
  return result;
}

/**
 * Auto-detect corners from telemetry packets using the algorithm from the spec:
 *
 * 1. Smooth speed with rolling average (window=15 samples)
 * 2. Smooth steering similarly (Steer field, game-dependent center value)
 * 3. Corner entry: speed drops >15 mph from local max AND steering deviates significantly from center
 * 4. Corner exit: speed rising AND steering near center
 * 5. Merge corners <50m apart
 * 6. Discard corners <30m
 *
 * Labels corners T1, T2, etc. Straights are S1, S2, etc. (not returned, implicit between corners).
 */
export function detectCorners(samples: readonly SemanticTelemetrySample[], gameId: string): Corner[] {
  const packets = semanticLapFrames(samples);
  if (packets.length < 30) return [];

  // Resolve steering scale from the same adapter-backed helper as input metrics.
  const { center: steerCenter, range: steerRange } = steerScaleFor(gameId);

  // Scale thresholds relative to steering range (15/127 and 10/127 of full range)
  const entryThreshold = (15 / 127) * steerRange;
  const exitThreshold = (10 / 127) * steerRange;

  const rawSpeeds: number[] = [];
  const rawSteering: number[] = [];
  const distances: number[] = [];
  let firstDistance: number | undefined;
  for (const packet of packets) {
    const speed = speedMphFromPacket(packet);
    const distance = packet.distanceM;
    const steering = packet.steeringInput;
    if (speed === undefined || !Number.isFinite(speed) || typeof steering !== "number" || !Number.isFinite(steering) || typeof distance !== "number" || !Number.isFinite(distance)) {
      continue;
    }
    firstDistance ??= distance;
    rawSpeeds.push(speed);
    rawSteering.push(steering);
    distances.push(distance - firstDistance);
  }
  if (rawSpeeds.length < 30) return [];
  const smoothSpeed = rollingAverage(rawSpeeds, 15);
  const smoothSteer = rollingAverage(rawSteering, 15);

  // Step 3 & 4: Detect corner entry/exit
  const rawCorners: { distanceStart: number; distanceEnd: number }[] = [];
  let inCorner = false;
  let localMax = smoothSpeed[0];
  let cornerStartDist: number | undefined;

  for (let i = 1; i < rawSpeeds.length; i++) {
    const speed = smoothSpeed[i];
    const steerDev = Math.abs(smoothSteer[i] - steerCenter);
    const distance = distances[i];

    if (!inCorner) {
      // Track local max speed while on straight
      if (speed > localMax) {
        localMax = speed;
      }

      // Corner entry: speed dropped >15 mph from local max AND steering deviates past entry threshold
      const speedDrop = localMax - speed;
      if (speedDrop > 15 && steerDev > entryThreshold) {
        inCorner = true;
        cornerStartDist = distance;
      }
    } else {
      // Corner exit: speed is rising AND steering is within exit threshold of center
      const prevSpeed = smoothSpeed[i - 1];
      if (speed > prevSpeed && steerDev < exitThreshold && cornerStartDist !== undefined) {
        inCorner = false;
        rawCorners.push({ distanceStart: cornerStartDist, distanceEnd: distance });
        cornerStartDist = undefined;
        localMax = speed; // Reset local max for next straight
      }
    }
  }

  // Close any open corner at end of lap
  if (inCorner && cornerStartDist !== undefined) {
    rawCorners.push({
      distanceStart: cornerStartDist,
      distanceEnd: distances[distances.length - 1],
    });
  }

  // Step 5: Merge corners <50m apart
  const merged: { distanceStart: number; distanceEnd: number }[] = [];
  for (const c of rawCorners) {
    if (merged.length > 0 && c.distanceStart - merged[merged.length - 1].distanceEnd < 50) {
      // Merge with previous
      merged[merged.length - 1].distanceEnd = c.distanceEnd;
    } else {
      merged.push({ ...c });
    }
  }

  // Step 6: Discard corners <30m
  const filtered = merged.filter((c) => c.distanceEnd - c.distanceStart >= 30);

  // Label sequentially. Record the slowest smoothed speed (the apex) within
  // each corner span for speed-band classification downstream. distances[] and
  // smoothSpeed[] are aligned by packet index, so scan the indices whose
  // relative distance falls inside the span.
  const corners: Corner[] = filtered.map((c, i) => {
    let minMph = Infinity;
    let apexDist = c.distanceStart;
    for (let j = 0; j < distances.length; j++) {
      if (distances[j] < c.distanceStart || distances[j] > c.distanceEnd) continue;
      if (smoothSpeed[j] < minMph) {
        minMph = smoothSpeed[j];
        apexDist = distances[j];
      }
    }
    return {
      index: i + 1,
      label: `T${i + 1}`,
      distanceStart: Math.round(c.distanceStart * 10) / 10,
      distanceEnd: Math.round(c.distanceEnd * 10) / 10,
      minSpeedKph: Number.isFinite(minMph) ? Math.round(minMph * MPH_TO_KPH * 10) / 10 : undefined,
      apexDistance: Math.round(apexDist * 10) / 10,
    };
  });

  return corners;
}
