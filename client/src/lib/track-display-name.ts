import { resolveLMUTrack } from "@raceiq/game-lmu-metadata/catalog";
import type { GameId } from "@raceiq/shared/games/ids";

export interface TrackDisplayReference {
  trackId?: string | null;
  trackIdentity?: string | null;
}


/** Resolve a user-facing track name without losing game or layout identity. */
export function resolveTrackDisplayName(
  gameId: GameId | null,
  reference: TrackDisplayReference,
  trackNames: Readonly<Record<string, string>> = {},
): string | undefined {
  if (!gameId) return undefined;

  const trackId = reference.trackIdentity !== undefined ? reference.trackIdentity : reference.trackId;
  if (!trackId || trackId === "-1") return undefined;
  const suppliedIdentityName = trackId != null ? trackNames[`${gameId}:${trackId}`]?.trim() : undefined;
  if (suppliedIdentityName) return suppliedIdentityName;
  if (gameId === "lmu" && typeof trackId === "string") {
    const catalogName = resolveLMUTrack(trackId)?.name;
    if (catalogName) return catalogName;
    // Some recorded LMU identities are already human-readable display names,
    // but catalog aliases can be ambiguous across layouts (e.g. Spa).
    if (/\s/.test(trackId.trim())) return trackId.trim();
  }

  return undefined;
}
