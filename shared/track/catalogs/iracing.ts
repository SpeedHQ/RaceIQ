import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCsvLine } from "../../catalog/csv";
import { SHARED_DIR } from "../../runtime/data-paths";

export interface IRacingCatalogTrack {
  ordinal: number;
  name: string;
  location: string;
  country: string;
  variant: string;
  lengthKm: number;
  commonTrackName: string;
  category: string;
  path: string;
  mapUrl: string;
}

const tracks = readFileSync(resolve(SHARED_DIR, "games/iracing/tracks.csv"), "utf-8")
  .split(/\r?\n/)
  .slice(1)
  .map((line): IRacingCatalogTrack | null => {
    if (!line.trim()) return null;
    const fields = parseCsvLine(line);
    const ordinal = Number(fields[0]);
    const lengthKm = Number(fields[5]);
    return Number.isInteger(ordinal) && fields[1]?.trim()
      ? {
          ordinal,
          name: fields[1].trim(),
          location: fields[2]?.trim() ?? "",
          country: fields[3]?.trim() ?? "",
          variant: fields[4]?.trim() ?? "",
          lengthKm: Number.isFinite(lengthKm) ? lengthKm : 0,
          commonTrackName: fields[6]?.trim() ?? "",
          category: fields[7]?.trim() ?? "",
          path: fields[8]?.trim() ?? "",
          mapUrl: fields[9]?.trim() ?? "",
        }
      : null;
  })
  .filter((track): track is IRacingCatalogTrack => track !== null);

const tracksByOrdinal = new Map(tracks.map((track) => [track.ordinal, track]));

function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function getAllIRacingTracks(): IRacingCatalogTrack[] {
  return tracks;
}

export function getIRacingTrack(ordinal: number): IRacingCatalogTrack | undefined {
  return tracksByOrdinal.get(ordinal);
}

export function getIRacingTrackName(ordinal: number): string {
  const track = getIRacingTrack(ordinal);
  if (!track) return `iRacing track #${ordinal}`;
  return track.variant ? `${track.name} - ${track.variant}` : track.name;
}

export function getIRacingSharedTrackName(ordinal: number): string | undefined {
  return getIRacingTrack(ordinal)?.commonTrackName || undefined;
}

export function getIRacingTrackOrdinalByName(name: string): number | undefined {
  const needle = normalized(name);
  if (!needle) return undefined;
  const exact = tracks.find((track) =>
    [`${track.name} ${track.variant}`, track.path]
      .some((candidate) => normalized(candidate) === needle));
  if (exact) return exact.ordinal;

  const byTrackName = tracks.filter((track) => normalized(track.name) === needle);
  return byTrackName.length === 1 ? byTrackName[0].ordinal : undefined;
}
