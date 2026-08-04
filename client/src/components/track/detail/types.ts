export interface TrackLap {
  lapId: number;
  lapNumber: number;
  lapTime: number;
  carOrdinal: number;
  carName: string;
  carClass: string;
  pi: number;
  createdAt?: string;
  sessionId?: number | null;
  sectorTimes?: number[] | null;
  isValid?: boolean;
  invalidReason?: string | null;
  division?: string | null;
  notes?: string | null;
}
