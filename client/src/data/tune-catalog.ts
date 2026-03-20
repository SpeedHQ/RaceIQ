import carsJson from "@shared/tunes/cars.json";

// Import all tune JSON files
import balancedCircuit from "@shared/tunes/2860-amv-gt3-balanced-circuit.json";
import aggressiveCircuit from "@shared/tunes/2860-amv-gt3-aggressive-circuit.json";
import wetWeather from "@shared/tunes/2860-amv-gt3-wet-weather.json";
import topSpeed from "@shared/tunes/2860-amv-gt3-top-speed.json";
import stableBeginner from "@shared/tunes/2860-amv-gt3-stable-beginner.json";
import nordschleife from "@shared/tunes/2860-amv-gt3-nordschleife.json";
import spa from "@shared/tunes/2860-amv-gt3-spa.json";

import type { TuneSettings, RaceStrategy } from "@shared/types";
export type { TuneSettings, RaceStrategy } from "@shared/types";

export interface CatalogCar {
  ordinal: number;
  name: string;
  class: string;
  pi: number;
  stockSpec: true;
}

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
}

export const CATALOG_CARS: CatalogCar[] = carsJson as CatalogCar[];

export const TUNE_CATALOG: CatalogTune[] = [
  balancedCircuit,
  aggressiveCircuit,
  wetWeather,
  topSpeed,
  stableBeginner,
  nordschleife,
  spa,
] as CatalogTune[];

export function getTunesByCar(carOrdinal: number): CatalogTune[] {
  return TUNE_CATALOG.filter((t) => t.carOrdinal === carOrdinal);
}

export function getTuneById(id: string): CatalogTune | undefined {
  return TUNE_CATALOG.find((t) => t.id === id);
}

export function getCatalogCar(ordinal: number): CatalogCar | undefined {
  return CATALOG_CARS.find((c) => c.ordinal === ordinal);
}
