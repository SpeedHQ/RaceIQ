import { formatLapTime } from "@/lib/format";

import { m } from "@/paraglide/messages";
import type { CatalogTune } from "@/data/tune-catalog";
import { parseLapTime } from "./parseLapTime";
import type { TuneRow } from "./types";

export interface RawUserTune {
  id: number;
  name: string;
  author: string;
  category: string;
  carOrdinal: number;
  trackOrdinal: number | null;
  description: string;
  settings: unknown;
  bestLapTime: number | null;
}

function lapFields(description: string) {
  const p = parseLapTime(description);
  return {
    lapTimeSec: p?.seconds ?? null,
    lapTimeRaw: p?.raw ?? null,
    lapTimeTrack: p?.track ?? null,
  };
}

export function buildRows(catalog: CatalogTune[], userTunes: RawUserTune[]): TuneRow[] {
  const cat: TuneRow[] = catalog.map((t) => ({
    key: `community:${t.id}`,
    id: t.id,
    dbId: null,
    name: t.name,
    author: t.author,
    source: "community",
    category: t.category,
    carOrdinal: t.carOrdinal,
    trackOrdinal: t.trackOrdinal ?? null,
    description: t.description ?? "",
    settings: t.settings,
    ...lapFields(t.description ?? ""),
  }));
  const usr: TuneRow[] = userTunes.map((t) => ({
    key: `user:${t.id}`,
    id: `user-${t.id}`,
    dbId: t.id,
    name: t.name,
    author: t.author || m.tune_me(),
    source: "user",
    category: t.category,
    carOrdinal: t.carOrdinal,
    trackOrdinal: t.trackOrdinal ?? null,
    description: t.description ?? "",
    settings: t.settings,
    lapTimeSec: t.bestLapTime != null && t.bestLapTime > 0 ? t.bestLapTime : null,
    lapTimeRaw: t.bestLapTime != null && t.bestLapTime > 0 ? formatLapTime(t.bestLapTime) : null,
    lapTimeTrack: null,
  }));
  return [...cat, ...usr];
}

