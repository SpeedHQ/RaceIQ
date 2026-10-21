import { DEFAULT_SECTORS, getTrackSectorsByName, type TrackSectors } from "@raceiq/shared/racing/tracks/sectors";
import { getTrackNameByOrdinal } from "../geometry/outlines";

export function getTrackSectorsByOrdinal(ordinal: number): TrackSectors {
  const name = getTrackNameByOrdinal(ordinal);
  if (!name) return DEFAULT_SECTORS;
  return getTrackSectorsByName(name);
}
