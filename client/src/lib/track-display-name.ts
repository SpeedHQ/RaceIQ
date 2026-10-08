import { resolveLMUTrack } from "@raceiq/game-lmu-metadata/catalog";
import type { GameId } from "@raceiq/shared/games/ids";
import { tryGetGame } from "@raceiq/shared/games/registry";

export interface TrackDisplayReference {
  trackId?: number | string | null;
  trackIdentity?: string | null;
  trackOrdinal?: number | null;
}

function identityValue(identity: string | null | undefined): number | string | null {
  if (!identity || identity === "track:unknown") return null;
  const numberPrefix = "track:number:";
  if (identity.startsWith(numberPrefix)) {
    const value = Number(identity.slice(numberPrefix.length));
    return Number.isFinite(value) ? value : null;
  }
  const stringPrefix = "track:string:";
  return identity.startsWith(stringPrefix) ? identity.slice(stringPrefix.length) : identity;
}

/** Resolve a user-facing track name without losing game or layout identity. */
export function resolveTrackDisplayName(
  gameId: GameId | null,
  reference: TrackDisplayReference,
  trackNames: Readonly<Record<string, string>> = {},
): string | undefined {
  if (!gameId) return undefined;

  const trackId = reference.trackIdentity !== undefined
    ? identityValue(reference.trackIdentity)
    : reference.trackId;
  if (gameId === "lmu" && typeof trackId === "string") {
    const catalogName = resolveLMUTrack(trackId)?.name;
    if (catalogName) return catalogName;
    // Some recorded LMU identities are already human-readable display names,
    // but catalog aliases can be ambiguous across layouts (e.g. Spa).
    if (/\s/.test(trackId.trim())) return trackId.trim();
  }

  const ordinal = reference.trackOrdinal != null && reference.trackOrdinal !== -1
    ? reference.trackOrdinal
    : typeof trackId === "number" && trackId !== -1
      ? trackId
      : null;
  if (ordinal == null) return undefined;

  const suppliedName = trackNames[`${gameId}:${ordinal}`]?.trim();
  if (suppliedName) return suppliedName;
  return tryGetGame(gameId)?.getTrackName(ordinal);
}
