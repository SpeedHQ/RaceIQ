import { readFileSync } from "fs";
import { resolve } from "path";
import { SHARED_DIR } from "./resolve-data";

interface AcEvoTrack {
  id: number;
  name: string;
  variant: string;
  commonTrackName: string;
}

let trackMap: Map<number, AcEvoTrack> | null = null;

function ensureLoaded(): Map<number, AcEvoTrack> {
  if (trackMap) return trackMap;
  trackMap = new Map();
  const csv = readFileSync(resolve(SHARED_DIR, "games/ac-evo/tracks.csv"), "utf-8");
  const lines = csv.trim().split("\n").slice(1); // skip header
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: id,name,variant,commonTrackName (comma-separated)
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

export function getAcEvoTrackName(ordinal: number): string {
  if (ordinal < 0) return "Unknown Track"; // -1 sentinel: track never identified
  const track = ensureLoaded().get(ordinal);
  return track ? `${track.name} - ${track.variant}` : `Track #${ordinal}`;
}

export function getAcEvoSharedTrackName(ordinal: number): string | undefined {
  const track = ensureLoaded().get(ordinal);
  if (!track) return undefined;
  return track.commonTrackName || undefined;
}

/** Get all AC Evo tracks as a Map of id → info */
export function getAcEvoTracks(): Map<number, AcEvoTrack> {
  return ensureLoaded();
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[-_\s]/g, "");
}

/**
 * Find a track by its AC Evo shared memory string name (e.g. "monza", "spa").
 *
 * Exact matches (commonTrackName, name, or name+variant) always win. Only
 * then do we fall back to substring matching, preferring the LONGEST
 * candidate so "brands-hatch-indy" beats "brands-hatch" instead of whichever
 * row happens to come first in the CSV.
 */
export function getAcEvoTrackByName(trackStr: string): AcEvoTrack | undefined {
  ensureLoaded();
  const needle = norm(trackStr);
  if (!needle) return undefined;

  for (const track of trackMap!.values()) {
    if (
      norm(track.commonTrackName) === needle ||
      norm(track.name) === needle ||
      norm(`${track.name}${track.variant}`) === needle
    ) {
      return track;
    }
  }

  let best: AcEvoTrack | undefined;
  let bestLen = 0;
  for (const track of trackMap!.values()) {
    for (const hay of [norm(track.commonTrackName), norm(track.name)]) {
      if (!hay) continue;
      if (hay.includes(needle) || needle.includes(hay)) {
        const len = Math.min(hay.length, needle.length);
        if (len > bestLen) {
          best = track;
          bestLen = len;
        }
      }
    }
  }
  return best;
}
