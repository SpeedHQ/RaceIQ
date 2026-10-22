import type { GameId } from "@raceiq/shared/games/ids";
import { RACING_LINE_SEMANTIC_ID, type LapAnalysisContext, type RacingLineReference } from "@raceiq/analysis-core/racing/analysis/laps/insights/types";
import { getBundledTrackName, loadBundledPointCsvByName } from "@raceiq/game-catalogs/racing/tracks/resolve-name";
import { loadLabelledSegments } from "@raceiq/shared/racing/tracks/storage/meta";
import type { NamedSegment } from "@raceiq/shared/racing/tracks/named-segments";
import { tryGetServerGame } from "../games/registry";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { TelemetryFrameView } from "@raceiq/shared/telemetry/resolver/contracts";
import { compileTelemetryResolver } from "@raceiq/telemetry-core/telemetry/resolver/compile";

/**
 * Persisted static-insight contract. Bump whenever detector output changes.
 * Rows written by older versions are recomputed lazily or by the backfill route.
 */
export const STATIC_LAP_ANALYSIS_VERSION = 10;
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


export function resolveLapAnalysisContext(gameId: GameId, trackId: string | null | undefined, packets: readonly TelemetryPacket[]): LapAnalysisContext {
  const context: LapAnalysisContext = { racingLine: resolveRacingLineReference(gameId, trackId) };
  const resolver = compileTelemetryResolver({ simulator: gameId, requested: [
    { semanticId: "electronics.tc-active" },
    { semanticId: "electronics.tc-intervention" },
  ] });
  const activeSlot = resolver.slot("electronics.tc-active");
  const interventionSlot = resolver.slot("electronics.tc-intervention");
  let activeValues: (boolean | undefined)[] | undefined;
  let interventionValues: (number | undefined)[] | undefined;
  let frame: TelemetryFrameView | undefined;
  for (let index = 0; index < packets.length; index++) {
    const packet = packets[index];
    frame = resolver.createFrameView(packet, { timestamp: { domain: "session", milliseconds: packet.TimestampMS }, updateSequence: BigInt(index) }, frame);
    const active = frame.readBoolean(activeSlot);
    const intervention = frame.readNumber(interventionSlot);
    if (active !== undefined) (activeValues ??= new Array(packets.length))[index] = active;
    if (intervention !== undefined) (interventionValues ??= new Array(packets.length))[index] = intervention;
  }
  context.tractionControlActive = activeValues;
  context.tractionControlIntervention = interventionValues;
  return context;
}
