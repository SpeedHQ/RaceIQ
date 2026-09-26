import type { GameId } from "../../shared/games/ids";
import { RACING_LINE_SEMANTIC_ID, type RacingLineReference } from "../../shared/racing/analysis/laps/insights/types";
import { getBundledTrackName, loadBundledPointCsvByName } from "../../shared/racing/tracks/resolve-name";
import { loadLabelledSegments } from "../../shared/racing/tracks/storage/meta";
import type { NamedSegment } from "../../shared/racing/tracks/named-segments";
import { tryGetServerGame } from "../games/registry";

/**
 * Persisted static-insight contract. Bump whenever detector output changes.
 * Rows written by older versions are recomputed lazily or by the backfill route.
 */
export const STATIC_LAP_ANALYSIS_VERSION = 4;
export function resolveLapSegments(gameId: GameId, trackId: number | string | null | undefined): NamedSegment[] {
  if (trackId == null) return [];
  const name = typeof trackId === "number" || /^\d+$/.test(trackId)
    ? tryGetServerGame(gameId)?.getSharedTrackName?.(Number(trackId))
    : trackId;
  return name && /^[a-z0-9_-]+$/i.test(name) ? loadLabelledSegments(name, gameId) : [];
}

export function resolveRacingLineReference(gameId: GameId, trackId: number | string | null | undefined): RacingLineReference {
  if (trackId == null) {
    return {
      semanticId: RACING_LINE_SEMANTIC_ID,
      source: "unavailable",
      reason: "missing-track-identity",
    };
  }

  const name = typeof trackId === "number" || /^\d+$/.test(trackId)
    ? getBundledTrackName(gameId, Number(trackId))
    : trackId;
  const points = name ? loadBundledPointCsvByName(name, gameId, "raceline") : null;
  return points && points.length >= 20
    ? {
        semanticId: RACING_LINE_SEMANTIC_ID,
        source: "track-data",
        points,
      }
    : {
        semanticId: RACING_LINE_SEMANTIC_ID,
        source: "unavailable",
        reason: "missing-track-data",
      };
}

