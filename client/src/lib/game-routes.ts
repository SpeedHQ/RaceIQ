import { getAllGames, tryGetGame } from "@shared/games/registry";
import type { GameId } from "../../../shared/games/ids";

export type AnalyseSearch = {
  track?: number;
  car?: number;
  lap?: number;
  cursor?: number;
  viz?: string;
  ai?: number;
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

export type SessionsTab = "recorded" | "imported";
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

export function validateAnalyseSearch(search: Record<string, unknown>): AnalyseSearch {
  return {
    track: parseOptionalNumber(search.track),
    car: parseOptionalNumber(search.car),
    lap: parseOptionalNumber(search.lap),
    cursor: parseOptionalNumber(search.cursor),
    viz: typeof search.viz === "string" ? search.viz : undefined,
    ai: parseOptionalNumber(search.ai),
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
  return { tab: search.tab === "imported" ? "imported" : undefined };
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

export function supportsGameFeature(prefix: string, feature: GameRouteFeature): boolean {
  return ROUTE_FEATURES[feature].includes(prefix);
}
export function setupEngineerGameIdForRoutePrefix(prefix: string): "acc" | "ac-evo" | "f1-2025" | undefined {
  if (!supportsGameFeature(prefix, "experiments")) return undefined;
  return gameIdForRoutePrefix(prefix) as "acc" | "ac-evo" | "f1-2025";
}
