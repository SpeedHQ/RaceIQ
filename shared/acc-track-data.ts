import { readFileSync } from "fs";
import { resolve } from "path";
import { SHARED_DIR } from "./resolve-data";

interface AccTrack {
  id: number;
  name: string;
  variant: string;
  commonTrackName: string;
  /** ACC's own Setups-folder key (Setups/<car>/<setupFolder>/). */
  setupFolder: string;
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
    const setupFolder = parts[4]?.trim() ?? "";
    if (!isNaN(id) && name) {
      trackMap.set(id, { id, name: name.trim(), variant: variant.trim(), commonTrackName, setupFolder });
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

/** Distinct ACC Setups-folder track keys, sorted — the canonical track roster
 *  for the "place a dropped setup" picker (data-driven from tracks.csv). */
export function getAccSetupFolderKeys(): string[] {
  const keys = new Set<string>();
  for (const t of ensureLoaded().values()) if (t.setupFolder) keys.add(t.setupFolder);
  return [...keys].sort();
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

/** Resolve an ACC Setups-folder key (e.g. "red_bull_ring", "barcelona") to its
 *  track by matching the setupFolder column. On base-vs-2019 collisions returns
 *  the lowest id (base variant). */
export function getAccTrackBySetupFolder(key: string): AccTrack | undefined {
  ensureLoaded();
  const needle = key.toLowerCase().replace(/[-_\s]/g, "");
  let best: AccTrack | undefined;
  for (const t of trackMap!.values()) {
    if (!t.setupFolder) continue;
    const hay = t.setupFolder.toLowerCase().replace(/[-_\s]/g, "");
    if (hay === needle && (!best || t.id < best.id)) best = t;
  }
  return best;
}
