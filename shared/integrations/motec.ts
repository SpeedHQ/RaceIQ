/**
 * Constants shared between the MoTeC importer (server) and anything that has
 * to tell an imported session apart from a recorded one (client).
 */

/**
 * `sessions.source` value written by the MoTeC importer.
 *
 * A session carrying this marker was transcoded from a `.ld` export: its
 * racing line is dead-reckoned from speed/yaw rather than logged, and it has
 * no absolute world position. Anything that compares position or renders a
 * track map must treat it as approximate — hence the UI keeps imported
 * sessions in their own list rather than mixing them with recorded ones.
 */
export const MOTEC_SESSION_SOURCE = "motec";

/**
 * Games whose MoTeC `.ld` exports the importer can currently transcode.
 *
 * The transcoder is per-game: channel names, units and corner-surfix
 * conventions differ per exporter, so a log can only be trusted once that
 * game's mapping has been verified against a real export. Other sims will be
 * added here as their mappings land — the tab stays hidden until then rather
 * than offering an import that would silently produce a wrong-looking lap.
 */
const MOTEC_SUPPORTED_GAME_IDS: readonly string[] = ["ac-evo"];

/** Whether the MoTeC import UI (imported-sessions tab) applies to a game. */
export function motecImportSupported(gameId: string | undefined | null): boolean {
  return gameId != null && MOTEC_SUPPORTED_GAME_IDS.includes(gameId);
}
