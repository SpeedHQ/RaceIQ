import {
  loadKunosTrackCatalog,
  normalizeKunosCatalogName,
  type KunosTrack,
} from "./kunos";

let tracks: Map<number, KunosTrack> | undefined;

function getTracks(): Map<number, KunosTrack> {
  return tracks ??= loadKunosTrackCatalog("acc");
}

export function getAccTrackName(ordinal: number): string {
  const track = getTracks().get(ordinal);
  return track ? `${track.name} - ${track.variant}` : `Track #${ordinal}`;
}

export function getAccSharedTrackName(ordinal: number): string | undefined {
  return getTracks().get(ordinal)?.commonTrackName || undefined;
}

export function getAccTracks(): Map<number, KunosTrack> {
  return getTracks();
}

export function getAccSetupFolderKeys(): string[] {
  const keys = new Set<string>();
  for (const track of getTracks().values()) {
    if (track.setupFolder) keys.add(track.setupFolder);
  }
  return Array.from(keys).sort();
}

export function getAccTrackByName(trackName: string): KunosTrack | undefined {
  const needle = normalizeKunosCatalogName(trackName);
  for (const track of getTracks().values()) {
    const candidate = normalizeKunosCatalogName(track.name);
    if (candidate === needle || candidate.includes(needle) || needle.includes(candidate)) return track;
  }
  return undefined;
}

export function getAccTrackBySetupFolder(key: string): KunosTrack | undefined {
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
