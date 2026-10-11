import {
  loadKunosTrackCatalog,
  normalizeKunosCatalogName,
  type KunosTrack,
} from "@raceiq/shared/racing/tracks/catalogs/kunos";
import { acEvoTrackId, parseAcEvoTrackId } from "../../../identity";

export interface AcEvoTrack extends Omit<KunosTrack, "id"> {
  id: string;
}

let tracks: Map<number, KunosTrack> | undefined;
const discoveredTracksById = new Map<string, AcEvoTrack>();
const discoveredTracksBySource = new Map<string, AcEvoTrack>();

function getTracks(): Map<number, KunosTrack> {
  tracks ??= loadKunosTrackCatalog("ac-evo");
  return tracks;
}

export function injectDiscoveredAcEvoTracks(rows: {
  id: string;
  name: string;
  trackName?: string | null;
  trackConfiguration?: string | null;
}[]): void {
  for (const row of rows) {
    const sourceName = row.trackName ?? row.name;
    const configuration = row.trackConfiguration ?? "";
    const track: AcEvoTrack = {
      id: row.id,
      name: sourceName,
      variant: configuration,
      commonTrackName: sourceName,
      setupFolder: "",
    };
    discoveredTracksById.set(row.id, track);
    if (row.trackName === null || row.trackConfiguration === null) continue;
    discoveredTracksBySource.set(acEvoTrackId(sourceName, configuration), track);
  }
}

function asNativeTrack(track: KunosTrack): AcEvoTrack {
  return { ...track, id: acEvoTrackId(track.name, track.variant) };
}

export function getAcEvoTrackName(id: string): string {
  const track = getAcEvoTrackById(id);
  if (!track) return id;
  return `${track.name} - ${track.variant}`;
}

export function getAcEvoSharedTrackName(id: string): string | undefined {
  return getAcEvoTrackById(id)?.commonTrackName;
}

export function getAcEvoTrackById(id: string): AcEvoTrack | undefined {
  const discovered = discoveredTracksById.get(id);
  if (discovered) return discovered;
  const parsed = parseAcEvoTrackId(id);
  return parsed ? getAcEvoTrackByName(parsed.trackName, parsed.trackConfiguration) : undefined;
}
export function getAcEvoTracks(): Map<string, AcEvoTrack> {
  const merged = new Map<string, AcEvoTrack>();
  for (const track of getTracks().values()) {
    const nativeTrack = asNativeTrack(track);
    merged.set(nativeTrack.id, nativeTrack);
  }
  for (const [id, track] of discoveredTracksById) merged.set(id, track);
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

export function getAcEvoTrackByName(trackName: string, config = ""): AcEvoTrack | undefined {
  const key = acEvoTrackId(trackName, config);
  const discovered = discoveredTracksBySource.get(key);
  if (discovered) return discovered;
  const exact = [...getTracks().values()].filter((track) =>
    track.name.trim() === trackName.trim() && track.variant.trim() === config.trim());
  return exact.length === 1 ? asNativeTrack(exact[0]!) : undefined;
}

export function getAcEvoTrackBySetupFolder(key: string): AcEvoTrack | undefined {
  const needle = normalizeKunosCatalogName(key);
  const discovered = [...discoveredTracksById.values()].filter((track) =>
    normalizeKunosCatalogName(track.name) === needle);
  if (discovered.length > 1) return undefined;
  if (discovered.length === 1) return discovered[0];
  for (const track of getTracks().values()) {
    if (track.setupFolder && normalizeKunosCatalogName(track.setupFolder) === needle) return asNativeTrack(track);
  }
  return undefined;
}

export function getAcEvoTrackByLegacyName(trackName: string): AcEvoTrack | undefined {
  const needle = trackName.trim().normalize("NFC").toLowerCase();
  const matches = [...getTracks().values()].filter((track) =>
    track.name.trim().normalize("NFC").toLowerCase() === needle
    || track.commonTrackName.trim().normalize("NFC").toLowerCase() === needle);
  return matches.length === 1 ? asNativeTrack(matches[0]!) : undefined;
}


