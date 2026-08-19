import { KNOWN_GAME_IDS, type GameId } from "../../shared/games/ids";
import { TrackConfigurationSchema, trackConfigurationCanonicalId, type TrackConfiguration, type TrackIdentityNode } from "../../shared/racing/tracks/configuration";
import { updateTrackRegistrySource } from "../../shared/racing/tracks/registry-source";
import { getTrackRegistry } from "../../shared/racing/tracks/registry";

interface ConfigurationRow {
  gameId: GameId;
  trackOrdinal: number;
  venuePath: string;
  layoutSlug: string;
  layoutName: string;
  confirmedAt: string | null;
  confirmedBy: string | null;
  commitId: string | null;
}

interface VenueRow extends TrackIdentityNode {
  path: string;
  depth: number;
}

const CONFIGURATION_SELECT = `
  SELECT gt.game_id AS gameId,
         gt.track_ordinal AS trackOrdinal,
         l.venue_path AS venuePath,
         l.slug AS layoutSlug,
         l.name AS layoutName,
         gt.confirmed_at AS confirmedAt,
         gt.confirmed_by AS confirmedBy,
         gt.commit_id AS commitId
    FROM game_tracks gt
    JOIN layouts l ON l.canonical_id = gt.layout_id`;

function venueNodesByPath(): Map<string, VenueRow> {
  const rows = getTrackRegistry()
    .query("SELECT path, slug AS id, name, depth FROM venue_nodes ORDER BY depth, path")
    .all() as VenueRow[];
  return new Map(rows.map((row) => [row.path, row]));
}

function configurationFromRow(row: ConfigurationRow, venues: Map<string, VenueRow>): TrackConfiguration {
  const paths = row.venuePath.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"));
  const nodes = paths.map((path) => venues.get(path));
  if (nodes.some((entry) => !entry)) throw new Error(`Track registry venue hierarchy is incomplete for ${row.venuePath}`);
  const [venue, ...subVenues] = nodes as VenueRow[];
  return TrackConfigurationSchema.parse({
    version: 1,
    gameId: row.gameId,
    trackOrdinal: row.trackOrdinal,
    venue: { id: venue.id, name: venue.name },
    subVenues: subVenues.map(({ id, name }) => ({ id, name })),
    track: { id: row.layoutSlug, name: row.layoutName },
    confirmation: row.confirmedAt && row.confirmedBy
      ? { confirmedAt: row.confirmedAt, confirmedBy: row.confirmedBy, ...(row.commitId ? { commitId: row.commitId } : {}) }
      : null,
  });
}

export function loadTrackConfiguration(gameId: GameId, trackOrdinal: number): TrackConfiguration | null {
  const row = getTrackRegistry()
    .query(`${CONFIGURATION_SELECT} WHERE gt.game_id = ? AND gt.track_ordinal = ?`)
    .get(gameId, trackOrdinal) as ConfigurationRow | null;
  return row ? configurationFromRow(row, venueNodesByPath()) : null;
}

export function listTrackConfigurations(): TrackConfiguration[] {
  const venues = venueNodesByPath();
  const rows = getTrackRegistry().query(`${CONFIGURATION_SELECT} ORDER BY gt.game_id, gt.track_ordinal`).all() as ConfigurationRow[];
  return rows
    .map((row) => configurationFromRow(row, venues))
    .sort((a, b) => KNOWN_GAME_IDS.indexOf(a.gameId) - KNOWN_GAME_IDS.indexOf(b.gameId) || a.trackOrdinal - b.trackOrdinal);
}

export function saveTrackConfiguration(configuration: TrackConfiguration): TrackConfiguration {
  const parsed = TrackConfigurationSchema.parse(configuration);
  updateTrackRegistrySource((draft) => {
    const pathParts: string[] = [];
    for (const node of [parsed.venue, ...parsed.subVenues]) {
      pathParts.push(node.id);
      const venue = { id: pathParts.join("/"), name: node.name };
      const venueIndex = draft.configurations.venues.findIndex((entry) => entry.id === venue.id);
      if (venueIndex >= 0) draft.configurations.venues[venueIndex] = venue;
      else draft.configurations.venues.push(venue);
    }

    const canonicalId = trackConfigurationCanonicalId(parsed);
    const layoutIndex = draft.configurations.layouts.findIndex((entry) => entry.id === canonicalId);
    if (layoutIndex >= 0) {
      draft.configurations.layouts[layoutIndex] = {
        ...draft.configurations.layouts[layoutIndex],
        id: canonicalId,
        name: parsed.track.name,
      };
    } else {
      draft.configurations.layouts.push({ id: canonicalId, name: parsed.track.name });
    }

    const assignment = {
      gameId: parsed.gameId,
      trackOrdinal: parsed.trackOrdinal,
      layoutId: canonicalId,
      confirmation: parsed.confirmation,
    };
    const assignmentIndex = draft.configurations.assignments.findIndex(
      (entry) => entry.gameId === parsed.gameId && entry.trackOrdinal === parsed.trackOrdinal,
    );
    if (assignmentIndex >= 0) draft.configurations.assignments[assignmentIndex] = assignment;
    else draft.configurations.assignments.push(assignment);
  });
  return parsed;
}

export function deleteTrackConfiguration(gameId: GameId, trackOrdinal: number): boolean {
  let deleted = false;
  updateTrackRegistrySource((draft) => {
    const index = draft.configurations.assignments.findIndex(
      (entry) => entry.gameId === gameId && entry.trackOrdinal === trackOrdinal,
    );
    if (index < 0) return;
    draft.configurations.assignments.splice(index, 1);
    deleted = true;
  });
  return deleted;
}

/** List tracks assigned to the same exact canonical layout, excluding source track. */
export function listCanonicalTrackPeers(gameId: GameId, trackOrdinal: number): TrackConfiguration[] {
  const rows = getTrackRegistry().query(`
    ${CONFIGURATION_SELECT}
     WHERE gt.layout_id = (SELECT layout_id FROM game_tracks WHERE game_id = ? AND track_ordinal = ?)
       AND (gt.game_id <> ? OR gt.track_ordinal <> ?)
     ORDER BY gt.game_id, gt.track_ordinal
  `).all(gameId, trackOrdinal, gameId, trackOrdinal) as ConfigurationRow[];
  const venues = venueNodesByPath();
  return rows.map((row) => configurationFromRow(row, venues));
}

export function loadCanonicalTrackPeer(gameId: GameId, trackOrdinal: number, peerGameId: GameId): TrackConfiguration | null {
  return listCanonicalTrackPeers(gameId, trackOrdinal).find((configuration) => configuration.gameId === peerGameId) ?? null;
}
