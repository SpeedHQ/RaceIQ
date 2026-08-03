import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCsvLine } from "@shared/core/csv";
import { GAMES_DIR } from "@shared/platform/runtime/data-paths";

export interface F1TrackInfo {
  name: string;
  location: string;
  country: string;
  variant: string;
  lengthKm: number;
  commonTrackName: string;
}

const tracks = new Map<number, F1TrackInfo>();
const raw = readFileSync(resolve(GAMES_DIR, "f1-2025/tracks.csv"), "utf-8");
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  const fields = parseCsvLine(line);
  const id = Number.parseInt(fields[0], 10);
  if (!Number.isInteger(id) || !fields[1]) continue;
  const lengthKm = Number.parseFloat(fields[5]);
  tracks.set(id, {
    name: fields[1],
    location: fields[2],
    country: fields[3],
    variant: fields[4],
    lengthKm: Number.isNaN(lengthKm) ? 0 : lengthKm,
    commonTrackName: fields[6]?.trim() ?? "",
  });
}

export function getF1TrackName(trackId: number): string {
  return tracks.get(trackId)?.name ?? `Track ${trackId}`;
}

export function getF1TrackInfo(trackId: number): F1TrackInfo | undefined {
  return tracks.get(trackId);
}

export function getF1Tracks(): Map<number, F1TrackInfo> {
  return tracks;
}
