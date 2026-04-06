import { readFileSync } from "fs";
import { resolve } from "path";
import { SHARED_DIR } from "./resolve-data";

interface AccTrack {
  id: number;
  name: string;
  variant: string;
  commonTrackName: string;
}

let trackMap: Map<number, AccTrack> | null = null;

function ensureLoaded(): Map<number, AccTrack> {
  if (trackMap) return trackMap;
  trackMap = new Map();
  const csv = readFileSync(resolve(SHARED_DIR, "games/acc/tracks.csv"), "utf-8");
  const lines = csv.trim().split("\n").slice(1); // skip header
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(",");
    if (parts.length < 3) continue;
    const id = parseInt(parts[0], 10);
    const name = parts[1];
    const variant = parts[2];
    const commonTrackName = parts[3]?.trim() ?? "";
    if (!isNaN(id) && name) {
      trackMap.set(id, { id, name: name.trim(), variant: variant.trim(), commonTrackName });
    }
  }
  return trackMap;
}

export function getAccTrackName(ordinal: number): string {
  const track = ensureLoaded().get(ordinal);
  return track ? `${track.name} - ${track.variant}` : `Track #${ordinal}`;
}

export function getAccSharedTrackName(ordinal: number): string | undefined {
  const track = ensureLoaded().get(ordinal);
  if (!track) return undefined;
  return track.commonTrackName || undefined;
}

/** Get all ACC tracks as a Map of id → info */
export function getAccTracks(): Map<number, AccTrack> {
  return ensureLoaded();
}

/** Find a track by its ACC shared memory string name (e.g. "nurburgring", "spa") */
export function getAccTrackByName(trackStr: string): AccTrack | undefined {
  ensureLoaded();
  const needle = trackStr.toLowerCase().replace(/[-_\s]/g, "");
  for (const track of trackMap!.values()) {
    const haystack = track.name.toLowerCase().replace(/[-_\s]/g, "");
    if (haystack === needle || haystack.includes(needle) || needle.includes(haystack)) {
      return track;
    }
  }
  return undefined;
}
