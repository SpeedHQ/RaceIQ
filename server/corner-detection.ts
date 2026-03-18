import type { TelemetryPacket } from "../shared/types";

export interface Corner {
  index: number;
  label: string; // "T1", "T2", etc.
  distanceStart: number; // meters from lap start
  distanceEnd: number; // meters from lap start
}

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
 * Compute speed in mph from velocity components.
 */
function speedMph(p: TelemetryPacket): number {
  return (
    Math.sqrt(p.VelocityX ** 2 + p.VelocityY ** 2 + p.VelocityZ ** 2) * 2.237
  );
}

/**
 * Auto-detect corners from telemetry packets using the algorithm from the spec:
 *
 * 1. Smooth speed with rolling average (window=15 samples)
 * 2. Smooth steering similarly (Steer field, u8, 127=center)
 * 3. Corner entry: speed drops >15 mph from local max AND steering deviates >15 units from 127
 * 4. Corner exit: speed rising AND steering within 10 units of 127
 * 5. Merge corners <50m apart
 * 6. Discard corners <30m
 *
 * Labels corners T1, T2, etc. Straights are S1, S2, etc. (not returned, implicit between corners).
 */
export function detectCorners(packets: TelemetryPacket[]): Corner[] {
  if (packets.length < 30) return [];

  const distanceAtLapStart = packets[0].DistanceTraveled;

  // Extract raw data
  const rawSpeeds = packets.map(speedMph);
  const rawSteering = packets.map((p) => p.Steer);
  const distances = packets.map((p) => p.DistanceTraveled - distanceAtLapStart);

  // Step 1 & 2: Smooth speed and steering
  const WINDOW = 15;
  const smoothSpeed = rollingAverage(rawSpeeds, WINDOW);
  const smoothSteer = rollingAverage(rawSteering, WINDOW);

  // Step 3 & 4: Detect corner entry/exit
  const rawCorners: { distanceStart: number; distanceEnd: number }[] = [];
  let inCorner = false;
  let localMax = smoothSpeed[0];
  let cornerStartDist = 0;

  for (let i = 1; i < packets.length; i++) {
    const speed = smoothSpeed[i];
    const steerDev = Math.abs(smoothSteer[i] - 127);
    const dist = distances[i];

    if (!inCorner) {
      // Track local max speed while on straight
      if (speed > localMax) {
        localMax = speed;
      }

      // Corner entry: speed dropped >15 mph from local max AND steering deviates >15 from center
      const speedDrop = localMax - speed;
      if (speedDrop > 15 && steerDev > 15) {
        inCorner = true;
        cornerStartDist = dist;
      }
    } else {
      // Corner exit: speed is rising AND steering is within 10 of center
      const prevSpeed = smoothSpeed[i - 1];
      if (speed > prevSpeed && steerDev < 10) {
        inCorner = false;
        rawCorners.push({ distanceStart: cornerStartDist, distanceEnd: dist });
        localMax = speed; // Reset local max for next straight
      }
    }
  }

  // Close any open corner at end of lap
  if (inCorner) {
    rawCorners.push({
      distanceStart: cornerStartDist,
      distanceEnd: distances[distances.length - 1],
    });
  }

  // Step 5: Merge corners <50m apart
  const merged: { distanceStart: number; distanceEnd: number }[] = [];
  for (const c of rawCorners) {
    if (
      merged.length > 0 &&
      c.distanceStart - merged[merged.length - 1].distanceEnd < 50
    ) {
      // Merge with previous
      merged[merged.length - 1].distanceEnd = c.distanceEnd;
    } else {
      merged.push({ ...c });
    }
  }

  // Step 6: Discard corners <30m
  const filtered = merged.filter(
    (c) => c.distanceEnd - c.distanceStart >= 30
  );

  // Label sequentially
  const corners: Corner[] = filtered.map((c, i) => ({
    index: i + 1,
    label: `T${i + 1}`,
    distanceStart: Math.round(c.distanceStart * 10) / 10,
    distanceEnd: Math.round(c.distanceEnd * 10) / 10,
  }));

  return corners;
}
