import type { RaceStrategy, TuneSettings } from "@raceiq/shared/racing/tuning/types";

export type { RaceStrategy, TuneSettings } from "@raceiq/shared/racing/tuning/types";

export interface CatalogTune {
  id: string;
  name: string;
  author: string;
  carId: string;
  category: "circuit" | "wet" | "low-drag" | "stable" | "track-specific";
  trackId?: string;
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
