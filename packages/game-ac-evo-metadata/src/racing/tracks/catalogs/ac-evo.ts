import {
  loadKunosTrackCatalog,
  normalizeKunosCatalogName,
  type KunosTrack,
} from "@raceiq/shared/racing/tracks/catalogs/kunos";

let tracks: Map<number, KunosTrack> | undefined;
const discoveredTracksById = new Map<number, KunosTrack>();
const discoveredTracksBySource = new Map<string, KunosTrack>();

function getTracks(): Map<number, KunosTrack> {
  tracks ??= loadKunosTrackCatalog("ac-evo");
  return tracks;
}

export function injectDiscoveredAcEvoTracks(rows: {
  ordinal: number;
  name: string;
  trackName?: string | null;
  trackConfiguration?: string | null;
  sourceKey?: string | null;
}[]): void {
  for (const row of rows) {
    const sourceName = row.trackName ?? row.name;
    const configuration = row.trackConfiguration ?? "";
    const track = {
      id: row.ordinal,
      name: sourceName,
      variant: configuration,
      commonTrackName: sourceName,
    } as KunosTrack;
    discoveredTracksById.set(row.ordinal, track);
    if (row.trackName === null || row.trackConfiguration === null) continue;
    const key = JSON.stringify([
      sourceName.trim().normalize("NFC").toLowerCase(),
      configuration.trim().normalize("NFC").toLowerCase(),
    ]);
    discoveredTracksBySource.set(key, track);
  }
}

export function getAcEvoTrackName(ordinal: number): string {
  if (ordinal < 0) return "Unknown Track";
  const track = discoveredTracksById.get(ordinal) ?? getTracks().get(ordinal);
  return track ? `${track.name} - ${track.variant}` : `Track #${ordinal}`;
}

export function getAcEvoSharedTrackName(ordinal: number): string | undefined {
  return discoveredTracksById.get(ordinal)?.commonTrackName
    ?? getTracks().get(ordinal)?.commonTrackName
    ?? undefined;
}

export function getAcEvoTracks(): Map<number, KunosTrack> {
  const merged = new Map(getTracks());
  for (const [ordinal, track] of discoveredTracksById) merged.set(ordinal, track);
  return merged;
}

export function getAcEvoSetupFolderKeys(): string[] {
  const keys = new Set<string>();
  for (const track of getTracks().values()) if (track.setupFolder) keys.add(track.setupFolder);
  for (const track of discoveredTracksById.values()) keys.add(track.name);
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


export function getAcEvoTrackByName(trackName: string, config = ""): KunosTrack | undefined {
  const key = JSON.stringify([
    trackName.trim().normalize("NFC").toLowerCase(),
    config.trim().normalize("NFC").toLowerCase(),
  ]);
  const discovered = discoveredTracksBySource.get(key);
  if (discovered) return discovered;
  const exact = [...getTracks().values()].filter((track) =>
    track.name.trim().normalize("NFC").toLowerCase() === trackName.trim().normalize("NFC").toLowerCase()
    && track.variant.trim().normalize("NFC").toLowerCase() === config.trim().normalize("NFC").toLowerCase());
  return exact.length === 1 ? exact[0] : undefined;
}

export function getAcEvoTrackBySetupFolder(key: string): KunosTrack | undefined {
  const needle = normalizeKunosCatalogName(key);
  const discovered = [...discoveredTracksById.values()].filter((track) =>
    normalizeKunosCatalogName(track.name) === needle);
  if (discovered.length > 1) return undefined;
  if (discovered.length === 1) return discovered[0];
  for (const track of getTracks().values()) {
    if (track.setupFolder && normalizeKunosCatalogName(track.setupFolder) === needle) return track;
  }
  return undefined;
}
export function getAcEvoTrackByLegacyName(trackName: string): KunosTrack | undefined {
  const needle = trackName.trim().normalize("NFC").toLowerCase();
  const matches = [...getTracks().values()].filter((track) =>
    track.name.trim().normalize("NFC").toLowerCase() === needle
    || track.commonTrackName.trim().normalize("NFC").toLowerCase() === needle);
  return matches.length === 1 ? matches[0] : undefined;
}

