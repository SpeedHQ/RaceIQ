import type { TuneCategory } from "@shared/racing/tuning/types";
import type { TuneSettings } from "@/data/tune-catalog";

// Tune form domain types.
export interface TuneFormData {
  gameId: "fm-2023";
  name: string;
  author: string;
  carOrdinal: number;
  category: TuneCategory;
  description: string;
  settings: TuneSettings;
  unitSystem: "metric" | "imperial";
}
