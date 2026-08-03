import {
  loadKunosTrackCatalog,
  normalizeKunosCatalogName,
  type KunosTrack,
} from "./kunos";

let tracks: Map<number, KunosTrack> | undefined;

function getTracks(): Map<number, KunosTrack> {
  return tracks ??= loadKunosTrackCatalog("ac-evo");
}

export function getAcEvoTrackName(ordinal: number): string {
  if (ordinal < 0) return "Unknown Track";
  const track = getTracks().get(ordinal);
  return track ? `${track.name} - ${track.variant}` : `Track #${ordinal}`;
}

export function getAcEvoSharedTrackName(ordinal: number): string | undefined {
  return getTracks().get(ordinal)?.commonTrackName || undefined;
}

export function getAcEvoTracks(): Map<number, KunosTrack> {
  return getTracks();
}

export function getAcEvoSetupFolderKeys(): string[] {
  const keys = new Set<string>();
  for (const track of getTracks().values()) {
    if (track.setupFolder) keys.add(track.setupFolder);
  }
  return Array.from(keys).sort();
}

export function getAcEvoSetupFolderAliases(key: string): string[] {
  const needle = normalizeKunosCatalogName(key);
  let baseName: string | undefined;
  for (const track of getTracks().values()) {
    if (track.setupFolder && normalizeKunosCatalogName(track.setupFolder) === needle) {
      baseName = normalizeKunosCatalogName(track.name);
      break;
    }
  }
  if (!baseName) return [key];

  const aliases = new Set<string>([key]);
  for (const track of getTracks().values()) {
    if (track.setupFolder && normalizeKunosCatalogName(track.name) === baseName) aliases.add(track.setupFolder);
  }
  return Array.from(aliases).sort();
}

function findExact(needle: string): KunosTrack | undefined {
  for (const track of getTracks().values()) {
    if (
      normalizeKunosCatalogName(track.commonTrackName) === needle
      || normalizeKunosCatalogName(track.name) === needle
      || normalizeKunosCatalogName(`${track.name}${track.variant}`) === needle
    ) {
      return track;
    }
  }
  return undefined;
}

function findFuzzy(needle: string): KunosTrack | undefined {
  let best: KunosTrack | undefined;
  let bestLength = 0;
  for (const track of getTracks().values()) {
    for (const candidate of [track.commonTrackName, track.name].map(normalizeKunosCatalogName)) {
      if (!candidate) continue;
      if (candidate.includes(needle) || needle.includes(candidate)) {
        const length = Math.min(candidate.length, needle.length);
        if (length > bestLength) {
          best = track;
          bestLength = length;
        }
      }
    }
  }
  return best;
}

/** Combined track+configuration exact match wins before base-name fuzzy lookup. */
export function getAcEvoTrackByName(trackName: string, config?: string): KunosTrack | undefined {
  const needle = normalizeKunosCatalogName(trackName);
  if (!needle) return undefined;
  if (config) {
    const configured = normalizeKunosCatalogName(`${trackName}${config}`);
    if (configured !== needle) {
      const match = findExact(configured);
      if (match) return match;
    }
  }
  return findExact(needle) ?? findFuzzy(needle);
}

export function getAcEvoTrackBySetupFolder(key: string): KunosTrack | undefined {
  const needle = normalizeKunosCatalogName(key);
  let best: KunosTrack | undefined;
  for (const track of getTracks().values()) {
    if (
      track.setupFolder
      && normalizeKunosCatalogName(track.setupFolder) === needle
      && (!best || track.id < best.id)
    ) {
      best = track;
    }
  }
  return best;
}
