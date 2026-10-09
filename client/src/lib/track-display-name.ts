import { resolveLMUTrack } from "@raceiq/game-lmu-metadata/catalog";
import type { GameId } from "@raceiq/shared/games/ids";
import { tryGetGame } from "@raceiq/shared/games/registry";

export interface TrackDisplayReference {
  trackId?: number | string | null;
  trackIdentity?: string | null;
  trackOrdinal?: number | null;
}

function identityValue(gameId: GameId, identity: string | null | undefined): number | string | null {
  if (!identity) return null;
  let key = identity;
  if (key.startsWith("[")) {
    try {
      const decoded: unknown = JSON.parse(key);
      if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== gameId || typeof decoded[1] !== "string") return null;
      key = decoded[1];
    } catch {
      return null;
    }
  }
  if (key.startsWith("n:")) {
    const value = Number(key.slice(2));
    return key.length > 2 && Number.isInteger(value) && value !== -1 ? value : null;
  }
  return key.startsWith("s:") ? key.slice(2) : null;
}

/** Resolve a user-facing track name without losing game or layout identity. */
export function resolveTrackDisplayName(
  gameId: GameId | null,
  reference: TrackDisplayReference,
  trackNames: Readonly<Record<string, string>> = {},
): string | undefined {
  if (!gameId) return undefined;

  const trackId = reference.trackIdentity !== undefined
    ? identityValue(gameId, reference.trackIdentity)
    : reference.trackId;
  const suppliedIdentityName = trackId != null ? trackNames[`${gameId}:${trackId}`]?.trim() : undefined;
  if (suppliedIdentityName) return suppliedIdentityName;
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
