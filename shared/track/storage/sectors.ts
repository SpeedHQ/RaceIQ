import { DEFAULT_SECTORS, getTrackSectorsByName, type TrackSectors } from "../sectors";
import { getTrackNameByOrdinal } from "../geometry/outlines";

export type { TrackSectors };

export function getTrackSectors(trackName: string): TrackSectors {
  return getTrackSectorsByName(trackName);
}

export function getTrackSectorsByOrdinal(ordinal: number): TrackSectors {
  const name = getTrackNameByOrdinal(ordinal);
  if (!name) return DEFAULT_SECTORS;
  return getTrackSectorsByName(name);
}
