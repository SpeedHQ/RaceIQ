import type { GameId } from "@raceiq/shared/games/ids";
import { RACING_LINE_SEMANTIC_ID, type RacingLineReference } from "@raceiq/analysis-core/racing/analysis/laps/insights/types";
import { getBundledTrackName, loadBundledPointCsvByName } from "@raceiq/game-catalogs/racing/tracks/resolve-name";
import { loadLabelledSegments } from "@raceiq/shared/racing/tracks/storage/meta";
import type { NamedSegment } from "@raceiq/shared/racing/tracks/named-segments";
import { tryGetServerGame } from "../games/registry";

/**
 * Persisted static-insight contract. Bump whenever detector output changes.
 * Rows written by older versions are recomputed lazily or by the backfill route.
 */
export const STATIC_LAP_ANALYSIS_VERSION = 9;
export function resolveLapSegments(gameId: GameId, trackId: string | null | undefined): NamedSegment[] {
  if (!trackId) return [];
  const name = tryGetServerGame(gameId)?.getSharedTrackName?.(trackId) ?? trackId;
  return name && /^[a-z0-9_-]+$/i.test(name) ? loadLabelledSegments(name, gameId) : [];
}

export function resolveRacingLineReference(gameId: GameId, trackId: string | null | undefined): RacingLineReference {
  if (!trackId) {
    return {
      semanticId: RACING_LINE_SEMANTIC_ID,
      source: "unavailable",
      reason: "missing-track-identity",
    };
  }

  const name = tryGetServerGame(gameId)?.getSharedTrackName?.(trackId)
    ?? (Number.isInteger(Number(trackId)) ? getBundledTrackName(gameId, Number(trackId)) : undefined)
    ?? trackId;
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

