import type {
  RaceEvent,
  RaceEventId,
  RaceEventPayloadMap,
  RaceEventType,
} from "../../shared/racing/events/contracts";
import type { EvidenceSourceKind } from "../../shared/racing/quality/contracts";
import type { SourceSequenceBoundary } from "../../shared/telemetry/source-sequence";
import type {
  RaceEventObservation,
  RaceParticipantObservation,
} from "../games/types";
import type { SessionBoundaryReason } from "../lap-detection/boundaries";

export const EVENT_ORDER_PRIORITY = {
  sourceQuality: 0,
  sessionRaceControl: 10,
  participant: 20,
  driver: 30,
  lap: 40,
  pitVisit: 50,
  pitService: 60,
  incidentDamagePenaltyReset: 70,
} as const;

export type RaceEventOrderPriority =
  (typeof EVENT_ORDER_PRIORITY)[keyof typeof EVENT_ORDER_PRIORITY];

export interface DetectorEventDraft<Type extends RaceEventType = RaceEventType> {
  eventType: Type;
  payload: RaceEventPayloadMap[Type];
  detectorId: string;
  detectorVersion: string;
  priority: RaceEventOrderPriority;
  /** Epoch-transition/reset drafts use sequence 0. */
  sequence?: number;
  /** Stable detector-owned boundary component, never wall-clock receipt time. */
  boundaryKey: string;
  stableSortKey?: string;
  participant?: RaceParticipantObservation | null;
  participantId?: string | null;
  participantKind?: RaceEvent["participantKind"];
  driverId?: string | null;
  teamId?: string | null;
  lapNumber?: number | null;
  lapId?: number | null;
  sourceTimeMs?: number | null;
  sourceEndTimeMs?: number | null;
  sourceSequenceFamily?: string | null;
  sourceSequence?: number | null;
  trackDistanceM?: number | null;
  trackDistancePct?: number | null;
  worldPosition?: RaceEvent["worldPosition"];
  evidenceKind: RaceEvent["evidenceKind"];
  confidence: RaceEvent["confidence"];
  qualityState: RaceEvent["qualityState"];
  lifecycleId?: string | null;
  linkedEventId?: RaceEventId | null;
}

export interface DetectorContext {
  sessionId: number;
  timelineEpoch: number;
  sequence: number;
  sourceKind: EvidenceSourceKind;
  observation: RaceEventObservation;
  boundaryKey: string;
  seed: boolean;
}

export interface RaceEventPreflightEvidence {
  /** Explicit source reconnect wins before native sequence comparison. */
  reconnect?: boolean;
  replaySeek?: boolean;
  timebaseReset?: boolean;
  lapReset?: boolean;
  sessionBoundaryReason?: SessionBoundaryReason | null;
  resetReason?: string | null;
  sourceSequenceBoundaries?: readonly SourceSequenceBoundary[];
}

export interface RaceEventPreflightResult {
  accepted: boolean;
  observation: RaceEventObservation;
  timelineEpoch: number;
  sequence: number;
  boundaryKey: string;
  seed: boolean;
  reset: boolean;
  qualityDrafts: DetectorEventDraft[];
  reason: "accepted" | "duplicate" | "out-of-order" | "ambiguous-coordinate";
}

export interface RaceEventProcessingResult {
  accepted: boolean;
  events: RaceEvent[];
  rejectedDrafts: Array<{ eventType: RaceEventType; error: string }>;
  timelineEpoch: number;
  sequence: number;
  reason: RaceEventPreflightResult["reason"];
}

export interface RaceEventSessionBinding {
  reason: SessionBoundaryReason;
  observation: RaceEventObservation;
}

export interface RaceEventLapEvaluation {
  lapNumber: number;
  lapTimeMs: number | null;
  isValid: boolean;
  phase: RaceEventPayloadMap["lap_completed"]["phase"];
  conditions: RaceEventPayloadMap["lap_completed"]["conditions"];
  invalidReason: string | null;
  sectors?: readonly number[] | null;
  position?: number | null;
  participantId?: string | null;
  rawBoundaryOffset?: number | null;
  rawBoundaryOrdinal?: number | null;
}
