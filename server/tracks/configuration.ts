import { KNOWN_GAME_IDS, type GameId } from "../../shared/games/ids";
import {
  TrackConfigurationSchema,
  parseCanonicalTrackId,
  trackConfigurationCanonicalId,
  type TrackConfiguration,
} from "../../shared/racing/tracks/configuration";
import { getTrackRegistry, getTrackRegistryIndexes, type TrackRegistryReadModel } from "../../shared/racing/tracks/registry";
import { updateTrackRegistrySource } from "../../shared/racing/tracks/registry/update";

type TrackAssignment = TrackRegistryReadModel["assignments"][number];

function configurationFromAssignment(assignment: TrackAssignment): TrackConfiguration {
  const indexes = getTrackRegistryIndexes();
  const layout = indexes.layoutsById.get(assignment.layoutId);
  if (!layout) throw new Error(`Track registry layout is missing for ${assignment.layoutId}`);
  const { venuePath, layoutSlug } = parseCanonicalTrackId(layout.id);
  const paths = venuePath.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"));
  const nodes = paths.map((path) => indexes.venuesById.get(path));
  if (nodes.some((entry) => !entry)) throw new Error(`Track registry venue hierarchy is incomplete for ${venuePath}`);
  const [venue, ...subVenues] = nodes as Array<{ id: string; name: string }>;
  return TrackConfigurationSchema.parse({
    version: 1,
    gameId: assignment.gameId,
    trackOrdinal: assignment.trackOrdinal,
    venue: { id: venue.id.split("/").at(-1), name: venue.name },
    subVenues: subVenues.map(({ id, name }) => ({ id: id.split("/").at(-1), name })),
    track: { id: layoutSlug, name: layout.name },
    confirmation: assignment.confirmation,
  });
}

export function loadTrackConfiguration(gameId: GameId, trackOrdinal: number): TrackConfiguration | null {
  const assignment = getTrackRegistryIndexes().assignmentsByGame.get(gameId)?.get(trackOrdinal);
  return assignment ? configurationFromAssignment(assignment) : null;
}

/** Resolve authored facts identity directly from generated registry. */
export function loadTrackConfigurationFactsSlug(gameId: GameId, trackOrdinal: number): string | null {
  const indexes = getTrackRegistryIndexes();
  const assignment = indexes.assignmentsByGame.get(gameId)?.get(trackOrdinal);
  return assignment ? indexes.layoutsById.get(assignment.layoutId)?.factsSlug ?? null : null;
}

export function listTrackConfigurations(): TrackConfiguration[] {
  return getTrackRegistry()
    .assignments.map(configurationFromAssignment)
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

/** List tracks from one game in same root venue family, preferring root layouts before historical descendants. */
export function listTrackVenueFamilyConfigurations(gameId: GameId, trackOrdinal: number, venueGameId: GameId): TrackConfiguration[] {
  const source = loadTrackConfiguration(gameId, trackOrdinal);
  if (!source) return [];
  const venueRoot = source.venue.id;
  const indexes = getTrackRegistryIndexes();
  return [...(indexes.assignmentsByGame.get(venueGameId)?.values() ?? [])]
    .filter((assignment) => {
      const layout = indexes.layoutsById.get(assignment.layoutId);
      if (!layout) return false;
      const { venuePath } = parseCanonicalTrackId(layout.id);
      return venuePath === venueRoot || venuePath.startsWith(`${venueRoot}/`);
    })
    .sort((a, b) => {
      const aVenue = parseCanonicalTrackId(indexes.layoutsById.get(a.layoutId)!.id).venuePath;
      const bVenue = parseCanonicalTrackId(indexes.layoutsById.get(b.layoutId)!.id).venuePath;
      return Number(aVenue !== venueRoot) - Number(bVenue !== venueRoot) || aVenue.localeCompare(bVenue) || a.trackOrdinal - b.trackOrdinal;
    })
    .map(configurationFromAssignment);
}

/** List tracks assigned to same exact canonical layout, excluding source track. */
export function listCanonicalTrackPeers(gameId: GameId, trackOrdinal: number): TrackConfiguration[] {
  const indexes = getTrackRegistryIndexes();
  const source = indexes.assignmentsByGame.get(gameId)?.get(trackOrdinal);
  if (!source) return [];
  return [...(indexes.assignmentsByLayoutId.get(source.layoutId) ?? [])]
    .filter((assignment) => assignment.gameId !== gameId || assignment.trackOrdinal !== trackOrdinal)
    .sort((a, b) => KNOWN_GAME_IDS.indexOf(a.gameId) - KNOWN_GAME_IDS.indexOf(b.gameId) || a.trackOrdinal - b.trackOrdinal)
    .map(configurationFromAssignment);
}

export function loadCanonicalTrackPeer(gameId: GameId, trackOrdinal: number, peerGameId: GameId): TrackConfiguration | null {
  return listCanonicalTrackPeers(gameId, trackOrdinal).find((configuration) => configuration.gameId === peerGameId) ?? null;
}
