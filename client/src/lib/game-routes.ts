import type { GameId } from "@shared/games/ids";
import { getAllGames, tryGetGame } from "@shared/games/registry";
import type { ReleaseFeatureFlags } from "@shared/platform/runtime/release-feature-flags";
import { clientReleaseFeatures } from "./release-features";

export type AnalyseSearch = {
  track?: number;
  car?: number;
  lap?: number;
  laps?: string;
  cursor?: number;
  viz?: string;
  ai?: number;
  view?: string;
};
export type CompareSearch = {
  track?: number;
  carA?: number;
  carB?: number;
  lapA?: number;
  lapB?: number;
  cursor?: number;
  ai?: number;
};

export type SessionsTab = "mine" | "others";
export type SessionsSearch = { tab?: SessionsTab };
export type TuneView = "overview" | `s${number}`;
export type TuneSearch = {
  session?: number | "live";
  lap?: number;
  view?: TuneView;
};

export type TuneReviewView = "overview" | "track" | `s${number}`;
export type TuneReviewSearch = {
  laps?: string;
  lap?: number;
  view?: TuneReviewView;
  versionId?: number;
};

export type GameRouteFeature = "driver" | "experiments" | "raw" | "setups";

export type LiveDashboard = "forza" | "f1" | "acc";
const ROUTE_FEATURES: Record<GameRouteFeature, readonly string[]> = {
  driver: ["fm23", "f125", "acc", "ac-evo"],
  experiments: ["f125", "acc", "ac-evo"],
  raw: ["fm23", "f125", "acc", "ac-evo", "iracing"],
  setups: ["fm23", "f125", "acc", "ac-evo"],
};

export function gameIdForRoutePrefix(prefix: string): GameId | undefined {
  return getAllGames().find((game) => game.routePrefix === prefix)?.id;
}

/** Select the existing dashboard implementation for a registered game. */
export function liveDashboardForGame(gameId: GameId): LiveDashboard {
  switch (gameId) {
    case "fm-2023":
      return "forza";
    case "f1-2025":
      return "f1";
    case "acc":
    case "ac-evo":
      return "acc";
    default:
      throw new Error(`Unsupported live dashboard game: ${gameId}`);
  }
}

export function routePrefixForGameId(gameId: string): string | undefined {
  return tryGetGame(gameId)?.routePrefix;
}

export function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Parse the canonical comparison lap list without silently accepting malformed IDs. */
export function parseAnalyseLapIds(value: string | undefined): number[] | null | undefined {
  if (value == null) return undefined;
  const parts = value.split(",");
  if (parts.length === 0 || parts.some((part) => part.trim() === "")) return null;
  const ids = parts.map((part) => Number(part));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0) || new Set(ids).size !== ids.length) return null;
  return ids;
}


export function validateAnalyseSearch(search: Record<string, unknown>): AnalyseSearch {
  return {
    track: parseOptionalNumber(search.track),
    car: parseOptionalNumber(search.car),
    lap: parseOptionalNumber(search.lap),
    laps: typeof search.laps === "string" ? search.laps : undefined,
    cursor: parseOptionalNumber(search.cursor),
    viz: typeof search.viz === "string" ? search.viz : undefined,
    ai: parseOptionalNumber(search.ai),
    view: typeof search.view === "string" ? search.view : undefined,
  };
}

export function validateCompareSearch(search: Record<string, unknown>): CompareSearch {
  return {
    track: parseOptionalNumber(search.track),
    carA: parseOptionalNumber(search.carA),
    carB: parseOptionalNumber(search.carB),
    lapA: parseOptionalNumber(search.lapA),
    lapB: parseOptionalNumber(search.lapB),
    cursor: parseOptionalNumber(search.cursor),
    ai: parseOptionalNumber(search.ai),
  };
}

export function validateSessionsSearch(search: Record<string, unknown>): SessionsSearch {
  const tab = search.tab === "others" || search.tab === "mine" ? search.tab : search.tab === "recorded" || search.tab === "imported" ? "mine" : undefined;
  return { tab };
}

export function validateTuneSearch(search: Record<string, unknown>): TuneSearch {
  const view = search.view === "overview" || (typeof search.view === "string" && /^s[1-9]\d*$/.test(search.view)) ? search.view : undefined;
  return {
    session: search.session === "live" ? "live" : parseOptionalNumber(search.session),
    lap: parseOptionalNumber(search.lap),
    view: view as TuneView | undefined,
  };
}

export function validateTuneReviewSearch(search: Record<string, unknown>): TuneReviewSearch {
  const view = search.view === "overview" || search.view === "track" || (typeof search.view === "string" && /^s[1-9]\d*$/.test(search.view)) ? search.view : undefined;
  return {
    laps: typeof search.laps === "string" ? search.laps : undefined,
    lap: parseOptionalNumber(search.lap),
    view: view as TuneReviewView | undefined,
    versionId: parseOptionalNumber(search.versionId),
  };
}

export function supportsGameFeature(prefix: string, feature: GameRouteFeature, flags: ReleaseFeatureFlags = clientReleaseFeatures): boolean {
  if (prefix === "f125" && feature === "experiments" && !flags.f1Experiments) return false;
  return ROUTE_FEATURES[feature].includes(prefix);
}
export function setupEngineerGameIdForRoutePrefix(prefix: string, flags: ReleaseFeatureFlags = clientReleaseFeatures): "acc" | "ac-evo" | "f1-2025" | undefined {
  if (!supportsGameFeature(prefix, "experiments", flags)) return undefined;
  return gameIdForRoutePrefix(prefix) as "acc" | "ac-evo" | "f1-2025";
}
