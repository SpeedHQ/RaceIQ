// Shared helpers/types for the tune route modules (split from tune-routes.ts).
import { z } from "zod";
import { GameIdSchema } from "../../shared/types";
import type { TuneSettings, RaceStrategy } from "../../shared/types";


export interface CatalogTune {
  id: string;
  name: string;
  author: string;
  carOrdinal: number;
  category: string;
  trackOrdinal?: number;
  description: string;
  strengths: string[];
  weaknesses: string[];
  bestTracks?: string[];
  strategies?: RaceStrategy[];
  settings: TuneSettings;
  source: "community";
  sourceName: string;
  gameId: string;
}


/** Map a community_tunes DB row to the catalog shape the client renders. */
export function communityRowToCatalog(row: {
  id: string;
  gameId: string;
  carOrdinal: number;
  trackOrdinal: number | null;
  name: string;
  author: string;
  category: string;
  description: string;
  sourceName: string;
  settings: string;
}): CatalogTune {
  return {
    id: row.id,
    name: row.name,
    author: row.author,
    carOrdinal: row.carOrdinal,
    category: row.category,
    trackOrdinal: row.trackOrdinal ?? undefined,
    description: row.description,
    strengths: [],
    weaknesses: [],
    settings: JSON.parse(row.settings) as TuneSettings,
    source: "community",
    sourceName: row.sourceName,
    gameId: row.gameId,
  };
}

export const CarOrdinalQuerySchema = z.object({
  gameId: GameIdSchema.optional(),
  carOrdinal: z.coerce.number().int().optional(),
});
