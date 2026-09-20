import type { GameId } from "../../shared/games/ids";
import { analyzeLap } from "../../shared/racing/analysis/laps/insights/analyze";
import { RACING_LINE_SEMANTIC_ID, type LapInsight, type RacingLineReference } from "../../shared/racing/analysis/laps/insights/types";
import { getTrackRacelineByOrdinal } from "../../shared/racing/tracks/recording/outlines";
import type { TelemetryPacket } from "../../shared/telemetry/types";

/**
 * Persisted static-insight contract. Bump whenever detector output changes.
 * Rows written by older versions are recomputed lazily or by the backfill route.
 */
export const STATIC_LAP_ANALYSIS_VERSION = 2;
export function resolveRacingLineReference(gameId: GameId, trackOrdinal: number | null | undefined): RacingLineReference {
  if (trackOrdinal == null) {
    return {
      semanticId: RACING_LINE_SEMANTIC_ID,
      source: "unavailable",
      reason: "missing-track-identity",
    };
  }

  const points = getTrackRacelineByOrdinal(trackOrdinal, gameId);
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

/** Run deterministic lap insights with bundled track context when available. */
export function analyzeLapWithTrack(telemetry: TelemetryPacket[], gameId: GameId, trackOrdinal: number | null | undefined = telemetry[0]?.TrackOrdinal): LapInsight[] {
  return analyzeLap(telemetry, gameId, {
    racingLine: resolveRacingLineReference(gameId, trackOrdinal),
  });
}
