import { z } from "zod";
import { GameIdSchema } from "../../shared/games/ids";
import type { GameId } from "../../shared/games/ids";
import type { RaceStrategy, TuneSettings } from "../../shared/tuning/types";


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

interface ParsedTune {
  id: number;
  gameId: string;
  name: string;
  author: string;
  carOrdinal: number;
  category: string;
  description: string;
  settings: Record<string, unknown> | null;
  strengths: string[];
  weaknesses: string[];
  bestTracks: string[];
  strategies: unknown[];
  unitSystem: string;
  source: string;
  catalogId: string | null;
  trackOrdinal: number | null;
  createdAt: string;
  lapId: number | null;
}

/** Parse JSON text columns from a DB tune row into proper arrays/objects. */
export function parseTuneRow(row: any): ParsedTune {
  return {
    ...row,
    strengths: row.strengths ? JSON.parse(row.strengths) : [],
    weaknesses: row.weaknesses ? JSON.parse(row.weaknesses) : [],
    bestTracks: row.bestTracks ? JSON.parse(row.bestTracks) : [],
    strategies: row.strategies ? JSON.parse(row.strategies) : [],
    settings: row.settings ? JSON.parse(row.settings) : null,
  };
}

/** Reduce one user-supplied name to a single safe path segment. */
export function sanitisePathSegment(s: string): string {
  return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim();
}

/** Forza's TuneSettings has a specific shape that the built-in Forza UI expects.
 *  ACC / AC-EVO / F1 save raw game-specific JSON blobs instead, so validation
 *  is skipped for those games — any object shape is accepted. */
export function validateForzaTuneSettings(settings: any): boolean {
  if (!settings || typeof settings !== "object") return false;
  const required = [
    "tires", "gearing", "alignment", "antiRollBars", "springs",
    "damping", "aero", "differential", "brakes",
  ];
  for (const key of required) {
    if (!settings[key] || typeof settings[key] !== "object") return false;
  }
  if (
    typeof settings.tires.frontPressure !== "number" ||
    typeof settings.tires.rearPressure !== "number"
  ) return false;
  if (typeof settings.gearing.finalDrive !== "number") return false;
  if (
    typeof settings.brakes.balance !== "number" ||
    typeof settings.brakes.pressure !== "number"
  ) return false;
  return true;
}

export function validateSettingsForGame(gameId: GameId, settings: any): boolean {
  if (gameId === "fm-2023") return validateForzaTuneSettings(settings);
  return settings != null && typeof settings === "object";
}

/**
 * Map a community_tunes DB row to the catalog shape the client renders. JSON
 * settings are parsed immediately so callers can render them consistently.
 */
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
