export type SourceKey = "community" | "user";

export interface TuneRow {
  key: string;
  id: string;
  dbId: number | null;
  name: string;
  author: string;
  source: SourceKey;
  category: string;
  carOrdinal: number;
  trackOrdinal: number | null;
  lapTimeSec: number | null;
  lapTimeRaw: string | null;
  lapTimeTrack: string | null;
  description: string;
  settings: unknown;
}

export interface SourceTab {
  key: "all" | SourceKey;
  label: string;
}
