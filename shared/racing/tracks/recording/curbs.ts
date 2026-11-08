import type { Point } from "../geometry/types";

// Pure telemetry detection; curb segments are not persisted as track geometry.

export interface CurbSegment {
  points: Point[];
  side: "left" | "right" | "both";
}

/**
 * Extract curb segments from a lap's telemetry packets.
 * Groups consecutive rumble-strip positions into polyline segments,
 * with a gap tolerance of 5 packets (~83ms at 60Hz) to bridge brief bounces.
 */
export function extractCurbSegments(packets: { PositionX: number; PositionZ: number; WheelOnRumbleStripFL: number; WheelOnRumbleStripFR: number; WheelOnRumbleStripRL: number; WheelOnRumbleStripRR: number }[]): CurbSegment[] {
  const segments: CurbSegment[] = [];
  let currentPoints: Point[] = [];
  let currentSide: "left" | "right" | "both" = "both";
  let gapCount = 0;
  const GAP_TOLERANCE = 5; // bridge gaps up to 5 packets
  const MIN_SEGMENT_POINTS = 3; // need at least 3 positions to be a real curb

  for (const p of packets) {
    if (p.PositionX === 0 && p.PositionZ === 0) continue;

    const fl = p.WheelOnRumbleStripFL > 0;
    const fr = p.WheelOnRumbleStripFR > 0;
    const rl = p.WheelOnRumbleStripRL > 0;
    const rr = p.WheelOnRumbleStripRR > 0;
    const anyRumble = fl || fr || rl || rr;

    if (anyRumble) {
      // Wheel position does not identify which side of the track contains the curb.
      if (currentPoints.length === 0) {
        currentSide = "both";
      }
      currentPoints.push({ x: p.PositionX, z: p.PositionZ });
      gapCount = 0;
    } else if (currentPoints.length > 0) {
      gapCount++;
      if (gapCount > GAP_TOLERANCE) {
        // End of segment
        if (currentPoints.length >= MIN_SEGMENT_POINTS) {
          segments.push({ points: [...currentPoints], side: currentSide });
        }
        currentPoints = [];
        gapCount = 0;
      }
    }
  }

  // Close final segment
  if (currentPoints.length >= MIN_SEGMENT_POINTS) {
    segments.push({ points: currentPoints, side: currentSide });
  }

  return segments;
}
