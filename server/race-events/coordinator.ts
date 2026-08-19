import {
  RACE_EVENT_SCHEMA_VERSION,
  RaceEventDraftSchema,
  RaceEventSchema,
  type RaceEvent,
  type RaceEventDraft,
  type RaceEventId,
} from "../../shared/racing/events/contracts";
import {
  classifyLap,
  type LapCondition,
  type LapTimelineClassificationContext,
} from "../../shared/racing/laps/classification";
import type {
  EvidenceSourceKind,
  SourceLifecycleEvidence,
} from "../../shared/racing/quality/contracts";
import type { SourceSequenceFinalized } from "../../shared/telemetry/source-sequence";
import type { RaceEventObservation } from "../games/types";
import type { SessionEndReason } from "../lap-detection/types";
import { IncidentPenaltyDetector } from "./detectors/incident-penalty";
import { LapEventDetector } from "./detectors/lap";
import { ParticipantDriverDetector } from "./detectors/participant-driver";
import { PitServiceDetector } from "./detectors/pit-service";
import { SessionRaceControlDetector } from "./detectors/session-race-control";
import { SourceQualityDetector } from "./detectors/source-quality";
import {
  materializeRaceEvent,
  nativeCoordinateKey,
  observationBoundaryKey,
  observationContentHash,
  raceEventId,
} from "./identity";
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

export interface RaceEventCoordinatorOptions {
  sessionId?: number;
  sourceKind?: EvidenceSourceKind;
  sourceGeneration?: string | null;
  analysisGenerationId?: string | null;
  createdAt?: (receivedAtMs: number) => string;
  validationMode?: "live" | "rebuild";
}

export interface RaceEventSessionEndInput {
  reason: SessionEndReason;
  terminalObserved: boolean;
}

const SESSION_ROTATION_REASONS = new Set<SessionEndReason>([
  "session-uid-changed",
  "lap-number-reset",
  "distance-reset",
  "car-changed",
  "track-changed",
  "silence-timeout",
  "session-rotated",
]);

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
    this.createdAt =
      options.createdAt ??
      ((receivedAtMs) => new Date(receivedAtMs).toISOString());
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

  preflight(
    observation: RaceEventObservation,
    evidence: RaceEventPreflightEvidence = {},
  ): RaceEventPreflightResult {
    const resetReason = this.resetReason(observation, evidence);
    const reset = resetReason != null;
    const resetDrafts: DetectorEventDraft[] = [];
    if (reset) {
      this.beginEpoch(resetReason, observation);
      if (this.sessionId != null) {
        resetDrafts.push(...this.resetDrafts(observation, resetReason));
      }
    }

    const coordinateKey = nativeCoordinateKey(observation);
    const sameCoordinate =
      coordinateKey != null &&
      coordinateKey === this.lastCoordinateKey &&
      this.lastObservation != null;
    if (sameCoordinate && !reset) {
      const previousSequence = this.lastAccepted?.sequence ?? this.sequence;
      if (
        observationContentHash(this.lastObservation!) ===
        observationContentHash(observation)
      ) {
        const context = this.contextForRejected(
          observation,
          previousSequence,
          coordinateKey,
        );
        const boundaries =
          evidence.sourceSequenceBoundaries?.filter(
            ({ kind }) => kind === "duplicate",
          ) ?? [this.syntheticBoundary(observation, "duplicate")];
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
      const boundaryKey =
        coordinateKey ?? observationBoundaryKey(observation, this.sequence + 1);
      const context = this.contextForRejected(
        observation,
        this.sequence,
        boundaryKey,
      );
      const boundaries =
        evidence.sourceSequenceBoundaries?.filter(
          ({ kind }) => kind === "out-of-order",
        ) ?? [this.syntheticBoundary(observation, "out-of-order")];
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

    this.sequence += 1;
    const boundaryKey = observationBoundaryKey(observation, this.sequence);
    this.lastCoordinateKey = coordinateKey;
    for (const source of observation.sourceSequences) {
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
    return result;
  }

  processObservation(
    sessionId: number,
    observation: RaceEventObservation,
    evidence: RaceEventPreflightEvidence = {},
  ): RaceEventProcessingResult {
    this.bindSession(sessionId);
    return this.processPreflight(this.preflight(observation, evidence));
  }

  processPreflight(preflight: RaceEventPreflightResult): RaceEventProcessingResult {
    if (this.sessionId == null) {
      return {
        accepted: preflight.accepted,
        events: [],
        rejectedDrafts: [],
        timelineEpoch: preflight.timelineEpoch,
        sequence: preflight.sequence,
        reason: preflight.reason,
      };
    }

    const context = this.context(preflight);
    const drafts = [...preflight.qualityDrafts];
    if (preflight.accepted) {
      if (!this.sessionStarted) {
        drafts.push(...this.sourceQuality.bind(context));
        drafts.push(
          ...this.raceControl.startSession(
            context,
            this.pendingSessionStartReason,
          ),
        );
        this.sessionStarted = true;
      } else {
        drafts.push(...this.raceControl.observe(context));
      }
      const participantResult = this.participants.observe(context);
      drafts.push(...participantResult.drafts);
      for (const participantId of participantResult.unavailableParticipantIds) {
        this.pits.clearParticipant(participantId);
        this.incidents.clearParticipant(participantId);
      }

      this.noteObservationLapContext(context);
      drafts.push(
        ...this.laps.observe(
          context,
          this.classificationForLap(
            this.sessionId,
            preflight.observation.lapNumber ?? 0,
          ),
        ),
      );
      const pitDrafts = this.pits.observe(context);
      drafts.push(...pitDrafts);
      this.projectPitDrafts(pitDrafts);
      drafts.push(...this.incidents.observe(context));
    }
    return this.materializeResult(preflight, drafts);
  }

  noteLapEvaluated(input: RaceEventLapEvaluation): RaceEvent[] {
    const preflight = this.requireAcceptedObservation();
    const context = this.context(preflight);
    const events = this.materializeDrafts(
      this.laps.evaluated(context, input),
      preflight.observation,
      preflight.timelineEpoch,
      preflight.sequence,
    ).events;
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

  noteSourceLifecycle(
    evidence: SourceLifecycleEvidence,
    scopedSessionId?: number | null,
  ): RaceEvent[] {
    if (this.sessionId == null) {
      this.sourceQuality.holdLifecycle(evidence);
      return [];
    }
    if (scopedSessionId != null && scopedSessionId !== this.sessionId) return [];
    const context = this.syntheticContext(evidence.timestampMs, evidence.eventId);
    const drafts: DetectorEventDraft[] = [];
    if (evidence.kind === "reconnect") {
      const incomplete = this.materializeDrafts(
        this.pits.finalize(context),
        context.observation,
        context.timelineEpoch,
        context.sequence,
      ).events;
      this.beginEpoch("source-reconnect", context.observation);
      this.reconnectEpochPending = true;
      const resetContext = this.syntheticContext(
        evidence.timestampMs,
        evidence.eventId,
      );
      drafts.push(...this.resetDrafts(resetContext.observation, "source-reconnect"));
      drafts.push(
        ...this.sourceQuality
          .lifecycle(resetContext, evidence)
          .map((draft) => ({ ...draft, sequence: 0 })),
      );
      const epochEvents = this.materializeDrafts(
        drafts,
        resetContext.observation,
        resetContext.timelineEpoch,
        0,
      ).events;
      return [...incomplete, ...epochEvents].sort(compareRaceEvents);
    }
    if (evidence.kind === "timeout" || evidence.kind === "stop") {
      drafts.push(...this.pits.finalize(context));
    }
    drafts.push(...this.sourceQuality.lifecycle(context, evidence));
    return this.materializeDrafts(
      drafts,
      context.observation,
      context.timelineEpoch,
      context.sequence,
    ).events;
  }

  noteStorageFailure(input: {
    kind: "drop" | "failure";
    operation: string;
    details: string | null;
    boundaryKey?: string;
  }): RaceEvent[] {
    if (this.sessionId == null) return [];
    const context = this.syntheticContext(
      this.lastObservation?.sourceTimeMs ?? 0,
      input.boundaryKey,
    );
    return this.materializeDrafts(
      [this.sourceQuality.storage(context, input)],
      context.observation,
      context.timelineEpoch,
      context.sequence,
    ).events;
  }

  noteSourceSequenceFinalized(finalized: SourceSequenceFinalized): RaceEvent[] {
    if (this.sessionId == null) return [];
    const context = this.syntheticContext(this.lastObservation?.sourceTimeMs ?? 0);
    return this.materializeDrafts(
      this.sourceQuality.finalizeGaps(context, finalized),
      context.observation,
      context.timelineEpoch,
      context.sequence,
    ).events;
  }

  endSession(input: RaceEventSessionEndInput): RaceEvent[] {
    if (this.sessionId == null || !this.sessionStarted) return [];
    const context = this.syntheticContext(this.lastObservation?.sourceTimeMs ?? 0);
    const drafts = this.pits.finalize(context);
    if (input.terminalObserved || SESSION_ROTATION_REASONS.has(input.reason)) {
      drafts.push(...this.raceControl.endSession(context, input));
    }
    const events = this.materializeDrafts(
      drafts,
      context.observation,
      context.timelineEpoch,
      context.sequence,
    ).events;
    this.sessionStarted = false;
    this.pendingSessionStartReason = "no-session";
    return events;
  }

  classificationForLap(
    sessionId: number,
    lapNumber: number,
  ): LapTimelineClassificationContext {
    if (this.sessionId !== sessionId) {
      return { pitPhase: null, conditions: [], gridStart: false };
    }
    const state = this.lapContexts.get(lapNumber);
    if (!state) return { pitPhase: null, conditions: [], gridStart: false };
    let pitPhase: LapTimelineClassificationContext["pitPhase"] = null;
    if (state.pitEntry && state.pitExit) pitPhase = "pit";
    else if (state.pitEntry) pitPhase = "in";
    else if (state.pitExit) pitPhase = "out";
    else if (
      state.pitStart === "pit-lane" ||
      state.pitStart === "pit-stall" ||
      state.pitEnd === "pit-lane" ||
      state.pitEnd === "pit-stall"
    ) {
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

  private resetReason(
    observation: RaceEventObservation,
    evidence: RaceEventPreflightEvidence,
  ): string | null {
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
    if (
      evidence.sessionBoundaryReason != null &&
      evidence.sessionBoundaryReason !== "no-session"
    ) {
      return evidence.resetReason ?? evidence.sessionBoundaryReason;
    }
    if (this.lastGameId != null && observation.gameId !== this.lastGameId) {
      return "game-changed";
    }
    if (
      this.lastSessionUid != null &&
      observation.sessionUid != null &&
      observation.sessionUid !== this.lastSessionUid
    ) {
      return "session-uid-changed";
    }
    if (
      this.lastSourceTimeMs != null &&
      observation.sourceTimeMs < this.lastSourceTimeMs
    ) {
      return "source-time-moved-backwards";
    }
    return null;
  }

  private beginEpoch(reason: string, observation: RaceEventObservation): void {
    if (this.sequence > 0 || this.lastObservation != null) this.timelineEpoch += 1;
    this.sequence = 0;
    this.seedNextObservation = true;
    this.reconnectEpochPending = false;
    this.lastNativeSequence.clear();
    this.lastCoordinateKey = null;
    this.raceControl.reset();
    this.participants.reset(true);
    this.laps.reset();
    this.pits.reset();
    this.incidents.reset();
    this.lastSourceTimeMs = null;
    this.lastGameId = observation.gameId;
    this.lastSessionUid = observation.sessionUid;
    void reason;
  }

  private resetDrafts(
    observation: RaceEventObservation,
    reason: string,
  ): DetectorEventDraft[] {
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

  private ambiguousCoordinateDraft(
    observation: RaceEventObservation,
    coordinateKey: string,
  ): DetectorEventDraft {
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
    if (
      this.lastSourceTimeMs != null &&
      observation.sourceTimeMs < this.lastSourceTimeMs
    ) {
      return false;
    }
    return observation.sourceSequences.some(({ family, sequence }) => {
      const previous = this.lastNativeSequence.get(family);
      return previous != null && sequence < previous;
    });
  }

  private syntheticBoundary(
    observation: RaceEventObservation,
    kind: "duplicate" | "out-of-order",
  ) {
    const source = observation.sourceSequences[0];
    return {
      kind,
      sourceSequenceFamily: source?.family ?? null,
      previousSequence:
        source == null ? null : this.lastNativeSequence.get(source.family) ?? null,
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

  private contextForRejected(
    observation: RaceEventObservation,
    sequence: number,
    boundaryKey: string,
  ): DetectorContext {
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

  private syntheticContext(
    sourceTimeMs: number,
    boundaryKey?: string,
  ): DetectorContext {
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

  private materializeResult(
    preflight: RaceEventPreflightResult,
    drafts: DetectorEventDraft[],
  ): RaceEventProcessingResult {
    const materialized = this.materializeDrafts(
      drafts,
      preflight.observation,
      preflight.timelineEpoch,
      preflight.sequence,
    );
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
    if (this.sessionId == null) return { events: [], rejectedDrafts: [] };
    const prepared = drafts.map((draft) => {
      const participant = draft.participant ?? null;
      const source = [...observation.sourceSequences].sort((left, right) =>
        left.family.localeCompare(right.family),
      )[0];
      const sourceTimeMs = draft.sourceTimeMs ?? observation.sourceTimeMs;
      const pointEndTime = draft.sourceEndTimeMs ?? sourceTimeMs;
      const base = {
        eventType: draft.eventType,
        schemaVersion: RACE_EVENT_SCHEMA_VERSION,
        sessionId: this.sessionId!,
        participantId:
          draft.participantId ?? participant?.participantId ?? null,
        participantKind:
          draft.participantKind ?? participant?.participantKind ?? null,
        driverId: draft.driverId ?? participant?.driverId ?? null,
        teamId: draft.teamId ?? participant?.teamId ?? null,
        timelineEpoch,
        sequence: draft.sequence ?? sequence,
        eventOrder: 0,
        sourceTimeMs,
        sourceEndTimeMs: pointEndTime,
        sourceSequenceFamily:
          draft.sourceSequenceFamily ?? source?.family ?? null,
        sourceSequence: draft.sourceSequence ?? source?.sequence ?? null,
        receivedAtMs: observation.receivedAtMs,
        lapNumber: draft.lapNumber ?? observation.lapNumber,
        lapId: draft.lapId ?? null,
        trackDistanceM: draft.trackDistanceM ?? observation.trackDistanceM,
        trackDistancePct:
          draft.trackDistancePct ?? observation.trackDistancePct,
        worldPosition: draft.worldPosition ?? observation.worldPosition,
        evidenceKind: draft.evidenceKind,
        confidence: draft.confidence,
        qualityState: draft.qualityState,
        sourceKind: this.sourceKind,
        payload: draft.payload,
        lifecycleId: draft.lifecycleId ?? null,
        linkedEventId: draft.linkedEventId ?? null,
        detectorId: draft.detectorId,
        detectorVersion: draft.detectorVersion,
        sourceGeneration: this.sourceGeneration,
        analysisGenerationId: this.analysisGenerationId,
      } as RaceEventDraft;
      const stableId = raceEventId({
        sessionId: base.sessionId,
        participantId: base.participantId,
        timelineEpoch,
        eventType: base.eventType,
        detectorId: base.detectorId,
        boundaryKey: draft.boundaryKey,
        lifecycleId: base.lifecycleId,
      });
      return { draft, base, stableId };
    });
    prepared.sort(
      (left, right) =>
        left.draft.priority - right.draft.priority ||
        lifecycleClosureOrder(left.draft.eventType) -
          lifecycleClosureOrder(right.draft.eventType) ||
        left.draft.eventType.localeCompare(right.draft.eventType) ||
        (left.base.participantId ?? "").localeCompare(
          right.base.participantId ?? "",
        ) ||
        (left.draft.stableSortKey ?? left.stableId).localeCompare(
          right.draft.stableSortKey ?? right.stableId,
        ),
    );

    const rejectedDrafts: RaceEventProcessingResult["rejectedDrafts"] = [];
    const events: RaceEvent[] = [];
    if (this.validationMode === "rebuild") {
      const previewWithinPriority = new Map<number, number>();
      for (const item of prepared) {
        const index = previewWithinPriority.get(item.draft.priority) ?? 0;
        previewWithinPriority.set(item.draft.priority, index + 1);
        const candidate = {
          ...item.base,
          eventOrder: item.draft.priority * 1_000 + index,
        } as RaceEventDraft;
        const parsed = RaceEventDraftSchema.safeParse(candidate);
        if (!parsed.success) {
          throw new Error(
            `Invalid rebuild race event ${item.draft.eventType}: ${parsed.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; ")}`,
          );
        }
      }
    }
    const withinPriority = new Map<number, number>();
    for (const item of prepared) {
      const index = withinPriority.get(item.draft.priority) ?? 0;
      withinPriority.set(item.draft.priority, index + 1);
      const candidate = {
        ...item.base,
        eventOrder: item.draft.priority * 1_000 + index,
      } as RaceEventDraft;
      const parsedDraft = RaceEventDraftSchema.safeParse(candidate);
      if (!parsedDraft.success) {
        rejectedDrafts.push({
          eventType: item.draft.eventType,
          error: parsedDraft.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        });
        continue;
      }
      const event = materializeRaceEvent(
        parsedDraft.data,
        item.draft.boundaryKey,
        this.createdAt(observation.receivedAtMs),
      );
      const parsedEvent = RaceEventSchema.safeParse(event);
      if (!parsedEvent.success) {
        rejectedDrafts.push({
          eventType: item.draft.eventType,
          error: parsedEvent.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        });
        continue;
      }
      const previous = this.emittedById.get(parsedEvent.data.eventId);
      if (previous) {
        if (previous.contentHash !== parsedEvent.data.contentHash) {
          throw new RaceEventConflictError(previous, parsedEvent.data);
        }
        continue;
      }
      this.emittedById.set(parsedEvent.data.eventId, parsedEvent.data);
      events.push(parsedEvent.data);
    }

    if (rejectedDrafts.length > 0) {
      const failure = this.validationFailureEvent(
        observation,
        timelineEpoch,
        sequence,
        rejectedDrafts,
      );
      if (failure) events.push(failure);
    }
    return { events: events.sort(compareRaceEvents), rejectedDrafts };
  }

  private validationFailureEvent(
    observation: RaceEventObservation,
    timelineEpoch: number,
    sequence: number,
    failures: RaceEventProcessingResult["rejectedDrafts"],
  ): RaceEvent | null {
    if (this.sessionId == null) return null;
    const boundaryKey = `validation:${timelineEpoch}:${sequence}`;
    const context = this.contextForRejected(observation, sequence, boundaryKey);
    const diagnostic = this.sourceQuality.storage(context, {
      kind: "failure",
      operation: "validate-race-event-batch",
      details: failures.map(({ eventType, error }) => `${eventType}: ${error}`).join(" | "),
      boundaryKey,
    });
    const source = observation.sourceSequences[0];
    const draft = {
      eventType: diagnostic.eventType,
      schemaVersion: RACE_EVENT_SCHEMA_VERSION,
      sessionId: this.sessionId,
      participantId: null,
      participantKind: null,
      driverId: null,
      teamId: null,
      timelineEpoch,
      sequence,
      eventOrder: EVENT_ORDER_PRIORITY.sourceQuality * 1_000 + 999,
      sourceTimeMs: observation.sourceTimeMs,
      sourceEndTimeMs: observation.sourceTimeMs,
      sourceSequenceFamily: source?.family ?? null,
      sourceSequence: source?.sequence ?? null,
      receivedAtMs: observation.receivedAtMs,
      lapNumber: observation.lapNumber,
      lapId: null,
      trackDistanceM: observation.trackDistanceM,
      trackDistancePct: observation.trackDistancePct,
      worldPosition: observation.worldPosition,
      evidenceKind: diagnostic.evidenceKind,
      confidence: diagnostic.confidence,
      qualityState: diagnostic.qualityState,
      sourceKind: this.sourceKind,
      payload: diagnostic.payload,
      lifecycleId: null,
      linkedEventId: null,
      detectorId: diagnostic.detectorId,
      detectorVersion: diagnostic.detectorVersion,
      sourceGeneration: this.sourceGeneration,
      analysisGenerationId: this.analysisGenerationId,
    } as RaceEventDraft;
    const parsed = RaceEventDraftSchema.safeParse(draft);
    if (!parsed.success) return null;
    const event = materializeRaceEvent(
      parsed.data,
      boundaryKey,
      this.createdAt(observation.receivedAtMs),
    );
    const existing = this.emittedById.get(event.eventId);
    if (existing) {
      if (existing.contentHash !== event.contentHash) {
        throw new RaceEventConflictError(existing, event);
      }
      return null;
    }
    this.emittedById.set(event.eventId, event);
    return event;
  }

  private noteObservationLapContext(context: DetectorContext): void {
    const lapNumber = context.observation.lapNumber;
    if (lapNumber == null) return;
    const state = this.lapState(lapNumber);
    const local = context.observation.participants.find(
      ({ participantKind }) => participantKind === "player",
    );
    if (state.pitStart == null && local) state.pitStart = local.pitState;
    if (local) state.pitEnd = local.pitState;
    if (context.observation.gridStart === true) state.gridStart = true;
    const phase = this.raceControl.currentPhase();
    const caution = this.raceControl.currentCautionKind();
    if (phase === "formation") state.conditions.add("formation");
    if (phase === "caution") {
      state.conditions.add(
        caution === "virtual-safety-car" ? "slow_zone" : "caution",
      );
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
    this.sourceQuality.reset();
    this.raceControl.reset();
    this.participants.reset();
    this.laps.reset();
    this.pits.reset();
    this.incidents.reset();
  }
}

export function classificationFromTimeline(
  context: LapTimelineClassificationContext,
) {
  return classifyLap(context);
}

function lifecycleClosureOrder(eventType: DetectorEventDraft["eventType"]): number {
  if (
    eventType === "pit_service_completed" ||
    eventType === "drive_through_observed"
  ) {
    return 0;
  }
  if (eventType === "pit_stall_departure") return 1;
  if (eventType === "pit_exit") return 2;
  return 0;
}
