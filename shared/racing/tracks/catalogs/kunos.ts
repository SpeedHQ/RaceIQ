import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCsvLine } from "@shared/core/csv";
import { GAMES_DIR } from "@shared/platform/runtime/data-paths";

export interface KunosTrack {
  id: number;
  name: string;
  variant: string;
  commonTrackName: string;
  setupFolder: string;
}

export function loadKunosTrackCatalog(gameId: "acc" | "ac-evo"): Map<number, KunosTrack> {
  const tracks = new Map<number, KunosTrack>();
  const raw = readFileSync(resolve(GAMES_DIR, gameId, "tracks.csv"), "utf-8");
  for (const line of raw.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    const id = Number.parseInt(fields[0], 10);
    if (!Number.isInteger(id) || !fields[1]) continue;
    tracks.set(id, {
      id,
      name: fields[1].trim(),
      variant: fields[2]?.trim() ?? "",
      commonTrackName: fields[3]?.trim() ?? "",
      setupFolder: fields[4]?.trim() ?? "",
    });
  }
  return tracks;
}

export function normalizeKunosCatalogName(value: string): string {
  return value.toLowerCase().replace(/[-_\s]/g, "");
}
