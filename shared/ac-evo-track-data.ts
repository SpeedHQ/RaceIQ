import { readFileSync } from "fs";
import { resolve } from "path";
import { SHARED_DIR } from "./resolve-data";

interface AcEvoTrack {
  id: number;
  name: string;
  variant: string;
  commonTrackName: string;
  /** AC-Evo's Setups-folder key (Setups/<car>/<setupFolder>/). */
  setupFolder: string;
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
    const setupFolder = parts[4]?.trim() ?? "";
    if (!isNaN(id) && name) {
      trackMap.set(id, { id, name: name.trim(), variant: variant.trim(), commonTrackName, setupFolder });
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

/** Distinct AC-Evo Setups-folder track keys, sorted — the canonical track roster
 *  for the "place a dropped setup" picker (data-driven from tracks.csv). */
export function getAcEvoSetupFolderKeys(): string[] {
  const keys = new Set<string>();
  for (const t of ensureLoaded().values()) if (t.setupFolder) keys.add(t.setupFolder);
  return [...keys].sort();
}

/** Setup-folder keys that share one on-disk Setups folder with `key`.
 *
 *  AC Evo saves setups per circuit, not per layout: every variant of a track
 *  (Brands Hatch GP and Indy, …) writes to the same Setups/<car>/<folder>/
 *  directory, keyed by the base track name. The CSV keeps one setupFolder key
 *  per variant (needed as distinct picker/session keys), so this derives the
 *  alias group generically: all setupFolder keys of variants with the same
 *  base `name`. Always includes `key` itself; returns [key] for unknown keys. */
export function getAcEvoSetupFolderAliases(key: string): string[] {
  ensureLoaded();
  const needle = norm(key);
  let baseName: string | undefined;
  for (const t of trackMap!.values()) {
    if (t.setupFolder && norm(t.setupFolder) === needle) { baseName = norm(t.name); break; }
  }
  if (!baseName) return [key];
  const aliases = new Set<string>([key]);
  for (const t of trackMap!.values()) {
    if (t.setupFolder && norm(t.name) === baseName) aliases.add(t.setupFolder);
  }
  return [...aliases].sort();
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[-_\s]/g, "");
}

function findExact(needle: string): AcEvoTrack | undefined {
  for (const track of trackMap!.values()) {
    if (
      norm(track.commonTrackName) === needle ||
      norm(track.name) === needle ||
      norm(`${track.name}${track.variant}`) === needle
    ) {
      return track;
    }
  }
  return undefined;
}

function findFuzzy(needle: string): AcEvoTrack | undefined {
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

/**
 * Find a track by its AC Evo shared memory string name (e.g. "monza", "spa").
 *
 * AC Evo reports the layout in a SEPARATE shm field (track_configuration),
 * so callers that have it MUST pass `config` — "brands_hatch" alone
 * exact-matches the GP row and Indy would never be considered.
 *
 * When `config` is given we first require an exact match on
 * track+config (name+variant, or the combined commonTrackName like
 * "brands-hatch-indy"). Only if that fails do we fall back to the plain
 * track string. Exact matches (commonTrackName, name, or name+variant)
 * always win over substring matching, which prefers the LONGEST candidate
 * so "brands-hatch-indy" beats "brands-hatch" instead of whichever row
 * happens to come first in the CSV.
 */
export function getAcEvoTrackByName(trackStr: string, config?: string): AcEvoTrack | undefined {
  ensureLoaded();
  const needle = norm(trackStr);
  if (!needle) return undefined;

  if (config) {
    const cfgNeedle = norm(`${trackStr}${config}`);
    if (cfgNeedle !== needle) {
      // Exact-only for the combined form: substring matching on
      // "monzafull" etc. would just re-match the base name arbitrarily.
      const withCfg = findExact(cfgNeedle);
      if (withCfg) return withCfg;
    }
  }

  return findExact(needle) ?? findFuzzy(needle);
}

/** Resolve an AC-Evo Setups-folder key to its track by matching the setupFolder
 *  column. On collisions returns the lowest id. */
export function getAcEvoTrackBySetupFolder(key: string): AcEvoTrack | undefined {
  ensureLoaded();
  const needle = norm(key);
  let best: AcEvoTrack | undefined;
  for (const t of trackMap!.values()) {
    if (!t.setupFolder) continue;
    if (norm(t.setupFolder) === needle && (!best || t.id < best.id)) best = t;
  }
  return best;
}
