import type { LapCondition, LapPhase, PaceEligibility } from "@shared/racing/laps/classification";
import type { EligibilityDecisionSet, EvidenceSourceKind, LapQualitySummary } from "@shared/racing/quality/contracts";

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
  phase: LapPhase;
  conditions: LapCondition[];
  paceEligibility: PaceEligibility;
  eligibility?: EligibilityDecisionSet;
  quality?: LapQualitySummary;
  qualityGeneration?: string;
  source?: EvidenceSourceKind;
  invalidReason?: string | null;
  division?: string | null;
  notes?: string | null;
}
