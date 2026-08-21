import {
  RACE_EVENT_SCHEMA_VERSION,
  RaceEventDraftSchema,
  RaceEventSchema,
  type RaceEvent,
  type RaceEventDraft,
  type RaceEventId,
  type RaceEventPayloadMap,
  type RaceEventType,
} from "../../shared/racing/events/contracts";
import { classifyLap, type LapCondition, type LapTimelineClassificationContext } from "../../shared/racing/laps/classification";
import type { EvidenceSourceKind, SourceLifecycleEvidence } from "../../shared/racing/quality/contracts";
import type { SourceSequenceFinalized, SourceSequenceGapBoundary } from "../../shared/telemetry/source-sequence";
import type { RaceEventObservation } from "../games/types";
import type { SessionEndReason } from "../lap-detection/types";
import { IncidentPenaltyDetector } from "./detectors/incident-penalty";
import { LapEventDetector } from "./detectors/lap";
import { ParticipantDriverDetector } from "./detectors/participant-driver";
import { PitServiceDetector } from "./detectors/pit-service";
import { SessionRaceControlDetector } from "./detectors/session-race-control";
import { SourceQualityDetector, type SourceGapTimelineAnchor } from "./detectors/source-quality";
import { materializeRaceEvent, nativeCoordinateKey, observationBoundaryKey, observationContentHash, raceEventId, raceEventLifecycleId } from "./identity";
import { RaceEventConflictError, compareRaceEvents } from "./ordering";
import {
  EVENT_ORDER_PRIORITY,
  type DetectorContext,
  type DetectorEventDraft,
  type RaceEventLapEvaluation,
  type RaceEventPreflightEvidence,
  type RaceEventPreflightResult,
  type RaceEventProcessingResult,
  type RaceEventSessionBinding,
} from "./types";

interface LapContextState {
  conditions: Set<LapCondition>;
  gridStart: boolean;
  pitStart: "out" | "pit-lane" | "pit-stall" | "unknown" | null;
  pitEnd: "out" | "pit-lane" | "pit-stall" | "unknown" | null;
  pitEntry: boolean;
  pitExit: boolean;
  eventIds: RaceEventId[];
}

type LifecycleKind = "caution" | "damage-warning" | "penalty" | "source-stale" | "source-connection";

interface LifecycleAssignment {
  key: string;
  role: "open" | "close";
  openingEventType: RaceEventType;
}

interface ActiveLifecycle {
  lifecycleId: string;
  openingEventId: RaceEventId;
  participantId: string | null;
}

interface PitLifecycleOpening {
  openingEventId: RaceEventId;
  participantId: string | null;
}


interface NativeSequenceRollback {
  family: string;
  sequence: number | null;
}

interface GapAnchorRollback {
  key: string;
  anchor: SourceGapTimelineAnchor | undefined;
}

export interface RaceEventCoordinatorOptions {
  sessionId?: number;
  sourceKind?: EvidenceSourceKind;
  sourceGeneration?: string | null;
  analysisGenerationId?: string | null;
  createdAt?: (receivedAtMs: number) => string;
  validationMode?: "live" | "rebuild";
}


function pitServiceSubOrder(eventType: RaceEventType): number | null {
  if (eventType === "pit_service_started") return 0;
  if (
    eventType === "fuel_service_observed" ||
    eventType === "tire_service_observed" ||
    eventType === "repair_service_observed" ||
    eventType === "driver_service_observed"
  ) {
    return 1;
  }
  return eventType === "pit_service_completed" ? 2 : null;
}

function eventOrderPriority(draft: DetectorEventDraft): number {
  switch (draft.eventType) {
    case "pit_entry":
    case "pit_stall_arrival":
      return 50;
    case "pit_service_started":
      return 55;
    case "fuel_service_observed":
    case "tire_service_observed":
    case "repair_service_observed":
    case "driver_service_observed":
      return 56;
    case "pit_service_completed":
    case "drive_through_observed":
    case "pit_visit_incomplete":
      return 57;
    case "pit_stall_departure":
      return 58;
    case "pit_exit":
      return 59;
    default:
      return draft.priority;
  }
}
export interface RaceEventSessionEndInput {
  reason: SessionEndReason;
  terminalObserved: boolean;
}

const SESSION_ROTATION_REASONS = new Set<SessionEndReason>(["session-uid-changed", "lap-number-reset", "distance-reset", "car-changed", "track-changed", "silence-timeout", "session-rotated"]);

const defaultCreatedAt = (receivedAtMs: number): string =>
  new Date(receivedAtMs).toISOString();
const TIRE_CORNERS = ["fl", "fr", "rl", "rr"] as const;

/**
 * One deterministic authority for event preflight, focused detector state,
 * semantic IDs/hashes, and lap timeline context. Persistence/publication stay
 * behind caller-owned ports so commit always precedes notification.
 */
export class RaceEventCoordinator {
  private readonly sourceKind: EvidenceSourceKind;
  private readonly sourceGeneration: string | null;
  private readonly analysisGenerationId: string | null;
  private readonly createdAt: (receivedAtMs: number) => string;
  private readonly validationMode: "live" | "rebuild";
  private sessionId: number | null;
  private sessionStarted = false;
  private pendingSessionStartReason = "no-session";
  private timelineEpoch = 0;
  private sequence = 0;
  private seedNextObservation = true;
  private reconnectEpochPending = false;
  private lastSourceTimeMs: number | null = null;
  private lastGameId: RaceEventObservation["gameId"] | null = null;
  private lastSessionUid: string | null = null;
  private readonly lastNativeSequence = new Map<string, number>();
  private lastCoordinateKey: string | null = null;

  private lastAccepted: RaceEventPreflightResult | null = null;
  private lastObservation: RaceEventObservation | null = null;
  private readonly emittedById = new Map<RaceEventId, RaceEvent>();
  private readonly lapContexts = new Map<number, LapContextState>();
  private readonly activeLifecycles = new Map<string, ActiveLifecycle>();
  private readonly pitLifecycleOpenings = new Map<string, PitLifecycleOpening>();
  /** Only tracker-marked gap candidates retain cross-epoch projection anchors. */
  private readonly gapAnchors = new Map<string, SourceGapTimelineAnchor>();
  private rollbackPreflight: RaceEventPreflightResult | null = null;
  private rollbackTimelineEpoch = 0;
  private rollbackSequence = 0;
  private rollbackSeedNextObservation = false;
  private rollbackReconnectEpochPending = false;
  private rollbackLastSourceTimeMs: number | null = null;
  private rollbackLastGameId: RaceEventObservation["gameId"] | null = null;
  private rollbackLastSessionUid: string | null = null;
  private rollbackLastCoordinateKey: string | null = null;
  private rollbackLastAccepted: RaceEventPreflightResult | null = null;
  private rollbackLastObservation: RaceEventObservation | null = null;
  private readonly rollbackNativeSequences: NativeSequenceRollback[] = [];
  private rollbackNativeSequenceCount = 0;
  private readonly rollbackGapAnchors: GapAnchorRollback[] = [];
  private rollbackGapAnchorCount = 0;

  private readonly sourceQuality = new SourceQualityDetector();
  private readonly raceControl = new SessionRaceControlDetector();
  private readonly participants = new ParticipantDriverDetector();
  private readonly laps = new LapEventDetector();
  private readonly pits = new PitServiceDetector();
  private readonly incidents = new IncidentPenaltyDetector();

  constructor(options: RaceEventCoordinatorOptions = {}) {
    this.sessionId = options.sessionId ?? null;
    this.sourceKind = options.sourceKind ?? "native-live";
    this.sourceGeneration = options.sourceGeneration ?? null;
    this.analysisGenerationId = options.analysisGenerationId ?? null;
    this.createdAt = options.createdAt ?? defaultCreatedAt;
    this.validationMode = options.validationMode ?? "live";
  }

  /** Bind the coordinator after the lap detector creates the real DB session. */
  bindSession(sessionId: number, binding?: RaceEventSessionBinding): void {
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
      throw new RangeError("Race-event session ID must be a positive integer");
    }
    if (this.sessionId !== sessionId) {
      const pending = this.lastAccepted;
      this.sessionId = sessionId;
      this.resetForSession();
      if (pending?.accepted) {
        pending.timelineEpoch = 0;
        pending.sequence = 1;
        pending.seed = true;
        pending.reset = false;
        pending.qualityDrafts = [];
        this.sequence = 1;
        this.lastAccepted = pending;
        this.lastObservation = pending.observation;
        this.lastSourceTimeMs = pending.observation.sourceTimeMs;
        this.lastGameId = pending.observation.gameId;
        this.lastSessionUid = pending.observation.sessionUid;
        this.lastCoordinateKey = nativeCoordinateKey(pending.observation);
        for (const source of pending.observation.sourceSequences) {
          this.lastNativeSequence.set(source.family, source.sequence);
        }
      }
    }
    if (binding) this.pendingSessionStartReason = binding.reason;
    if (binding && this.lastAccepted == null) {
      const boundaryKey = observationBoundaryKey(binding.observation, 1);
      this.lastAccepted = {
        accepted: true,
        observation: binding.observation,
        timelineEpoch: this.timelineEpoch,
        sequence: Math.max(1, this.sequence),
        boundaryKey,
        seed: true,
        reset: false,
        qualityDrafts: [],
        reason: "accepted",
      };
      this.lastObservation = binding.observation;
    }
  }

  preflight(observation: RaceEventObservation, evidence: RaceEventPreflightEvidence = {}): RaceEventPreflightResult {
    this.assertValidObservation(observation);
    if (this.validationMode === "rebuild" || this.createdAt !== defaultCreatedAt) {
      assertValidCreatedAt(this.createdAt(observation.receivedAtMs));
    }

    this.beginPreflightRollback();
    const resetReason = this.resetReason(observation, evidence);
    const reset = resetReason != null;
    if (reset) this.captureAllNativeSequenceRollback();
    const resetDrafts: DetectorEventDraft[] = [];
    if (reset) {
      this.beginEpoch(resetReason, observation, false);
      if (this.sessionId != null) {
        resetDrafts.push(...this.resetDrafts(observation, resetReason));
      }
    }

    const coordinateKey = nativeCoordinateKey(observation);
    const sameCoordinate = coordinateKey != null && coordinateKey === this.lastCoordinateKey && this.lastObservation != null;
    if (sameCoordinate && !reset) {
      const previousSequence = this.lastAccepted?.sequence ?? this.sequence;
      if (observationContentHash(this.lastObservation!) === observationContentHash(observation)) {
        const context = this.contextForRejected(observation, previousSequence, coordinateKey);
        const boundaries = evidence.sourceSequenceBoundaries?.filter(({ kind }) => kind === "duplicate") ?? [this.syntheticBoundary(observation, "duplicate")];
        const result: RaceEventPreflightResult = {
          accepted: false,
          observation,
          timelineEpoch: this.timelineEpoch,
          sequence: previousSequence,
          boundaryKey: coordinateKey,
          seed: false,
          reset: false,
          qualityDrafts: this.sourceQuality.boundaries(context, boundaries),
          reason: "duplicate",
        };
        this.lastAccepted = result;
        return result;
      }
      if (observation.sourceSequences.length > 0) {
        const result: RaceEventPreflightResult = {
          accepted: false,
          observation,
          timelineEpoch: this.timelineEpoch,
          sequence: previousSequence,
          boundaryKey: coordinateKey,
          seed: false,
          reset: false,
          qualityDrafts: [this.ambiguousCoordinateDraft(observation, coordinateKey)],
          reason: "ambiguous-coordinate",
        };
        this.lastAccepted = result;
        return result;
      }
    }

    if (!reset && this.isNativeOutOfOrder(observation)) {
      const boundaryKey = coordinateKey ?? observationBoundaryKey(observation, this.sequence + 1);
      const context = this.contextForRejected(observation, this.sequence, boundaryKey);
      const boundaries = evidence.sourceSequenceBoundaries?.filter(({ kind }) => kind === "out-of-order") ?? [this.syntheticBoundary(observation, "out-of-order")];
      const result: RaceEventPreflightResult = {
        accepted: false,
        observation,
        timelineEpoch: this.timelineEpoch,
        sequence: this.sequence,
        boundaryKey,
        seed: false,
        reset: false,
        qualityDrafts: this.sourceQuality.boundaries(context, boundaries),
        reason: "out-of-order",
      };
      this.lastAccepted = result;
      return result;
    }

    if (evidence.sourceSequenceGapCandidates != null) {
      const anchor: SourceGapTimelineAnchor = {
        timelineEpoch: this.timelineEpoch,
        sequence: this.sequence + 1,
        lapNumber: observation.lapNumber,
        trackDistanceM: observation.trackDistanceM,
        trackDistancePct: observation.trackDistancePct,
        worldPosition: observation.worldPosition,
      };
      for (const candidate of evidence.sourceSequenceGapCandidates) {
        const key = sourceGapAnchorKey(candidate);
        this.captureGapAnchorRollback(key);
        this.gapAnchors.set(key, anchor);
      }
    }

    this.sequence += 1;
    const boundaryKey = observationBoundaryKey(observation, this.sequence);
    this.lastCoordinateKey = coordinateKey;
    for (const source of observation.sourceSequences) {
      this.captureNativeSequenceRollback(source.family);
      this.lastNativeSequence.set(source.family, source.sequence);
    }
    this.lastSourceTimeMs = observation.sourceTimeMs;
    this.lastGameId = observation.gameId;
    this.lastSessionUid = observation.sessionUid;
    this.lastObservation = observation;
    const result: RaceEventPreflightResult = {
      accepted: true,
      observation,
      timelineEpoch: this.timelineEpoch,
      sequence: this.sequence,
      boundaryKey,
      seed: this.seedNextObservation,
      reset,
      qualityDrafts: resetDrafts,
      reason: "accepted",
    };
    this.reconnectEpochPending = false;
    this.seedNextObservation = false;
    this.lastAccepted = result;
    this.rollbackPreflight = result;
    return result;
  }

  /** Abandon an accepted preflight when upstream detector work fails. */
  abortPreflight(preflight: RaceEventPreflightResult): void {
    if (preflight !== this.rollbackPreflight) {
      throw new Error("Race-event preflight is no longer abortable");
    }
    this.timelineEpoch = this.rollbackTimelineEpoch;
    this.sequence = this.rollbackSequence;
    this.seedNextObservation = this.rollbackSeedNextObservation;
    this.reconnectEpochPending = this.rollbackReconnectEpochPending;
    this.lastSourceTimeMs = this.rollbackLastSourceTimeMs;
    this.lastGameId = this.rollbackLastGameId;
    this.lastSessionUid = this.rollbackLastSessionUid;
    this.lastCoordinateKey = this.rollbackLastCoordinateKey;
    this.lastAccepted = this.rollbackLastAccepted;
    this.lastObservation = this.rollbackLastObservation;
    for (let index = this.rollbackNativeSequenceCount - 1; index >= 0; index -= 1) {
      const rollback = this.rollbackNativeSequences[index]!;
      if (rollback.sequence == null) this.lastNativeSequence.delete(rollback.family);
      else this.lastNativeSequence.set(rollback.family, rollback.sequence);
    }
    for (let index = this.rollbackGapAnchorCount - 1; index >= 0; index -= 1) {
      const rollback = this.rollbackGapAnchors[index]!;
      if (rollback.anchor == null) this.gapAnchors.delete(rollback.key);
      else this.gapAnchors.set(rollback.key, rollback.anchor);
    }
    this.rollbackPreflight = null;
  }

  private beginPreflightRollback(): void {
    this.rollbackPreflight = null;
    this.rollbackTimelineEpoch = this.timelineEpoch;
    this.rollbackSequence = this.sequence;
    this.rollbackSeedNextObservation = this.seedNextObservation;
    this.rollbackReconnectEpochPending = this.reconnectEpochPending;
    this.rollbackLastSourceTimeMs = this.lastSourceTimeMs;
    this.rollbackLastGameId = this.lastGameId;
    this.rollbackLastSessionUid = this.lastSessionUid;
    this.rollbackLastCoordinateKey = this.lastCoordinateKey;
    this.rollbackLastAccepted = this.lastAccepted;
    this.rollbackLastObservation = this.lastObservation;
    this.rollbackNativeSequenceCount = 0;
    this.rollbackGapAnchorCount = 0;
  }

  private captureAllNativeSequenceRollback(): void {
    for (const [family, sequence] of this.lastNativeSequence) {
      this.captureNativeSequenceRollback(family, sequence);
    }
  }

  private captureNativeSequenceRollback(family: string, sequence = this.lastNativeSequence.get(family) ?? null): void {
    for (let index = 0; index < this.rollbackNativeSequenceCount; index += 1) {
      if (this.rollbackNativeSequences[index]!.family === family) return;
    }
    const rollback = this.rollbackNativeSequences[this.rollbackNativeSequenceCount++] ?? { family, sequence };
    rollback.family = family;
    rollback.sequence = sequence;
    this.rollbackNativeSequences[this.rollbackNativeSequenceCount - 1] = rollback;
  }

  private captureGapAnchorRollback(key: string): void {
    for (let index = 0; index < this.rollbackGapAnchorCount; index += 1) {
      if (this.rollbackGapAnchors[index]!.key === key) return;
    }
    const rollback = this.rollbackGapAnchors[this.rollbackGapAnchorCount++] ?? {
      key,
      anchor: this.gapAnchors.get(key),
    };
    rollback.key = key;
    rollback.anchor = this.gapAnchors.get(key);
    this.rollbackGapAnchors[this.rollbackGapAnchorCount - 1] = rollback;
  }

  processObservation(sessionId: number, observation: RaceEventObservation, evidence: RaceEventPreflightEvidence = {}): RaceEventProcessingResult {
    this.bindSession(sessionId);
    return this.processPreflight(this.preflight(observation, evidence));
  }

  processPreflight(preflight: RaceEventPreflightResult): RaceEventProcessingResult {
    if (preflight.accepted && preflight.reset) {
      this.resetEpochDetectors();
    }
    if (this.sessionId == null) {
      const result = {
        accepted: preflight.accepted,
        events: [],
        rejectedDrafts: [],
        timelineEpoch: preflight.timelineEpoch,
        sequence: preflight.sequence,
        reason: preflight.reason,
      };
      if (preflight === this.rollbackPreflight) this.rollbackPreflight = null;
      return result;
    }

    const context = this.context(preflight);
    const drafts = [...preflight.qualityDrafts];
    if (preflight.accepted) {
      if (!this.sessionStarted) {
        drafts.push(...this.sourceQuality.bind(context));
        drafts.push(...this.raceControl.startSession(context, this.pendingSessionStartReason));
        this.sessionStarted = true;
      } else {
        drafts.push(...this.raceControl.observe(context));
      }
      const participantResult = this.participants.observe(context);
      drafts.push(...participantResult.drafts);
      for (const participantId of participantResult.unavailableParticipantIds) {
        this.pits.clearParticipant(participantId);
        this.incidents.clearParticipant(participantId);
        this.clearParticipantLifecycles(participantId);
      }

      this.noteObservationLapContext(context);
      drafts.push(...this.laps.observe(context, this.classificationForLap(this.sessionId, preflight.observation.lapNumber ?? 0)));
      const pitDrafts = this.pits.observe(context);
      drafts.push(...pitDrafts);
      this.projectPitDrafts(pitDrafts);
      drafts.push(...this.incidents.observe(context));
    }
    const result = this.materializeResult(preflight, drafts);
    if (preflight === this.rollbackPreflight) this.rollbackPreflight = null;
    return result;
  }

  noteLapEvaluated(input: RaceEventLapEvaluation): RaceEvent[] {
    if (
      !Number.isSafeInteger(input.lapNumber) ||
      input.lapNumber < 0 ||
      (input.lapTimeMs != null && (!Number.isFinite(input.lapTimeMs) || input.lapTimeMs < 0))
    ) {
      throw new RangeError("Race-event lap evaluation is out of range");
    }
    const preflight = this.requireAcceptedObservation();
    const context = this.context(preflight);
    const events = this.materializeDrafts(this.laps.evaluated(context, input), preflight.observation, preflight.timelineEpoch, preflight.sequence).events;
    this.recordLapEvents(events);
    return events;
  }

  noteLapSaved(lapNumber: number, lapId: number): RaceEvent[] {
    if (this.sessionId == null) return [];
    const updated: RaceEvent[] = [];
    for (const [eventId, event] of this.emittedById) {
      if (event.sessionId !== this.sessionId || event.lapNumber !== lapNumber) {
        continue;
      }
      const linked = { ...event, lapId } as RaceEvent;
      this.emittedById.set(eventId, linked);
      updated.push(linked);
    }
    return updated.sort(compareRaceEvents);
  }

  noteSourceLifecycle(evidence: SourceLifecycleEvidence, scopedSessionId?: number | null): RaceEvent[] {
    if (this.sessionId == null) {
      this.sourceQuality.holdLifecycle(evidence);
      return [];
    }
    if (scopedSessionId != null && scopedSessionId !== this.sessionId) return [];
    const context = this.syntheticContext(evidence.timestampMs, evidence.eventId);
    const drafts: DetectorEventDraft[] = [];
    if (evidence.kind === "reconnect") {
      const incomplete = this.materializeDrafts(this.pits.finalize(context), context.observation, context.timelineEpoch, context.sequence).events;
      const staleLifecycle = this.activeLifecycles.get(lifecycleKey("source-stale", null));
      const connectionLifecycle = this.activeLifecycles.get(lifecycleKey("source-connection", null));
      this.beginEpoch("source-reconnect", context.observation);
      if (staleLifecycle) this.activeLifecycles.set(lifecycleKey("source-stale", null), staleLifecycle);
      if (connectionLifecycle) this.activeLifecycles.set(lifecycleKey("source-connection", null), connectionLifecycle);
      this.reconnectEpochPending = true;
      const resetContext = this.syntheticContext(evidence.timestampMs, evidence.eventId);
      drafts.push(...this.resetDrafts(resetContext.observation, "source-reconnect"));
      drafts.push(...this.sourceQuality.lifecycle(resetContext, evidence).map((draft) => ({ ...draft, sequence: 0 })));
      const epochEvents = this.materializeDrafts(drafts, resetContext.observation, resetContext.timelineEpoch, 0).events;
      return [...incomplete, ...epochEvents].sort(compareRaceEvents);
    }
    if (evidence.kind === "timeout" || evidence.kind === "stop") {
      drafts.push(...this.pits.finalize(context));
    }
    drafts.push(...this.sourceQuality.lifecycle(context, evidence));
    return this.materializeDrafts(drafts, context.observation, context.timelineEpoch, context.sequence).events;
  }

  noteStorageFailure(input: { kind: "drop" | "failure"; operation: string; details: string | null; boundaryKey?: string }): RaceEvent[] {
    if (this.sessionId == null) return [];
    const context = this.syntheticContext(this.lastObservation?.sourceTimeMs ?? 0, input.boundaryKey);
    return this.materializeDrafts([this.sourceQuality.storage(context, input)], context.observation, context.timelineEpoch, context.sequence).events;
  }

  noteSourceSequenceFinalized(finalized: SourceSequenceFinalized): RaceEvent[] {
    if (this.sessionId == null) return [];
    const context = this.syntheticContext(this.lastObservation?.sourceTimeMs ?? 0);
    const events = this.materializeDrafts(
      this.sourceQuality.finalizeGaps(context, finalized, (gap) =>
        this.gapAnchors.get(sourceGapAnchorKey(gap)),
      ),
      context.observation,
      context.timelineEpoch,
      context.sequence,
    ).events;
    this.gapAnchors.clear();
    return events;
  }

  endSession(input: RaceEventSessionEndInput): RaceEvent[] {
    if (this.sessionId == null || !this.sessionStarted) return [];
    const context = this.syntheticContext(this.lastObservation?.sourceTimeMs ?? 0);
    const drafts = this.pits.finalize(context);
    if (input.terminalObserved || SESSION_ROTATION_REASONS.has(input.reason)) {
      drafts.push(...this.raceControl.endSession(context, input));
    }
    const events = this.materializeDrafts(drafts, context.observation, context.timelineEpoch, context.sequence).events;
    if (input.terminalObserved || SESSION_ROTATION_REASONS.has(input.reason)) {
      const connectionLifecycle = this.activeLifecycles.get(lifecycleKey("source-connection", null));
      this.activeLifecycles.clear();
      this.pitLifecycleOpenings.clear();
      if (connectionLifecycle) {
        this.activeLifecycles.set(lifecycleKey("source-connection", null), connectionLifecycle);
      }
      this.sessionStarted = false;
      this.pendingSessionStartReason = "no-session";
    }
    return events;
  }

  classificationForLap(sessionId: number, lapNumber: number): LapTimelineClassificationContext {
    if (this.sessionId !== sessionId) {
      return { pitPhase: null, conditions: [], gridStart: false };
    }
    const state = this.lapContexts.get(lapNumber);
    if (!state) return { pitPhase: null, conditions: [], gridStart: false };
    let pitPhase: LapTimelineClassificationContext["pitPhase"] = null;
    if (state.pitEntry && state.pitExit) pitPhase = "pit";
    else if (state.pitEntry) pitPhase = "in";
    else if (state.pitExit) pitPhase = "out";
    else if (state.pitStart === "pit-lane" || state.pitStart === "pit-stall" || state.pitEnd === "pit-lane" || state.pitEnd === "pit-stall") {
      pitPhase = "pit";
    }
    return {
      pitPhase,
      conditions: [...state.conditions],
      gridStart: state.gridStart,
    };
  }

  eventIdsForLap(sessionId: number, lapNumber: number): RaceEventId[] {
    if (this.sessionId !== sessionId) return [];
    return [...(this.lapContexts.get(lapNumber)?.eventIds ?? [])];
  }

  events(): RaceEvent[] {
    return [...this.emittedById.values()].sort(compareRaceEvents);
  }

  private resetReason(observation: RaceEventObservation, evidence: RaceEventPreflightEvidence): string | null {
    if (evidence.reconnect) {
      if (this.reconnectEpochPending) {
        this.reconnectEpochPending = false;
        return null;
      }
      return evidence.resetReason ?? "source-reconnect";
    }
    if (evidence.replaySeek) return evidence.resetReason ?? "replay-seek";
    if (evidence.timebaseReset) return evidence.resetReason ?? "timebase-reset";
    if (evidence.lapReset) return evidence.resetReason ?? "lap-reset";
    if (evidence.sessionBoundaryReason != null && evidence.sessionBoundaryReason !== "no-session") {
      return evidence.resetReason ?? evidence.sessionBoundaryReason;
    }
    if (this.lastGameId != null && observation.gameId !== this.lastGameId) {
      return "game-changed";
    }
    if (this.lastSessionUid != null && observation.sessionUid != null && observation.sessionUid !== this.lastSessionUid) {
      return "session-uid-changed";
    }
    if (
      this.lastSourceTimeMs != null &&
      observation.sourceSequences.length === 0 &&
      observation.sourceTimeMs < this.lastSourceTimeMs
    ) {
      return "source-time-moved-backwards";
    }
    return null;
  }

  private beginEpoch(reason: string, observation: RaceEventObservation, resetDetectors = true): void {
    if (this.sequence > 0 || this.lastObservation != null) this.timelineEpoch += 1;
    this.sequence = 0;
    this.seedNextObservation = true;
    this.reconnectEpochPending = false;
    this.lastNativeSequence.clear();
    this.lastCoordinateKey = null;
    if (resetDetectors) this.resetEpochDetectors();
    this.lastSourceTimeMs = null;
    this.lastGameId = observation.gameId;
    this.lastSessionUid = observation.sessionUid;
    void reason;
  }

  private resetEpochDetectors(): void {
    this.raceControl.reset();
    this.participants.reset(true);
    this.laps.reset();
    this.pits.reset();
    this.incidents.reset();
    this.activeLifecycles.clear();
    this.pitLifecycleOpenings.clear();
  }

  private resetDrafts(observation: RaceEventObservation, reason: string): DetectorEventDraft[] {
    const previousSourceTimeMs = this.lastObservation?.sourceTimeMs ?? null;
    const payload = {
      reason,
      previousSourceTimeMs,
      currentSourceTimeMs: observation.sourceTimeMs,
    };
    return [
      {
        eventType: "timeline_discontinuity",
        payload,
        detectorId: "coordinator-preflight",
        detectorVersion: "1",
        priority: EVENT_ORDER_PRIORITY.sourceQuality,
        sequence: 0,
        boundaryKey: `epoch:${this.timelineEpoch}:${reason}:discontinuity`,
        sourceTimeMs: observation.sourceTimeMs,
        sourceEndTimeMs: observation.sourceTimeMs,
        evidenceKind: "derived",
        confidence: "high",
        qualityState: "degraded",
      },
      {
        eventType: "timebase_reset",
        payload,
        detectorId: "coordinator-preflight",
        detectorVersion: "1",
        priority: EVENT_ORDER_PRIORITY.sessionRaceControl,
        sequence: 0,
        boundaryKey: `epoch:${this.timelineEpoch}:${reason}:timebase`,
        sourceTimeMs: observation.sourceTimeMs,
        sourceEndTimeMs: observation.sourceTimeMs,
        evidenceKind: "derived",
        confidence: "high",
        qualityState: "degraded",
      },
    ];
  }

  private ambiguousCoordinateDraft(observation: RaceEventObservation, coordinateKey: string): DetectorEventDraft {
    return {
      eventType: "timeline_discontinuity",
      payload: {
        reason: "same-coordinate-content-mismatch",
        previousSourceTimeMs: this.lastSourceTimeMs,
        currentSourceTimeMs: observation.sourceTimeMs,
      },
      detectorId: "coordinator-preflight",
      detectorVersion: "1",
      priority: EVENT_ORDER_PRIORITY.sourceQuality,
      boundaryKey: `${coordinateKey}:content-mismatch:${observation.sourceTimeMs}:${observationContentHash(observation)}`,
      sourceTimeMs: observation.sourceTimeMs,
      sourceEndTimeMs: observation.sourceTimeMs,
      evidenceKind: "derived",
      confidence: "high",
      qualityState: "ambiguous",
    };
  }

  private isNativeOutOfOrder(observation: RaceEventObservation): boolean {
    return observation.sourceSequences.some(({ family, sequence }) => {
      const previous = this.lastNativeSequence.get(family);
      return previous != null && sequence < previous;
    });
  }

  private syntheticBoundary(observation: RaceEventObservation, kind: "duplicate" | "out-of-order") {
    const source = observation.sourceSequences[0];
    return {
      kind,
      sourceSequenceFamily: source?.family ?? null,
      previousSequence: source == null ? null : (this.lastNativeSequence.get(source.family) ?? null),
      currentSequence: source?.sequence ?? null,
      previousSourceTimeMs: this.lastSourceTimeMs ?? observation.sourceTimeMs,
      currentSourceTimeMs: observation.sourceTimeMs,
      previousObservationIndex: Math.max(0, this.sequence - 1),
      currentObservationIndex: this.sequence,
    } as const;
  }

  private context(preflight: RaceEventPreflightResult): DetectorContext {
    if (this.sessionId == null) throw new Error("Race-event session is not bound");
    return {
      sessionId: this.sessionId,
      timelineEpoch: preflight.timelineEpoch,
      sequence: preflight.sequence,
      sourceKind: this.sourceKind,
      observation: preflight.observation,
      boundaryKey: preflight.boundaryKey,
      seed: preflight.seed,
    };
  }

  private contextForRejected(observation: RaceEventObservation, sequence: number, boundaryKey: string): DetectorContext {
    return {
      sessionId: this.sessionId ?? 1,
      timelineEpoch: this.timelineEpoch,
      sequence,
      sourceKind: this.sourceKind,
      observation,
      boundaryKey,
      seed: false,
    };
  }

  private syntheticContext(sourceTimeMs: number, boundaryKey?: string): DetectorContext {
    if (this.sessionId == null) throw new Error("Race-event session is not bound");
    const observation =
      this.lastObservation ??
      ({
        gameId: "fm-2023",
        sessionUid: null,
        receivedAtMs: sourceTimeMs,
        sourceTimeMs,
        sourceSequences: [],
        lapNumber: null,
        currentLapTimeMs: null,
        lastLapTimeMs: null,
        trackDistanceM: null,
        trackDistancePct: null,
        worldPosition: null,
        sessionPhase: "unknown",
        nativeRaceControlCode: null,
        cautionKind: "unknown",
        gridStart: null,
        terminalObserved: null,
        participants: [],
        rosterAuthoritative: false,
      } satisfies RaceEventObservation);
    return {
      sessionId: this.sessionId,
      timelineEpoch: this.timelineEpoch,
      sequence: this.sequence,
      sourceKind: this.sourceKind,
      observation: { ...observation, sourceTimeMs },
      boundaryKey: boundaryKey ?? `synthetic:${this.timelineEpoch}:${this.sequence}:${sourceTimeMs}`,
      seed: false,
    };
  }

  private materializeResult(preflight: RaceEventPreflightResult, drafts: DetectorEventDraft[]): RaceEventProcessingResult {
    const materialized = this.materializeDrafts(drafts, preflight.observation, preflight.timelineEpoch, preflight.sequence);
    this.recordLapEvents(materialized.events);
    return {
      accepted: preflight.accepted,
      events: materialized.events,
      rejectedDrafts: materialized.rejectedDrafts,
      timelineEpoch: preflight.timelineEpoch,
      sequence: preflight.sequence,
      reason: preflight.reason,
    };
  }

  private materializeDrafts(
    drafts: readonly DetectorEventDraft[],
    observation: RaceEventObservation,
    timelineEpoch: number,
    sequence: number,
  ): {
    events: RaceEvent[];
    rejectedDrafts: RaceEventProcessingResult["rejectedDrafts"];
  } {
    if (this.sessionId == null || drafts.length === 0) {
      return { events: [], rejectedDrafts: [] };
    }
    let source = observation.sourceSequences[0];
    for (let index = 1; index < observation.sourceSequences.length; index += 1) {
      const candidate = observation.sourceSequences[index]!;
      if (source == null || candidate.family < source.family) source = candidate;
    }
    const prepared = drafts.map((draft) => {
      const participant = draft.participant ?? null;
      const participantId = draft.participantId ?? participant?.participantId ?? null;
      const draftTimelineEpoch = draft.timelineEpoch ?? timelineEpoch;
      const sourceTimeMs = draft.sourceTimeMs ?? observation.sourceTimeMs;
      const pointEndTime = draft.sourceEndTimeMs ?? sourceTimeMs;
      const base = {
        eventType: draft.eventType,
        schemaVersion: RACE_EVENT_SCHEMA_VERSION,
        sessionId: this.sessionId!,
        participantId,
        participantKind: draft.participantKind ?? participant?.participantKind ?? null,
        driverId: draft.driverId ?? participant?.driverId ?? null,
        teamId: draft.teamId ?? participant?.teamId ?? null,
        timelineEpoch: draftTimelineEpoch,
        sequence: draft.sequence ?? sequence,
        eventOrder: 0,
        sourceTimeMs,
        sourceEndTimeMs: pointEndTime,
        sourceSequenceFamily: draft.sourceSequenceFamily ?? source?.family ?? null,
        sourceSequence: draft.sourceSequence ?? source?.sequence ?? null,
        receivedAtMs: observation.receivedAtMs,
        lapNumber: draft.lapNumber ?? observation.lapNumber,
        lapId: draft.lapId ?? null,
        trackDistanceM: draft.trackDistanceM ?? observation.trackDistanceM,
        trackDistancePct: draft.trackDistancePct ?? observation.trackDistancePct,
        worldPosition: draft.worldPosition ?? observation.worldPosition,
        evidenceKind: draft.evidenceKind,
        confidence: draft.confidence,
        qualityState: draft.qualityState,
        sourceKind: this.sourceKind,
        payload: draft.payload,
        lifecycleId: null,
        linkedEventId: null,
        detectorId: draft.detectorId,
        detectorVersion: draft.detectorVersion,
        sourceGeneration: this.sourceGeneration,
        analysisGenerationId: this.analysisGenerationId,
      } as RaceEventDraft;
      const sortId = raceEventId({
        sessionId: base.sessionId,
        participantId: base.participantId,
        timelineEpoch: draftTimelineEpoch,
        eventType: base.eventType,
        detectorId: base.detectorId,
        boundaryKey: draft.boundaryKey,
        lifecycleId: null,
      });
      return { draft, base, participantId, draftTimelineEpoch, sortId };
    });
    prepared.sort((left, right) => {
      const leftServiceOrder = pitServiceSubOrder(left.draft.eventType);
      const rightServiceOrder = pitServiceSubOrder(right.draft.eventType);
      const serviceOrder =
        leftServiceOrder != null && rightServiceOrder != null
          ? leftServiceOrder - rightServiceOrder
          : 0;
      return (
        serviceOrder ||
        eventOrderPriority(left.draft) - eventOrderPriority(right.draft) ||
        lifecycleClosureOrder(left.draft.eventType) - lifecycleClosureOrder(right.draft.eventType) ||
        left.draft.eventType.localeCompare(right.draft.eventType) ||
        (left.base.participantId ?? "").localeCompare(right.base.participantId ?? "") ||
        (left.draft.stableSortKey ?? left.sortId).localeCompare(right.draft.stableSortKey ?? right.sortId)
      );
    });

    const stagedActiveLifecycles = new Map(this.activeLifecycles);
    const stagedPitLifecycleOpenings = new Map(this.pitLifecycleOpenings);
    const rejectedDrafts: RaceEventProcessingResult["rejectedDrafts"] = [];
    const pendingEvents: RaceEvent[] = [];
    const stagedEmittedById = new Map<RaceEventId, RaceEvent>();
    const withinPriority = new Map<number, number>();
    for (const item of prepared) {
      const priority = eventOrderPriority(item.draft);
      const index = withinPriority.get(priority) ?? 0;
      withinPriority.set(priority, index + 1);
      const lifecycle = this.lifecycleFieldsForDraft(
        item.draft,
        item.participantId,
        item.draftTimelineEpoch,
        stagedActiveLifecycles,
        stagedPitLifecycleOpenings,
      );
      const candidate = {
        ...item.base,
        ...lifecycle,
        eventOrder: priority * 1_000 + index,
      } as RaceEventDraft;
      const parsedDraft = RaceEventDraftSchema.safeParse(candidate);
      if (!parsedDraft.success) {
        const error = parsedDraft.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
        if (this.validationMode === "rebuild") {
          throw new Error(`Invalid rebuild race event ${item.draft.eventType}: ${error}`);
        }
        rejectedDrafts.push({ eventType: item.draft.eventType, error });
        continue;
      }
      const event = materializeRaceEvent(parsedDraft.data, item.draft.boundaryKey, this.createdAt(observation.receivedAtMs));
      const parsedEvent = RaceEventSchema.safeParse(event);
      if (!parsedEvent.success) {
        const error = parsedEvent.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
        if (this.validationMode === "rebuild") {
          throw new Error(`Invalid rebuild race event ${item.draft.eventType}: ${error}`);
        }
        rejectedDrafts.push({ eventType: item.draft.eventType, error });
        continue;
      }
      const previous = stagedEmittedById.get(parsedEvent.data.eventId) ?? this.emittedById.get(parsedEvent.data.eventId);
      if (previous) {
        if (previous.contentHash !== parsedEvent.data.contentHash) {
          throw new RaceEventConflictError(previous, parsedEvent.data);
        }
        continue;
      }
      stagedEmittedById.set(parsedEvent.data.eventId, parsedEvent.data);
      this.stageLifecycleEvent(parsedEvent.data, stagedActiveLifecycles, stagedPitLifecycleOpenings);
      pendingEvents.push(parsedEvent.data);
    }

    if (rejectedDrafts.length > 0) return { events: [], rejectedDrafts };
    for (const [eventId, event] of stagedEmittedById) {
      this.emittedById.set(eventId, event);
    }
    this.activeLifecycles.clear();
    for (const [key, lifecycle] of stagedActiveLifecycles) {
      this.activeLifecycles.set(key, lifecycle);
    }
    this.pitLifecycleOpenings.clear();
    for (const [lifecycleId, opening] of stagedPitLifecycleOpenings) {
      this.pitLifecycleOpenings.set(lifecycleId, opening);
    }
    return { events: pendingEvents.sort(compareRaceEvents), rejectedDrafts };
  }
  private stageLifecycleEvent(
    event: RaceEvent,
    activeLifecycles: Map<string, ActiveLifecycle>,
    pitLifecycleOpenings: Map<string, PitLifecycleOpening>,
  ): void {
    const assignment = lifecycleAssignment(event.eventType, event.participantId);
    if (assignment && event.lifecycleId != null) {
      if (assignment.role === "open") {
        activeLifecycles.set(assignment.key, {
          lifecycleId: event.lifecycleId,
          openingEventId: event.eventId,
          participantId: event.participantId,
        });
      } else if (
        event.eventType !== "penalty_cleared" ||
        (event.payload as RaceEventPayloadMap["penalty_cleared"]).currentValue === 0
      ) {
        activeLifecycles.delete(assignment.key);
      }
      return;
    }
    if (event.lifecycleId == null || !isPitLifecycleEvent(event.eventType)) return;
    if (event.eventType === "pit_exit" || event.eventType === "pit_visit_incomplete") {
      pitLifecycleOpenings.delete(event.lifecycleId);
    } else if (!pitLifecycleOpenings.has(event.lifecycleId)) {
      pitLifecycleOpenings.set(event.lifecycleId, {
        openingEventId: event.eventId,
        participantId: event.participantId,
      });
    }
  }


  private lifecycleFieldsForDraft(
    draft: DetectorEventDraft,
    participantId: string | null,
    timelineEpoch: number,
    activeLifecycles: ReadonlyMap<string, ActiveLifecycle>,
    pitLifecycleOpenings: ReadonlyMap<string, PitLifecycleOpening>,
  ): Pick<RaceEventDraft, "lifecycleId" | "linkedEventId"> {
    const assignment = lifecycleAssignment(draft.eventType, participantId);
    if (assignment) {
      const active = activeLifecycles.get(assignment.key);
      if (assignment.role === "close") {
        if (!active) {
          return {
            lifecycleId: draft.lifecycleId ?? null,
            linkedEventId: draft.linkedEventId ?? null,
          };
        }
        return {
          lifecycleId: active.lifecycleId,
          linkedEventId: active.openingEventId,
        };
      }
      if (active) {
        return {
          lifecycleId: active.lifecycleId,
          linkedEventId: draft.linkedEventId ?? null,
        };
      }
      const lifecycleId = raceEventLifecycleId({
        sessionId: this.sessionId!,
        participantId,
        timelineEpoch,
        openingEventType: assignment.openingEventType,
        detectorId: draft.detectorId,
        boundaryKey: draft.boundaryKey,
      });
      return { lifecycleId, linkedEventId: draft.linkedEventId ?? null };
    }

    const lifecycleId = draft.lifecycleId ?? null;
    if (lifecycleId == null || !isPitLifecycleEvent(draft.eventType)) {
      return {
        lifecycleId,
        linkedEventId: draft.linkedEventId ?? null,
      };
    }
    const opening = pitLifecycleOpenings.get(lifecycleId);
    if (opening) {
      return {
        lifecycleId,
        linkedEventId: draft.linkedEventId ?? opening.openingEventId,
      };
    }
    return { lifecycleId, linkedEventId: draft.linkedEventId ?? null };
  }


  private noteObservationLapContext(context: DetectorContext): void {
    const lapNumber = context.observation.lapNumber;
    if (lapNumber == null) return;
    const state = this.lapState(lapNumber);
    const local = context.observation.participants.find(({ participantKind }) => participantKind === "player");
    if (state.pitStart == null && local) state.pitStart = local.pitState;
    if (local) state.pitEnd = local.pitState;
    if (context.observation.gridStart === true) state.gridStart = true;
    const phase = this.raceControl.currentPhase();
    const caution = this.raceControl.currentCautionKind();
    if (phase === "formation") state.conditions.add("formation");
    if (phase === "caution") {
      state.conditions.add(caution === "virtual-safety-car" ? "slow_zone" : "caution");
    }
  }

  private projectPitDrafts(drafts: readonly DetectorEventDraft[]): void {
    for (const draft of drafts) {
      const lapNumber = draft.lapNumber ?? this.lastObservation?.lapNumber;
      if (lapNumber == null) continue;
      const state = this.lapState(lapNumber);
      if (draft.eventType === "pit_entry") state.pitEntry = true;
      else if (draft.eventType === "pit_exit") state.pitExit = true;
    }
  }

  private recordLapEvents(events: readonly RaceEvent[]): void {
    for (const event of events) {
      if (event.lapNumber == null) continue;
      const state = this.lapState(event.lapNumber);
      if (!state.eventIds.includes(event.eventId)) state.eventIds.push(event.eventId);
    }
  }

  private lapState(lapNumber: number): LapContextState {
    let state = this.lapContexts.get(lapNumber);
    if (!state) {
      state = {
        conditions: new Set(),
        gridStart: false,
        pitStart: null,
        pitEnd: null,
        pitEntry: false,
        pitExit: false,
        eventIds: [],
      };
      this.lapContexts.set(lapNumber, state);
    }
    return state;
  }

  private requireAcceptedObservation(): RaceEventPreflightResult {
    if (!this.lastAccepted?.accepted) {
      throw new Error("Lap callback has no accepted race-event observation context");
    }
    return this.lastAccepted;
  }

  private clearParticipantLifecycles(participantId: string): void {
    for (const [key, lifecycle] of this.activeLifecycles) {
      if (lifecycle.participantId === participantId) {
        this.activeLifecycles.delete(key);
      }
    }
    for (const [lifecycleId, opening] of this.pitLifecycleOpenings) {
      if (opening.participantId === participantId) {
        this.pitLifecycleOpenings.delete(lifecycleId);
      }
    }
  }


  private assertValidObservation(observation: RaceEventObservation): void {
    if (!Number.isSafeInteger(observation.receivedAtMs) || observation.receivedAtMs < 0) {
      throw new RangeError("Race-event receivedAtMs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(observation.sourceTimeMs)) {
      throw new RangeError("Race-event sourceTimeMs must be a safe integer");
    }
    if (
      observation.lapNumber != null &&
      (!Number.isSafeInteger(observation.lapNumber) || observation.lapNumber < 0)
    ) {
      throw new RangeError("Race-event lapNumber must be a non-negative safe integer or null");
    }
    for (const source of observation.sourceSequences) {
      if (!Number.isSafeInteger(source.sequence)) {
        throw new RangeError("Race-event source sequence must be a safe integer");
      }
    }
    if (
      (observation.trackDistanceM != null && (!Number.isFinite(observation.trackDistanceM) || observation.trackDistanceM < 0)) ||
      (observation.trackDistancePct != null && (!Number.isFinite(observation.trackDistancePct) || observation.trackDistancePct < 0 || observation.trackDistancePct > 1))
    ) {
      throw new RangeError("Race-event track coordinates are out of range");
    }
    const position = observation.worldPosition;
    if (position != null && (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z))) {
      throw new RangeError("Race-event worldPosition must be finite or null");
    }
    for (const participant of observation.participants) {
      if (
        (participant.position != null && (!Number.isSafeInteger(participant.position) || participant.position < 1)) ||
        (participant.speedMps != null && (!Number.isFinite(participant.speedMps) || participant.speedMps < 0)) ||
        (participant.fuelLitres != null && (!Number.isFinite(participant.fuelLitres) || participant.fuelLitres < 0)) ||
        (participant.penaltyValue != null && (!Number.isFinite(participant.penaltyValue) || participant.penaltyValue < 0)) ||
        (participant.incidentCount != null && (!Number.isSafeInteger(participant.incidentCount) || participant.incidentCount < 0))
      ) {
        throw new RangeError("Race-event participant facts are out of range");
      }
      if (participant.tireWear != null) {
        for (const corner of TIRE_CORNERS) {
          const value = participant.tireWear[corner];
          if (!Number.isFinite(value) || value < 0 || value > 1) {
            throw new RangeError("Race-event tire wear must be within zero through one");
          }
        }
      }
      if (participant.damage != null) {
        for (const component in participant.damage) {
          const value = participant.damage[component];
          if (component.length === 0 || !Number.isFinite(value) || value < 0 || value > 100) {
            throw new RangeError("Race-event damage facts are out of range");
          }
        }
      }
    }
  }

  private resetForSession(): void {
    this.sessionStarted = false;
    this.pendingSessionStartReason = "no-session";
    this.timelineEpoch = 0;
    this.sequence = 0;
    this.seedNextObservation = true;
    this.reconnectEpochPending = false;
    this.lastSourceTimeMs = null;
    this.lastGameId = null;
    this.lastSessionUid = null;
    this.lastNativeSequence.clear();
    this.lastCoordinateKey = null;
    this.lastAccepted = null;
    this.lastObservation = null;
    this.emittedById.clear();
    this.lapContexts.clear();
    this.activeLifecycles.clear();
    this.gapAnchors.clear();
    this.pitLifecycleOpenings.clear();
    this.sourceQuality.reset();
    this.raceControl.reset();
    this.participants.reset();
    this.laps.reset();
    this.pits.reset();
    this.incidents.reset();
  }
}

export function classificationFromTimeline(context: LapTimelineClassificationContext) {
  return classifyLap(context);
}

function lifecycleClosureOrder(eventType: DetectorEventDraft["eventType"]): number {
  if (eventType === "pit_service_completed" || eventType === "drive_through_observed") {
    return 0;
  }
  if (eventType === "pit_stall_departure") return 1;
  if (eventType === "pit_exit") return 2;
  return 0;
}

function lifecycleKey(kind: LifecycleKind, participantId: string | null): string {
  return `${kind}:${participantId ?? "session"}`;
}

function lifecycleAssignment(eventType: RaceEventType, participantId: string | null): LifecycleAssignment | null {
  switch (eventType) {
    case "caution_started":
      return {
        key: lifecycleKey("caution", null),
        role: "open",
        openingEventType: "caution_started",
      };
    case "caution_ended":
      return {
        key: lifecycleKey("caution", null),
        role: "close",
        openingEventType: "caution_started",
      };
    case "damage_warning_started":
    case "damage_warning_cleared":
      if (participantId == null) return null;
      return {
        key: lifecycleKey("damage-warning", participantId),
        role: eventType === "damage_warning_started" ? "open" : "close",
        openingEventType: "damage_warning_started",
      };
    case "penalty_issued":
    case "penalty_cleared":
      if (participantId == null) return null;
      return {
        key: lifecycleKey("penalty", participantId),
        role: eventType === "penalty_issued" ? "open" : "close",
        openingEventType: "penalty_issued",
      };
    case "source_stale":
    case "source_recovered":
      return {
        key: lifecycleKey("source-stale", null),
        role: eventType === "source_stale" ? "open" : "close",
        openingEventType: "source_stale",
      };
    case "source_connected":
    case "source_disconnected":
      return {
        key: lifecycleKey("source-connection", null),
        role: eventType === "source_connected" ? "open" : "close",
        openingEventType: "source_connected",
      };
    default:
      return null;
  }
}

function isPitLifecycleEvent(eventType: RaceEventType): boolean {
  switch (eventType) {
    case "pit_entry":
    case "pit_stall_arrival":
    case "pit_service_started":
    case "tire_service_observed":
    case "fuel_service_observed":
    case "repair_service_observed":
    case "driver_service_observed":
    case "pit_service_completed":
    case "pit_stall_departure":
    case "pit_exit":
    case "pit_visit_incomplete":
    case "drive_through_observed":
      return true;
    default:
      return false;
  }
}

function sourceGapAnchorKey(
  gap: Pick<
    SourceSequenceGapBoundary,
    | "sourceSequenceFamily"
    | "previousSequence"
    | "currentSequence"
    | "previousSourceTimeMs"
    | "currentSourceTimeMs"
    | "previousObservationIndex"
    | "currentObservationIndex"
  >,
): string {
  return [
    gap.sourceSequenceFamily ?? "source-time",
    gap.previousSequence ?? gap.previousSourceTimeMs,
    gap.currentSequence ?? gap.currentSourceTimeMs,
    gap.previousObservationIndex,
    gap.currentObservationIndex,
  ].join(":");
}

function assertValidCreatedAt(createdAt: string): void {
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new RangeError("Race-event createdAt must be a valid timestamp");
  }
}
