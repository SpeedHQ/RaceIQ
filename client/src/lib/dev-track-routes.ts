import { GameIdSchema, type GameId } from "../../../shared/games/ids";

export interface DevTrackIdentity {
  gameId: GameId;
  trackOrdinal: number;
}

export function parseTrackOrdinal(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error("Invalid track ordinal");
  const trackOrdinal = Number(value);
  if (!Number.isSafeInteger(trackOrdinal) || trackOrdinal < 0) throw new Error("Invalid track ordinal");
  return trackOrdinal;
}

export function parseDevTrackIdentity(params: { gameId: string; trackOrdinal: string }): DevTrackIdentity {
  return {
    gameId: GameIdSchema.parse(params.gameId),
    trackOrdinal: parseTrackOrdinal(params.trackOrdinal),
  };
}

export function optionalDevTrackIdentity(params: { gameId?: string; trackOrdinal?: string }): DevTrackIdentity | null {
  if (!params.gameId || params.trackOrdinal === undefined) return null;
  try {
    return parseDevTrackIdentity({ gameId: params.gameId, trackOrdinal: params.trackOrdinal });
  } catch {
    return null;
  }
}
