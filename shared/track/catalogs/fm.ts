import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCsvLine } from "../../catalog/csv";
import { SHARED_DIR } from "../../runtime/data-paths";

export interface FmTrackInfo {
  name: string;
  location: string;
  country: string;
  variant: string;
  lengthKm: number;
}

export const fmTrackCatalog = new Map<number, FmTrackInfo>();
const bundledNameByOrdinal = new Map<number, string>();

const raw = readFileSync(resolve(SHARED_DIR, "games/fm-2023/tracks.csv"), "utf-8");
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  const fields = parseCsvLine(line);
  const ordinal = Number.parseInt(fields[0], 10);
  if (!Number.isInteger(ordinal) || !fields[1]) continue;
  const lengthKm = Number.parseFloat(fields[5]);
  fmTrackCatalog.set(ordinal, {
    name: fields[1],
    location: fields[2],
    country: fields[3],
    variant: fields[4],
    lengthKm: Number.isNaN(lengthKm) ? 0 : lengthKm,
  });
  const commonTrackName = fields[6]?.trim();
  bundledNameByOrdinal.set(
    ordinal,
    commonTrackName ? `${commonTrackName}-${ordinal}` : `${ordinal}`,
  );
}

export function getFmTrackName(ordinal: number): string {
  const track = fmTrackCatalog.get(ordinal);
  return track ? `${track.name} - ${track.variant}` : `Track #${ordinal}`;
}

export function getFmBundledTrackName(ordinal: number): string | undefined {
  return bundledNameByOrdinal.get(ordinal);
}
