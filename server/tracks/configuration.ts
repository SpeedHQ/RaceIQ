import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KNOWN_GAME_IDS, type GameId } from "../../shared/games/ids";
import { TrackConfigurationSchema, trackConfigurationCanonicalId, type TrackConfiguration } from "../../shared/racing/tracks/configuration";
import { SHARED_DIR } from "../runtime/config/paths";

const TRACK_CONFIGURATION_ROOT = resolve(SHARED_DIR, "tracks", "configuration");

export function trackConfigurationPath(gameId: GameId, trackOrdinal: number): string {
  return resolve(TRACK_CONFIGURATION_ROOT, gameId, `${trackOrdinal}.json`);
}

export function loadTrackConfiguration(gameId: GameId, trackOrdinal: number): TrackConfiguration | null {
  const path = trackConfigurationPath(gameId, trackOrdinal);
  if (!existsSync(path)) return null;
  const parsed = TrackConfigurationSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`Invalid track configuration ${path}: ${parsed.error.message}`);
  if (parsed.data.gameId !== gameId || parsed.data.trackOrdinal !== trackOrdinal) {
    throw new Error(`Track configuration identity mismatch in ${path}`);
  }
  return parsed.data;
}

export function listTrackConfigurations(): TrackConfiguration[] {
  const configurations: TrackConfiguration[] = [];
  for (const gameId of KNOWN_GAME_IDS) {
    const directory = resolve(TRACK_CONFIGURATION_ROOT, gameId);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".json")) continue;
      const trackOrdinal = Number.parseInt(entry.slice(0, -5), 10);
      if (!Number.isSafeInteger(trackOrdinal) || trackOrdinal < 0) continue;
      const configuration = loadTrackConfiguration(gameId, trackOrdinal);
      if (configuration) configurations.push(configuration);
    }
  }
  configurations.sort((a, b) => KNOWN_GAME_IDS.indexOf(a.gameId) - KNOWN_GAME_IDS.indexOf(b.gameId) || a.trackOrdinal - b.trackOrdinal);
  return configurations;
}

/** List tracks assigned to the same exact canonical layout, excluding source track. */
export function listCanonicalTrackPeers(gameId: GameId, trackOrdinal: number): TrackConfiguration[] {
  const source = loadTrackConfiguration(gameId, trackOrdinal);
  if (!source) return [];
  const canonicalId = trackConfigurationCanonicalId(source);
  return listTrackConfigurations().filter(
    (configuration) => (configuration.gameId !== gameId || configuration.trackOrdinal !== trackOrdinal) && trackConfigurationCanonicalId(configuration) === canonicalId,
  );
}

export function loadCanonicalTrackPeer(gameId: GameId, trackOrdinal: number, peerGameId: GameId): TrackConfiguration | null {
  return listCanonicalTrackPeers(gameId, trackOrdinal).find((configuration) => configuration.gameId === peerGameId) ?? null;
}
