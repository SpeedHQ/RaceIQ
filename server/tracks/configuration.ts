import { KNOWN_GAME_IDS, type GameId } from "../../shared/games/ids";
import { TrackConfigurationSchema, trackConfigurationCanonicalId, type TrackConfiguration, type TrackIdentityNode } from "../../shared/racing/tracks/configuration";
import { getTrackRegistry, writeTrackRegistry } from "../../shared/racing/tracks/registry";

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
  writeTrackRegistry((database) => {
    let parentPath: string | null = null;
    const pathParts: string[] = [];
    for (const [depth, node] of [parsed.venue, ...parsed.subVenues].entries()) {
      pathParts.push(node.id);
      const path = pathParts.join("/");
      database.query(`
        INSERT INTO venue_nodes (path, parent_path, slug, name, depth) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET parent_path = excluded.parent_path, slug = excluded.slug, name = excluded.name, depth = excluded.depth
      `).run(path, parentPath, node.id, node.name, depth);
      parentPath = path;
    }
    const canonicalId = trackConfigurationCanonicalId(parsed);
    database.query(`
      INSERT INTO layouts (canonical_id, venue_path, slug, name) VALUES (?, ?, ?, ?)
      ON CONFLICT(canonical_id) DO UPDATE SET venue_path = excluded.venue_path, slug = excluded.slug, name = excluded.name
    `).run(canonicalId, parentPath, parsed.track.id, parsed.track.name);
    database.query(`
      INSERT INTO game_tracks (game_id, track_ordinal, layout_id, confirmed_at, confirmed_by, commit_id) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(game_id, track_ordinal) DO UPDATE SET
        layout_id = excluded.layout_id,
        confirmed_at = excluded.confirmed_at,
        confirmed_by = excluded.confirmed_by,
        commit_id = excluded.commit_id
    `).run(
      parsed.gameId,
      parsed.trackOrdinal,
      canonicalId,
      parsed.confirmation?.confirmedAt ?? null,
      parsed.confirmation?.confirmedBy ?? null,
      parsed.confirmation?.commitId ?? null,
    );
  });
  return parsed;
}

export function deleteTrackConfiguration(gameId: GameId, trackOrdinal: number): boolean {
  let deleted = false;
  writeTrackRegistry((database) => {
    deleted = database.query("DELETE FROM game_tracks WHERE game_id = ? AND track_ordinal = ?").run(gameId, trackOrdinal).changes > 0;
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
