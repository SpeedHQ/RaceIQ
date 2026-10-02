import type { GameId } from "../../shared/games/ids";
import type { NamedSegment } from "../../shared/racing/tracks/named-segments";
import { formatTurnNumbers, turnNumbers } from "../../shared/racing/tracks/segment-label";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { getCorners, saveCorners } from "../db/track-queries";
import { detectCorners, type Corner } from "../lap-analysis/corners";
import { resolveTrackSegments } from "../routes/tracks/support";

function lapDistance(packets: readonly TelemetryPacket[]): number {
  let first: number | undefined;
  let last: number | undefined;
  for (const packet of packets) {
    if (!Number.isFinite(packet.DistanceTraveled)) continue;
    first ??= packet.DistanceTraveled;
    last = packet.DistanceTraveled;
  }
  return first === undefined || last === undefined ? 0 : Math.max(0, last - first);
}

/** Convert lap-fraction track segments into the metre-based corner contract. */
export function lapCornersFromSegments(
  segments: readonly NamedSegment[],
  telemetry: readonly TelemetryPacket[],
): Corner[] {
  const distance = lapDistance(telemetry);
  if (distance <= 0) return [];

  const corners: Corner[] = [];
  for (const segment of segments) {
    if (segment.type !== "corner") continue;
    const startFrac = Math.max(0, Math.min(1, segment.startFrac));
    const endFrac = Math.max(0, Math.min(1, segment.endFrac));
    if (endFrac <= startFrac) continue;

    const numbers = turnNumbers(segment);
    const label = numbers.length > 0
      ? `T${formatTurnNumbers(numbers)}`
      : `T${corners.length + 1}`;
    corners.push({
      index: corners.length,
      label,
      distanceStart: startFrac * distance,
      distanceEnd: endFrac * distance,
    });
  }
  return corners;
}

/** Resolve game-aware corner and straight segments, including iRacing SVG labels. */
export async function resolveLapSegments(
  trackOrdinal: number | null | undefined,
  gameId: string | null | undefined,
): Promise<NamedSegment[]> {
  if (trackOrdinal == null || trackOrdinal <= 0 || !gameId) return [];
  try {
    return (await resolveTrackSegments(trackOrdinal, gameId)).segments;
  } catch {
    return [];
  }
}

/**
 * Resolve corners once for every stored-lap analysis path.
 * Official-label-aligned segments win, then stored corners, then telemetry detection.
 */
export async function resolveLapCorners(
  trackOrdinal: number | null | undefined,
  gameId: string | null | undefined,
  telemetry: TelemetryPacket[],
  options: { saveDetected?: boolean; segments?: readonly NamedSegment[] } = {},
): Promise<Corner[]> {
  const segments = options.segments ?? await resolveLapSegments(trackOrdinal, gameId);
  const segmentCorners = lapCornersFromSegments(segments, telemetry);
  if (segmentCorners.length > 0) return segmentCorners;

  if (trackOrdinal != null && trackOrdinal > 0 && gameId) {
    try {
      const stored = await getCorners(trackOrdinal, gameId as GameId);
      if (stored.length > 0) return stored;
    } catch {
      // Stored corners are optional; telemetry detection remains available.
    }
  }

  const detected = detectCorners(telemetry);
  if (options.saveDetected && detected.length > 0 && trackOrdinal != null && trackOrdinal > 0 && gameId) {
    try {
      await saveCorners(trackOrdinal, detected, gameId as GameId, true);
    } catch {
      // A concurrent insert is harmless; return the in-memory detection.
    }
  }
  return detected;
}
