import { parseOptionalIdentityKey, parseOptionalNumber } from "@raceiq/frontend-pure/route-search";

export type TuneReviewTrackTab = "consistency" | "braking" | "throttle" | "dynamics" | "fuel" | "suspension";

export type AnalyseSearch = {
  session?: number;
  track?: string;
  car?: string;
  lap?: number;
  laps?: string;
  primary?: number;
  cursor?: number;
  viz?: string;
  ai?: number;
  view?: string;
  tab?: TuneReviewTrackTab;
};

/** Parse canonical comparison lap IDs; malformed lists remain distinguishable from absence. */
export function parseAnalyseLapIds(value: string | undefined): number[] | null | undefined {
  if (value == null) return undefined;
  const parts = value.split(",");
  if (parts.length === 0 || parts.some((part) => part.trim() === "")) return null;
  const ids = parts.map((part) => Number(part));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0) || new Set(ids).size !== ids.length) return null;
  return ids;
}

export function validateAnalyseSearch(search: Record<string, unknown>): AnalyseSearch {
  const requestedTab = search.tab ?? search.trackTab;
  const tab = requestedTab === "consistency" || requestedTab === "braking" || requestedTab === "throttle" || requestedTab === "dynamics" || requestedTab === "fuel" || requestedTab === "suspension" ? requestedTab : undefined;
  return {
    session: parseOptionalNumber(search.session),
    track: parseOptionalIdentityKey(search.track),
    car: parseOptionalIdentityKey(search.car),
    lap: parseOptionalNumber(search.lap),
    laps: typeof search.laps === "string" ? search.laps : undefined,
    primary: parseOptionalNumber(search.primary),
    cursor: parseOptionalNumber(search.cursor),
    viz: typeof search.viz === "string" ? search.viz : undefined,
    ai: parseOptionalNumber(search.ai),
    view: typeof search.view === "string" ? search.view : undefined,
    tab,
  };
}
