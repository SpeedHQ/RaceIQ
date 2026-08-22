import { GameIdSchema } from "../../shared/games/ids";
import type { NamedSegment } from "../../shared/racing/tracks/named-segments";
import { formatTurnNumbers, turnNumbers } from "../../shared/racing/tracks/segment-label";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import type { Corner } from "../lap-analysis/corners";
import { getCorners } from "../db/track-queries";
import { resolveTrackSegments } from "../routes/tracks/support";

/** Convert lap-fraction track segments into the metre-based corner contract. */
function cornersFromSegments(segments: readonly NamedSegment[], distance: number): Corner[] {
  if (distance <= 0) return [];

  const corners: Corner[] = [];
  for (const segment of segments) {
    if (segment.type !== "corner") continue;
    const startFrac = Math.max(0, Math.min(1, segment.startFrac));
    const endFrac = Math.max(0, Math.min(1, segment.endFrac));
    if (endFrac <= startFrac) continue;

    const numbers = turnNumbers(segment);
    const label = numbers.length > 0 ? `T${formatTurnNumbers(numbers)}` : `T${corners.length + 1}`;
    corners.push({
      index: corners.length,
      label,
      distanceStart: startFrac * distance,
      distanceEnd: endFrac * distance,
    });
  }
  return corners;
}

/** Resolve semantic replay values into the same metre-based corner contract. */
export function lapCornersFromSemanticSamples(segments: readonly NamedSegment[], telemetry: readonly SemanticTelemetrySample[]): Corner[] {
  let first: number | undefined;
  let last: number | undefined;
  for (const sample of telemetry) {
    const value = sample.values["timing.distance-traveled"];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    first ??= value;
    last = value;
  }
  return cornersFromSegments(segments, first === undefined || last === undefined ? 0 : Math.max(0, last - first));
}

/** Resolve game-aware corner and straight segments, including iRacing SVG labels. */
export async function resolveLapSegments(trackOrdinal: number | null | undefined, gameId: string | null | undefined): Promise<NamedSegment[]> {
  if (trackOrdinal == null || trackOrdinal <= 0 || !gameId) return [];
  try {
    return (await resolveTrackSegments(trackOrdinal, gameId)).segments;
  } catch {
    return [];
  }
}

/**
 * Resolve comparison corners from semantic replay frames. Official geometry and
 * stored corners remain valid; unavailable semantic distance never falls back
 * to raw packet fields or telemetry-derived corner detection.
 */
export async function resolveSemanticLapCorners(
  trackOrdinal: number | null | undefined,
  gameId: string | null | undefined,
  telemetry: readonly SemanticTelemetrySample[],
  options: { segments?: readonly NamedSegment[] } = {},
): Promise<Corner[]> {
  const segments = options.segments ?? (await resolveLapSegments(trackOrdinal, gameId));
  const segmentCorners = lapCornersFromSemanticSamples(segments, telemetry);
  if (segmentCorners.length > 0) return segmentCorners;

  const resolvedGame = GameIdSchema.safeParse(gameId);
  if (trackOrdinal != null && trackOrdinal > 0 && resolvedGame.success) {
    try {
      return await getCorners(trackOrdinal, resolvedGame.data);
    } catch {
      return [];
    }
  }
  return [];
}
