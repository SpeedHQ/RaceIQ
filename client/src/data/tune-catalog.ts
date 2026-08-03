import type { RaceStrategy, TuneSettings } from "../../../shared/tuning/types";

export type { RaceStrategy, TuneSettings } from "../../../shared/tuning/types";

export interface CatalogTune {
  id: string;
  name: string;
  author: string;
  carOrdinal: number;
  category: "circuit" | "wet" | "low-drag" | "stable" | "track-specific";
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
