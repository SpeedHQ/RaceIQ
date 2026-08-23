import { DEFAULT_SECTORS, getTrackSectorsByName, type TrackSectors } from "../sectors";
import { getTrackAssetIdentity } from "./assets";

export type { TrackSectors };

export function getTrackSectors(trackName: string): TrackSectors {
  return getTrackSectorsByName(trackName);
}

export function getTrackSectorsByOrdinal(ordinal: number): TrackSectors {
  const factsSlug = getTrackAssetIdentity("fm-2023", ordinal)?.factsSlug;
  return factsSlug ? getTrackSectorsByName(factsSlug) : DEFAULT_SECTORS;
}
