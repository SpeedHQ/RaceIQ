import type { TelemetryPacket } from "@shared/telemetry/types";

export const LAP_PATH_SEMANTIC_IDS = [
  "motion.position-x",
  "motion.position-z",
  "motion.speed",
  "motion.velocity-x",
  "motion.velocity-z",
  "motion.yaw",
  "timing.lap-fraction",
] as const;

export type LapPathSemanticId = (typeof LAP_PATH_SEMANTIC_IDS)[number];

/**
 * Semantic value source compiled once by a consumer. Implementations may
 * retain and reuse a resolver frame view between calls.
 */
export interface LapPathSemanticReader<
  SemanticId extends string = LapPathSemanticId,
> {
  readNumber(
    packet: TelemetryPacket,
    semanticId: SemanticId,
  ): number | undefined;
}

function readFinite(
  reader: LapPathSemanticReader | undefined,
  packet: TelemetryPacket,
  semanticId: LapPathSemanticId,
  fallback: number,
): number {
  const value = reader?.readNumber(packet, semanticId);
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

export interface LapPathPoint {
  x: number;
  z: number;
}

/** Advance one iRacing position estimate from speed and heading. */
export function deadReckonIRacingPosition(
  previousPacket: Pick<TelemetryPacket, "TimestampMS" | "Yaw">,
  packet: Pick<TelemetryPacket, "TimestampMS" | "Yaw" | "Speed">,
  previousPosition: LapPathPoint,
): LapPathPoint {
  const dt =
    (packet.TimestampMS - previousPacket.TimestampMS) / 1000;
  if (dt <= 0 || dt > 1) return previousPosition;
  // Circular mean avoids a false 180-degree turn when yaw crosses -pi/pi.
  const yaw = Math.atan2(
    Math.sin(previousPacket.Yaw) + Math.sin(packet.Yaw),
    Math.cos(previousPacket.Yaw) + Math.cos(packet.Yaw),
  );
  return {
    x: previousPosition.x + Math.sin(yaw) * packet.Speed * dt,
    z: previousPosition.z + Math.cos(yaw) * packet.Speed * dt,
  };
}

/**
 * Check if telemetry has valid world positions (not all zeros).
 * Samples a spread of ~20 packets rather than every frame.
 */
export function hasWorldPositions(
  telemetry: TelemetryPacket[],
  reader?: LapPathSemanticReader,
): boolean {
  for (let i = 0; i < Math.min(telemetry.length, 20); i++) {
    const idx = Math.floor((i * telemetry.length) / 20);
    const packet = telemetry[idx];
    const positionX = readFinite(reader, packet, "motion.position-x", packet.PositionX);
    const positionZ = readFinite(reader, packet, "motion.position-z", packet.PositionZ);
    if (positionX !== 0 || positionZ !== 0) return true;
  }
  return false;
}

/**
 * Integrate positions when world positions aren't available.
 *
 * Most packet sources expose world-space velocity, so those components can be
 * accumulated directly. iRacing's VelocityX is longitudinal vehicle speed,
 * however, and its public SDK row does not expose world position. Rotate the
 * canonical Speed value by Yaw for iRacing so the reconstructed path follows
 * the circuit instead of collapsing into a straight line.
 */
export function integratePositions(
  packets: TelemetryPacket[],
  reader?: LapPathSemanticReader,
): { x: number[]; z: number[] } {
  const x: number[] = [0];
  const z: number[] = [0];
  const isIRacing = packets[0]?.gameId === "iracing";
  for (let i = 1; i < packets.length; i++) {
    const dt = (packets[i].TimestampMS - packets[i - 1].TimestampMS) / 1000;
    if (dt <= 0 || dt > 1) {
      x.push(x[x.length - 1]);
      z.push(z[z.length - 1]);
      continue;
    }
    if (isIRacing) {
      const previousYaw = readFinite(
        reader,
        packets[i - 1],
        "motion.yaw",
        packets[i - 1].Yaw,
      );
      const yaw = readFinite(reader, packets[i], "motion.yaw", packets[i].Yaw);
      const speed = readFinite(reader, packets[i], "motion.speed", packets[i].Speed);
      const next = deadReckonIRacingPosition(
        { TimestampMS: packets[i - 1].TimestampMS, Yaw: previousYaw },
        { TimestampMS: packets[i].TimestampMS, Yaw: yaw, Speed: speed },
        { x: x[x.length - 1], z: z[z.length - 1] },
      );
      x.push(next.x);
      z.push(next.z);
    } else {
      const velocityX = readFinite(
        reader,
        packets[i],
        "motion.velocity-x",
        packets[i].VelocityX,
      );
      const velocityZ = readFinite(
        reader,
        packets[i],
        "motion.velocity-z",
        packets[i].VelocityZ,
      );
      x.push(x[x.length - 1] + velocityX * dt);
      z.push(z[z.length - 1] + velocityZ * dt);
    }
  }
  return { x, z };
}

function pathFromLapFraction(
  packets: TelemetryPacket[],
  outline: readonly LapPathPoint[],
  reader?: LapPathSemanticReader,
): { x: number[]; z: number[] } | null {
  if (
    outline.length < 2 ||
    !packets.every((packet) =>
      Number.isFinite(
        readFinite(
          reader,
          packet,
          "timing.lap-fraction",
          packet.iracing?.lapDistancePct ?? Number.NaN,
        ),
      ),
    )
  ) {
    return null;
  }

  const cumulative = [0];
  for (let i = 1; i < outline.length; i++) {
    cumulative.push(
      cumulative[i - 1] +
        Math.hypot(
          outline[i].x - outline[i - 1].x,
          outline[i].z - outline[i - 1].z,
        ),
    );
  }
  const total = cumulative[cumulative.length - 1];
  if (total <= 0) return null;

  const x: number[] = [];
  const z: number[] = [];
  for (const packet of packets) {
    const fraction = Math.min(
      1,
      Math.max(
        0,
        readFinite(
          reader,
          packet,
          "timing.lap-fraction",
          packet.iracing?.lapDistancePct ?? Number.NaN,
        ),
      ),
    );
    const target = fraction * total;
    let lo = 1;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const endIndex = lo;
    const startIndex = Math.max(0, endIndex - 1);
    const segmentLength = cumulative[endIndex] - cumulative[startIndex];
    const amount =
      segmentLength > 0
        ? (target - cumulative[startIndex]) / segmentLength
        : 0;
    x.push(
      outline[startIndex].x +
        (outline[endIndex].x - outline[startIndex].x) * amount,
    );
    z.push(
      outline[startIndex].z +
        (outline[endIndex].z - outline[startIndex].z) * amount,
    );
  }
  return { x, z };
}

/** Project one normalized lap fraction onto an outline by cumulative distance. */
export function pointAtLapFraction(
  outline: readonly LapPathPoint[],
  fractionValue: number,
): LapPathPoint | null {
  if (outline.length < 2 || !Number.isFinite(fractionValue)) return null;
  const cumulative = [0];
  for (let index = 1; index < outline.length; index++) {
    cumulative.push(
      cumulative[index - 1] +
        Math.hypot(
          outline[index].x - outline[index - 1].x,
          outline[index].z - outline[index - 1].z,
        ),
    );
  }
  const total = cumulative.at(-1)!;
  if (!(total > 0)) return null;
  const target = Math.max(0, Math.min(1, fractionValue)) * total;
  let low = 1;
  let high = cumulative.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (cumulative[middle] < target) low = middle + 1;
    else high = middle;
  }
  const endIndex = low;
  const startIndex = Math.max(0, endIndex - 1);
  const segmentLength =
    cumulative[endIndex] - cumulative[startIndex];
  const amount =
    segmentLength > 0
      ? (target - cumulative[startIndex]) / segmentLength
      : 0;
  return {
    x:
      outline[startIndex].x +
      (outline[endIndex].x - outline[startIndex].x) * amount,
    z:
      outline[startIndex].z +
      (outline[endIndex].z - outline[startIndex].z) * amount,
  };
}

/**
 * Resolve a lap's {x,z} path: use world positions when present, project an
 * iRacing lap fraction onto a compatible outline when one is available, or
 * reconstruct a relative path from velocity/heading as the final fallback.
 */
export function lapPath(
  packets: TelemetryPacket[],
  outline?: readonly LapPathPoint[] | null,
  reader?: LapPathSemanticReader,
): { x: number[]; z: number[] } {
  if (hasWorldPositions(packets, reader)) {
    return {
      x: packets.map((packet) =>
        readFinite(reader, packet, "motion.position-x", packet.PositionX),
      ),
      z: packets.map((packet) =>
        readFinite(reader, packet, "motion.position-z", packet.PositionZ),
      ),
    };
  }
  if (outline) {
    const projected = pathFromLapFraction(packets, outline, reader);
    if (projected) return projected;
  }
  return integratePositions(packets, reader);
}
