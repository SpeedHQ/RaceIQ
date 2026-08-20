import { GameIdSchema } from "../../shared/games/ids";
import { tryGetGame } from "../../shared/games/registry";
import { getIRacingTrack } from "../../shared/racing/tracks/catalogs/iracing";
import { tryGetServerGame } from "../games/registry";
import { loadCanonicalTrackPeer, loadTrackConfigurationFactsSlug } from "./configuration";

/** Resolve one exact-layout metadata slug through native catalogs, then canonical iRacing peers. */
export function resolveTrackSharedName(ordinal: number, gameId?: string): string | undefined {
  const parsedGameId = GameIdSchema.safeParse(gameId);
  if (parsedGameId.success) {
    const factsSlug = loadTrackConfigurationFactsSlug(parsedGameId.data, ordinal);
    if (factsSlug) return factsSlug;
  }

  if (gameId === "iracing") return getIRacingTrack(ordinal)?.commonTrackName || undefined;
  if (!gameId) return undefined;

  const serverName = tryGetServerGame(gameId)?.getSharedTrackName?.(ordinal);
  if (serverName) return serverName;
  const sharedName = tryGetGame(gameId)?.getSharedTrackName?.(ordinal);
  if (sharedName) return sharedName;

  if (!parsedGameId.success) return undefined;
  const iracingPeer = loadCanonicalTrackPeer(parsedGameId.data, ordinal, "iracing");
  return iracingPeer ? getIRacingTrack(iracingPeer.trackOrdinal)?.commonTrackName || undefined : undefined;
}
