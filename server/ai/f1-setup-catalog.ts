/**
 * F1 25 setup catalog lookup + comparison.
 *
 * Picks the top-N fastest community setups for a given track (from
 * `shared/tunes/f1-25/f1laps/<track>/`) and optionally diffs them against
 * a current lap's setup.
 *
 * Data is bundled via JSON imports (not `readFileSync`) so the module works
 * identically in the Bun server, the compiled `raceiq.exe`, and the Mastra
 * dev bundle — none of which share a working-directory layout.
 */
import australia from "../../shared/tunes/f1-25/f1laps/australia/setups.json";
import austria from "../../shared/tunes/f1-25/f1laps/austria/setups.json";
import azerbaijan from "../../shared/tunes/f1-25/f1laps/azerbaijan/setups.json";
import bahrain from "../../shared/tunes/f1-25/f1laps/bahrain/setups.json";
import brazil from "../../shared/tunes/f1-25/f1laps/brazil/setups.json";
import canada from "../../shared/tunes/f1-25/f1laps/canada/setups.json";
import china from "../../shared/tunes/f1-25/f1laps/china/setups.json";
import hungary from "../../shared/tunes/f1-25/f1laps/hungary/setups.json";
import imola from "../../shared/tunes/f1-25/f1laps/imola/setups.json";
import japan from "../../shared/tunes/f1-25/f1laps/japan/setups.json";
import lasVegas from "../../shared/tunes/f1-25/f1laps/las_vegas/setups.json";
import mexico from "../../shared/tunes/f1-25/f1laps/mexico/setups.json";
import miami from "../../shared/tunes/f1-25/f1laps/miami/setups.json";
import monaco from "../../shared/tunes/f1-25/f1laps/monaco/setups.json";
import monza from "../../shared/tunes/f1-25/f1laps/monza/setups.json";
import netherlands from "../../shared/tunes/f1-25/f1laps/netherlands/setups.json";
import qatar from "../../shared/tunes/f1-25/f1laps/qatar/setups.json";
import saudiArabia from "../../shared/tunes/f1-25/f1laps/saudi_arabia/setups.json";
import silverstone from "../../shared/tunes/f1-25/f1laps/silverstone/setups.json";
import singapore from "../../shared/tunes/f1-25/f1laps/singapore/setups.json";
import spa from "../../shared/tunes/f1-25/f1laps/spa/setups.json";
import spain from "../../shared/tunes/f1-25/f1laps/spain/setups.json";
import abudhabi from "../../shared/tunes/f1-25/f1laps/abudhabi/setups.json";
import usa from "../../shared/tunes/f1-25/f1laps/usa/setups.json";

export type F1Setup = Record<string, number>;

export interface CatalogEntry {
  team: string;
  author: string;
  lapTime: string;
  lapTimeSeconds: number;
  sessionType: string;
  inputDevice: string;
  weather: string;
  setup: F1Setup;
  source?: string;
  provider?: string;
}

export interface CatalogReference extends CatalogEntry {
  rank: number;
  /** Only fields that differ from `currentSetup`, in `reference - current` form. */
  delta?: Partial<F1Setup>;
}

interface TrackCatalogMeta {
  folder: string;
  displayName: string;
  raw: unknown;
}

/**
 * `trackOrdinal` → catalog metadata. Keys correspond to F1 25 track IDs
 * (see `shared/games/f1-2025/tracks.csv`). Tracks without community data
 * are omitted; tool returns `available: false` for those.
 *
 * Bundled at import time instead of via `getF1TrackInfo()` so this module
 * doesn't pull `readFileSync` into the Mastra tool bundle.
 */
const TRACK_CATALOG: Record<number, TrackCatalogMeta> = {
  0: { folder: "australia", displayName: "Melbourne Grand Prix Circuit", raw: australia },
  2: { folder: "china", displayName: "Shanghai International Circuit", raw: china },
  3: { folder: "bahrain", displayName: "Bahrain International Circuit", raw: bahrain },
  4: { folder: "spain", displayName: "Circuit de Barcelona-Catalunya", raw: spain },
  5: { folder: "monaco", displayName: "Circuit de Monaco", raw: monaco },
  6: { folder: "canada", displayName: "Circuit Gilles Villeneuve", raw: canada },
  7: { folder: "silverstone", displayName: "Silverstone Circuit", raw: silverstone },
  9: { folder: "hungary", displayName: "Hungaroring", raw: hungary },
  10: { folder: "spa", displayName: "Circuit de Spa-Francorchamps", raw: spa },
  11: { folder: "monza", displayName: "Autodromo Nazionale Monza", raw: monza },
  12: { folder: "singapore", displayName: "Marina Bay Street Circuit", raw: singapore },
  13: { folder: "japan", displayName: "Suzuka International Racing Course", raw: japan },
  14: { folder: "abudhabi", displayName: "Yas Marina Circuit", raw: abudhabi },
  15: { folder: "usa", displayName: "Circuit of the Americas", raw: usa },
  16: { folder: "brazil", displayName: "Autodromo Jose Carlos Pace", raw: brazil },
  17: { folder: "austria", displayName: "Red Bull Ring", raw: austria },
  19: { folder: "mexico", displayName: "Autodromo Hermanos Rodriguez", raw: mexico },
  20: { folder: "azerbaijan", displayName: "Baku City Circuit", raw: azerbaijan },
  26: { folder: "netherlands", displayName: "Circuit Zandvoort", raw: netherlands },
  27: { folder: "imola", displayName: "Autodromo Internazionale Enzo e Dino Ferrari", raw: imola },
  29: { folder: "saudi_arabia", displayName: "Jeddah Corniche Circuit", raw: saudiArabia },
  30: { folder: "miami", displayName: "Miami International Autodrome", raw: miami },
  31: { folder: "las_vegas", displayName: "Las Vegas Street Circuit", raw: lasVegas },
  32: { folder: "qatar", displayName: "Lusail International Circuit", raw: qatar },
};

const PACKET_TO_CATALOG_KEY: Record<string, string> = {
  onThrottle: "diffOnThrottle",
  offThrottle: "diffOffThrottle",
};

export function getCatalogFolderForTrack(trackOrdinal: number): string | undefined {
  return TRACK_CATALOG[trackOrdinal]?.folder;
}

export function getCatalogDisplayName(trackOrdinal: number): string | undefined {
  return TRACK_CATALOG[trackOrdinal]?.displayName;
}

/**
 * Remap packet-shape setup keys (`onThrottle`, `offThrottle`) onto the
 * catalog's shape so diffs line up.
 */
export function normalizePacketSetup(setup: Record<string, unknown>): F1Setup {
  const out: F1Setup = {};
  for (const [k, v] of Object.entries(setup)) {
    if (typeof v !== "number") continue;
    const mapped = PACKET_TO_CATALOG_KEY[k] ?? k;
    out[mapped] = v;
  }
  return out;
}

export function parseLapTime(raw: string): number {
  const m = raw.trim().match(/^(\d+):([0-9]+(?:\.[0-9]+)?)$/);
  if (!m) return Number.POSITIVE_INFINITY;
  return parseInt(m[1], 10) * 60 + parseFloat(m[2]);
}

export function loadCatalogEntries(trackOrdinal: number): CatalogEntry[] {
  const meta = TRACK_CATALOG[trackOrdinal];
  if (!meta) return [];
  const raw = meta.raw as Array<Omit<CatalogEntry, "lapTimeSeconds">>;
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => ({ ...e, lapTimeSeconds: parseLapTime(e.lapTime) }));
}

export function topCatalogReferences(
  trackOrdinal: number,
  limit = 5,
  currentSetup?: F1Setup,
): CatalogReference[] {
  const entries = loadCatalogEntries(trackOrdinal);
  entries.sort((a, b) => a.lapTimeSeconds - b.lapTimeSeconds);

  return entries.slice(0, limit).map((e, i) => ({
    ...e,
    rank: i + 1,
    delta: currentSetup ? diffSetups(e.setup, currentSetup) : undefined,
  }));
}

export function diffSetups(reference: F1Setup, current: F1Setup): Partial<F1Setup> {
  const out: Partial<F1Setup> = {};
  for (const key of Object.keys(reference)) {
    const r = reference[key];
    const c = current[key];
    if (typeof r !== "number" || typeof c !== "number") continue;
    if (Math.abs(r - c) < 1e-3) continue;
    out[key] = Math.round((r - c) * 1000) / 1000;
  }
  return out;
}
