import type { LapClassification } from "@raceiq/shared/racing/lap-classification";
export interface TrackLap {
  lapId: number;
  lapNumber: number;
  lapTime: number;
  carId: string;
  carName: string;
  carClass: string;
  pi: number;
  createdAt?: string;
  sessionId?: number | null;
  sectorTimes?: number[] | null;
  isValid?: boolean;
  classification: LapClassification | null;
  invalidReason?: string | null;
  division?: string | null;
  notes?: string | null;
}

export type TrackLapSortKey = "car" | "class" | "type" | "lap" | "time" | "date" | "notes" | number;
