import type {
  RaceEvent,
  RaceEventId,
  RaceSessionPhase,
} from "../../shared/racing/events/contracts";
import {
  SESSION_RUN_ALGORITHM_VERSION,
  SESSION_RUN_SCHEMA_VERSION,
  type OpenSessionRun,
  type SessionRun,
  type SessionRunBoundary,
  type SessionRunBoundaryReason,
  type SessionRunEvidence,
  type SessionRunEvidenceRole,
  type SessionRunKind,
  type SessionRunLapMembership,
} from "../../shared/racing/runs/contracts";
import {
  deriveSessionRunSummary,
  type CompletedSessionRunLap,
} from "../../shared/racing/runs/summary";
import { canonicalJson } from "../race-events/identity";
import {
  compareRaceEvents,
  RaceEventConflictError,
} from "../race-events/ordering";
import { sessionRunContentHash, sessionRunId } from "./identity";

const RUN_KINDS = ["participant", "tire", "driver", "pace"] as const;
const INCOMPLETE_REASONS: Record<SessionRunBoundaryReason, true | undefined> = {
  participant_joined: undefined,
  participant_returned: undefined,
  participant_unavailable: undefined,
  first_lap_observed_without_participant: undefined,
  session_phase_changed: undefined,
  tire_service: undefined,
  driver_started: undefined,
  driver_changed: undefined,
  fuel_service: undefined,
  repair_service: undefined,
  car_reset: undefined,
  red_flag_started: undefined,
  red_flag_restart: undefined,
  timeline_discontinuity: true,
  source_unavailable: true,
  source_recovered: undefined,
  session_ended: undefined,
  source_ended: true,
};
const SESSION_SCOPED_TYPES: Record<string, true> = {
  session_started: true,
  session_ended: true,
  session_phase_changed: true,
  green_flag: true,
  caution_started: true,
  caution_ended: true,
  red_flag_started: true,
  checkered_flag: true,
  restart_started: true,
  timebase_reset: true,
  source_connected: true,
  source_disconnected: true,
  source_stale: true,
  source_recovered: true,
  storage_drop: true,
  storage_failure: true,
  timeline_discontinuity: true,
};
const CONTENT_EVENT_TYPES: Record<string, true> = {
  position_changed: true,
  lap_started: true,
  lap_completed: true,
  pit_entry: true,
  pit_stall_arrival: true,
  pit_service_started: true,
  tire_service_observed: true,
  fuel_service_observed: true,
  repair_service_observed: true,
  driver_service_observed: true,
  pit_service_completed: true,
  pit_stall_departure: true,
  pit_exit: true,
  pit_visit_incomplete: true,
  drive_through_observed: true,
  incident_observed: true,
  damage_warning_started: true,
  damage_warning_cleared: true,
  penalty_issued: true,
  penalty_cleared: true,
};

interface ParticipantState {
  sessionId: number;
  participantId: string | null;
  participantKind: "player" | "opponent" | null;
  driverId: string | null;
  teamId: string | null;
  classId: string | null;
  available: boolean;
}

interface RunAccumulator {
  open: OpenSessionRun;
  laps: CompletedSessionRunLap[];
  evidence: Array<{ eventId: RaceEventId; role: SessionRunEvidenceRole }>;
  firstContentEvent: RaceEvent | null;
  lastContentEvent: RaceEvent | null;
}

interface BuilderState {
  revision: number;
  consumedEvents: Map<RaceEventId, RaceEvent>;
  participants: Map<string, ParticipantState>;
  accumulators: Map<string, RunAccumulator>;
  pendingEvidence: Map<string, RaceEventId[]>;
  phases: Map<number, RaceSessionPhase>;
  epochs: Map<number, number>;
  awaitingRedRestart: Set<number>;
  tireState: Map<string, { compound: string | null; setId: string | null }>;
}

export interface SessionRunBuilderInput {
  events: readonly RaceEvent[];
  lapsByCompletionEventId:
    | ReadonlyMap<RaceEventId, CompletedSessionRunLap>
    | Readonly<Record<string, CompletedSessionRunLap>>;
}

export interface SessionRunFinalization {
  sessionId?: number;
  event?: RaceEvent | null;
  reason?: "source-ended" | "session-ended";
}

export interface PreparedSessionRunUpdate {
  readonly runs: readonly SessionRun[];
  readonly memberships: readonly SessionRunLapMembership[];
  readonly evidence: readonly SessionRunEvidence[];
  readonly nextBuilderState: readonly OpenSessionRun[];
  commit(): void;
}

interface PreparedArtifacts {
  runs: SessionRun[];
  memberships: SessionRunLapMembership[];
  evidence: SessionRunEvidence[];
}

interface PreprocessedBatch {
  events: RaceEvent[];
  splitKindsByEvent: Map<RaceEventId, Set<SessionRunKind>>;
  supportingByPrimary: Map<
    RaceEventId,
    Map<SessionRunKind, RaceEventId[]>
  >;
}

function participantKey(sessionId: number, participantId: string | null): string {
  return `${sessionId}:${participantId ?? "<unknown>"}`;
}

function accumulatorKey(
  sessionId: number,
  participantId: string | null,
  timelineEpoch: number,
  runKind: SessionRunKind,
): string {
  return `${participantKey(sessionId, participantId)}:${timelineEpoch}:${runKind}`;
}

function pendingEvidenceKey(
  sessionId: number,
  participantId: string | null,
  runKind: SessionRunKind,
): string {
  return `${participantKey(sessionId, participantId)}:${runKind}`;
}

function addUnique<T>(values: T[], value: T): void {
  if (!values.includes(value)) values.push(value);
}

function eventMatches(
  existing: RaceEvent,
  incoming: RaceEvent,
): boolean {
  if (existing.contentHash != null && incoming.contentHash != null) {
    return existing.contentHash === incoming.contentHash;
  }
  const { lapId: _existingLapId, ...existingSemantic } = existing;
  const { lapId: _incomingLapId, ...incomingSemantic } = incoming;
  return canonicalJson(existingSemantic) === canonicalJson(incomingSemantic);
}

function lapForEvent(
  source:
    | ReadonlyMap<RaceEventId, CompletedSessionRunLap>
    | Readonly<Record<string, CompletedSessionRunLap>>,
  eventId: RaceEventId,
): CompletedSessionRunLap | undefined {
  return source instanceof Map
    ? source.get(eventId)
    : (source as Readonly<Record<string, CompletedSessionRunLap>>)[eventId];
}

function serviceKinds(event: RaceEvent): readonly SessionRunKind[] {
  switch (event.eventType) {
    case "tire_service_observed":
      return ["tire", "pace"];
    case "fuel_service_observed":
    case "repair_service_observed":
      return ["pace"];
    case "driver_changed":
    case "driver_service_observed":
      return ["driver", "pace"];
    default:
      return [];
  }
}

function preprocess(events: readonly RaceEvent[]): PreprocessedBatch {
  const ordered = [...events].sort(compareRaceEvents);
  const groups = new Map<string, RaceEvent[]>();
  for (const event of ordered) {
    const key = `${event.timelineEpoch}:${event.sequence}:${event.participantId ?? "<unknown>"}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }

  const splitKindsByEvent = new Map<RaceEventId, Set<SessionRunKind>>();
  const supportingByPrimary = new Map<
    RaceEventId,
    Map<SessionRunKind, RaceEventId[]>
  >();
  for (const group of groups.values()) {
    const primaryByKind = new Map<SessionRunKind, RaceEvent>();
    const driverChanges = group.filter(
      (event) => event.eventType === "driver_changed",
    );
    for (const event of group) {
      const kinds = serviceKinds(event);
      if (kinds.length === 0) continue;
      const splitKinds = new Set<SessionRunKind>();
      const matchingDriverChange =
        event.eventType === "driver_service_observed"
          ? driverChanges.find(
              (candidate) =>
                candidate.payload.driverId === event.payload.driverId &&
                candidate.payload.previousDriverId ===
                  event.payload.previousDriverId,
            )
          : undefined;
      for (const kind of kinds) {
        const forcedPrimary = matchingDriverChange;
        const primary = forcedPrimary ?? primaryByKind.get(kind);
        if (!primary) {
          primaryByKind.set(kind, event);
          splitKinds.add(kind);
          continue;
        }
        const supportByKind = supportingByPrimary.get(primary.eventId) ?? new Map();
        const supportIds = supportByKind.get(kind) ?? [];
        addUnique(supportIds, event.eventId);
        supportByKind.set(kind, supportIds);
        supportingByPrimary.set(primary.eventId, supportByKind);
      }
      splitKindsByEvent.set(event.eventId, splitKinds);
    }
  }
  return { events: ordered, splitKindsByEvent, supportingByPrimary };
}

function boundary(
  reason: SessionRunBoundaryReason,
  event: RaceEvent | null,
  confidence = event?.confidence ?? "unknown",
  evidenceKind = event?.evidenceKind ?? "derived",
): SessionRunBoundary {
  return {
    reason,
    eventId: event?.eventId ?? null,
    confidence,
    evidenceKind,
    algorithmVersion: SESSION_RUN_ALGORITHM_VERSION,
  };
}

export class SessionRunBuilder {
  private state: BuilderState = {
    revision: 0,
    consumedEvents: new Map(),
    participants: new Map(),
    accumulators: new Map(),
    pendingEvidence: new Map(),
    phases: new Map(),
    epochs: new Map(),
    awaitingRedRestart: new Set(),
    tireState: new Map(),
  };

  consume(input: SessionRunBuilderInput): PreparedSessionRunUpdate {
    const baseRevision = this.state.revision;
    const next = structuredClone(this.state) as BuilderState;
    const artifacts: PreparedArtifacts = {
      runs: [],
      memberships: [],
      evidence: [],
    };
    const unseen: RaceEvent[] = [];
    for (const event of input.events) {
      const existing = next.consumedEvents.get(event.eventId);
      if (existing) {
        if (!eventMatches(existing, event)) {
          throw new RaceEventConflictError(existing, event);
        }
        continue;
      }
      unseen.push(event);
    }
    if (unseen.length === 0) {
      return this.preparedUpdate(baseRevision, this.state, artifacts, false);
    }

    const prepared = preprocess(unseen);
    for (const event of prepared.events) {
      const currentEpoch = next.epochs.get(event.sessionId);
      if (currentEpoch != null && event.timelineEpoch > currentEpoch) {
        this.closeLowerEpochs(next, artifacts, event);
      }
      next.epochs.set(
        event.sessionId,
        Math.max(currentEpoch ?? event.timelineEpoch, event.timelineEpoch),
      );
      this.reduceEvent(next, artifacts, event, input, prepared);
      next.consumedEvents.set(event.eventId, event);
    }
    next.revision = baseRevision + 1;
    return this.preparedUpdate(baseRevision, next, artifacts, true);
  }

  finalize(input: SessionRunFinalization = {}): PreparedSessionRunUpdate {
    const baseRevision = this.state.revision;
    const next = structuredClone(this.state) as BuilderState;
    const artifacts: PreparedArtifacts = {
      runs: [],
      memberships: [],
      evidence: [],
    };
    const reason: SessionRunBoundaryReason =
      input.reason === "session-ended" ? "session_ended" : "source_ended";
    for (const [key, accumulator] of [...next.accumulators]) {
      if (input.sessionId != null && accumulator.open.sessionId !== input.sessionId) {
        continue;
      }
      const event = input.event ?? null;
      this.closeAccumulator(next, artifacts, key, accumulator, reason, event, []);
    }
    if (artifacts.runs.length === 0 && next.accumulators.size === this.state.accumulators.size) {
      return this.preparedUpdate(baseRevision, this.state, artifacts, false);
    }
    next.revision = baseRevision + 1;
    return this.preparedUpdate(baseRevision, next, artifacts, true);
  }

  openRuns(): readonly OpenSessionRun[] {
    return [...this.state.accumulators.values()]
      .map(({ open }) => structuredClone(open))
      .sort((left, right) =>
        left.sessionId - right.sessionId ||
        left.timelineEpoch - right.timelineEpoch ||
        left.openingSequence - right.openingSequence ||
        left.openingEventOrder - right.openingEventOrder ||
        left.runId.localeCompare(right.runId),
      );
  }

  private preparedUpdate(
    baseRevision: number,
    next: BuilderState,
    artifacts: PreparedArtifacts,
    changed: boolean,
  ): PreparedSessionRunUpdate {
    let committed = false;
    const openRuns = [...next.accumulators.values()].map(({ open }) =>
      structuredClone(open),
    );
    return {
      runs: artifacts.runs,
      memberships: artifacts.memberships,
      evidence: artifacts.evidence,
      nextBuilderState: openRuns,
      commit: () => {
        if (committed) throw new Error("Session run update already committed");
        if (this.state.revision !== baseRevision) {
          throw new Error("Session run builder state changed before commit");
        }
        committed = true;
        if (changed) this.state = next;
      },
    };
  }

  private closeLowerEpochs(
    state: BuilderState,
    artifacts: PreparedArtifacts,
    event: RaceEvent,
  ): void {
    const participants = new Set<string>();
    for (const [key, accumulator] of [...state.accumulators]) {
      if (
        accumulator.open.sessionId !== event.sessionId ||
        accumulator.open.timelineEpoch >= event.timelineEpoch
      ) {
        continue;
      }
      participants.add(
        participantKey(event.sessionId, accumulator.open.participantId),
      );
      this.closeAccumulator(
        state,
        artifacts,
        key,
        accumulator,
        "timeline_discontinuity",
        event,
        [],
      );
    }
    for (const key of participants) {
      const participant = state.participants.get(key);
      if (!participant?.available) continue;
      const openingReason =
        event.eventType === "source_recovered"
          ? "source_recovered"
          : "timeline_discontinuity";
      this.openAll(state, participant, event, openingReason, [
        "source_continuity_unknown",
      ]);
    }
  }

  private reduceEvent(
    state: BuilderState,
    artifacts: PreparedArtifacts,
    event: RaceEvent,
    input: SessionRunBuilderInput,
    prepared: PreprocessedBatch,
  ): void {
    if (event.eventType === "participant_joined" || event.eventType === "participant_returned") {
      const participant = this.upsertParticipant(state, event, true);
      this.openAll(
        state,
        participant,
        event,
        event.eventType === "participant_joined"
          ? "participant_joined"
          : "participant_returned",
        [],
      );
      return;
    }
    if (event.eventType === "participant_became_unavailable") {
      const participant = this.upsertParticipant(state, event, false);
      this.closeParticipant(
        state,
        artifacts,
        participant,
        event,
        "participant_unavailable",
        false,
        [],
      );
      return;
    }
    if (event.eventType === "lap_completed" && event.participantId === null) {
      const key = participantKey(event.sessionId, null);
      let participant = state.participants.get(key);
      if (!participant) {
        participant = this.upsertParticipant(state, event, true);
      }
      if (!this.hasAnyAccumulator(state, participant, event.timelineEpoch)) {
        this.openAll(
          state,
          participant,
          event,
          "first_lap_observed_without_participant",
          ["participant_identity_unavailable"],
        );
      }
    }

    if (event.eventType === "source_disconnected" || event.eventType === "source_stale") {
      this.forEachActiveParticipant(state, event.sessionId, (participant) => {
        this.closeParticipant(
          state,
          artifacts,
          participant,
          event,
          "source_unavailable",
          false,
          [],
        );
      });
      return;
    }
    if (event.eventType === "source_recovered") {
      this.forEachActiveParticipant(state, event.sessionId, (participant) => {
        if (!this.hasAnyAccumulator(state, participant, event.timelineEpoch)) {
          this.openAll(state, participant, event, "source_recovered", [
            "source_continuity_unknown",
          ]);
        }
      });
      return;
    }
    if (event.eventType === "storage_drop" || event.eventType === "storage_failure") {
      this.forEachTargetAccumulator(state, event, (accumulator) => {
        addUnique(accumulator.open.qualityFlags, "source_storage_degraded");
      });
      return;
    }
    if (event.eventType === "session_ended") {
      this.closeSession(state, artifacts, event, "session_ended");
      return;
    }

    if (
      event.eventType === "session_phase_changed" ||
      event.eventType === "session_started" ||
      event.eventType === "green_flag" ||
      event.eventType === "caution_started" ||
      event.eventType === "caution_ended" ||
      event.eventType === "red_flag_started" ||
      event.eventType === "checkered_flag" ||
      event.eventType === "restart_started"
    ) {
      this.applyPhaseEvent(state, artifacts, event);
    }

    if (event.eventType === "car_reset" || event.eventType === "timebase_reset" || event.eventType === "timeline_discontinuity") {
      const reason =
        event.eventType === "car_reset" ? "car_reset" : "timeline_discontinuity";
      this.forEachTargetParticipant(state, event, (participant) => {
        state.tireState.delete(participantKey(participant.sessionId, participant.participantId));
        this.closeParticipant(
          state,
          artifacts,
          participant,
          event,
          reason,
          true,
          ["source_continuity_unknown"],
        );
      });
      return;
    }

    if (CONTENT_EVENT_TYPES[event.eventType]) {
      const boundaryKinds =
        event.eventType === "driver_started_stint"
          ? new Set<SessionRunKind>(["driver", "pace"])
          : (prepared.splitKindsByEvent.get(event.eventId) ?? new Set());
      this.forEachTargetAccumulator(state, event, (accumulator) => {
        if (!boundaryKinds.has(accumulator.open.runKind)) {
          this.markContent(accumulator, event);
        }
      });
    }

    if (event.eventType === "driver_started_stint") {
      const participant = this.upsertParticipant(state, event, true);
      participant.driverId = event.payload.driverId;
      this.splitKinds(
        state,
        artifacts,
        participant,
        event,
        ["driver", "pace"],
        "driver_started",
        [],
      );
    } else if (
      event.eventType === "driver_changed" ||
      event.eventType === "driver_service_observed"
    ) {
      const participant = this.upsertParticipant(state, event, true);
      participant.driverId = event.payload.driverId;
      const kinds = [...(prepared.splitKindsByEvent.get(event.eventId) ?? [])];
      const reason = "driver_changed";
      this.splitKinds(
        state,
        artifacts,
        participant,
        event,
        kinds,
        reason,
        prepared.supportingByPrimary.get(event.eventId),
      );
    } else if (
      event.eventType === "tire_service_observed" ||
      event.eventType === "fuel_service_observed" ||
      event.eventType === "repair_service_observed"
    ) {
      const participant = this.upsertParticipant(state, event, true);
      const kinds = [...(prepared.splitKindsByEvent.get(event.eventId) ?? [])];
      const reason: SessionRunBoundaryReason =
        event.eventType === "tire_service_observed"
          ? "tire_service"
          : event.eventType === "fuel_service_observed"
            ? "fuel_service"
            : "repair_service";
      if (event.eventType === "tire_service_observed") {
        state.tireState.set(participantKey(event.sessionId, event.participantId), {
          compound: event.payload.currentCompound,
          setId: event.eventId,
        });
      }
      this.splitKinds(
        state,
        artifacts,
        participant,
        event,
        kinds,
        reason,
        prepared.supportingByPrimary.get(event.eventId),
      );
    }

    if (event.eventType === "lap_completed") {
      const lap = lapForEvent(input.lapsByCompletionEventId, event.eventId) ?? {
        lapEventId: event.eventId,
        lapId: event.lapId,
        lapNumber: event.payload.lapNumber,
        lapTimeMs: event.payload.lapTimeMs,
        isValid: event.payload.isValid,
        phase: event.payload.phase,
        conditions: event.payload.conditions,
        quality: null,
        eligibility: null,
      };
      this.forEachTargetAccumulator(state, event, (accumulator) => {
        accumulator.laps.push(lap);
        addUnique(accumulator.open.lapEventIds, event.eventId);
        if (!lap.quality) {
          addUnique(accumulator.open.qualityFlags, "lap_metadata_unavailable");
        }
      });
    }
  }

  private upsertParticipant(
    state: BuilderState,
    event: RaceEvent,
    available: boolean,
  ): ParticipantState {
    const key = participantKey(event.sessionId, event.participantId);
    const existing = state.participants.get(key);
    if (existing) {
      existing.available = available;
      existing.participantKind = event.participantKind ?? existing.participantKind;
      existing.driverId = event.driverId ?? existing.driverId;
      existing.teamId = event.teamId ?? existing.teamId;
      return existing;
    }
    const participant: ParticipantState = {
      sessionId: event.sessionId,
      participantId: event.participantId,
      participantKind: event.participantKind,
      driverId: event.driverId,
      teamId: event.teamId,
      classId: null,
      available,
    };
    state.participants.set(key, participant);
    return participant;
  }

  private openAll(
    state: BuilderState,
    participant: ParticipantState,
    event: RaceEvent,
    reason: SessionRunBoundaryReason,
    qualityFlags: readonly string[],
  ): void {
    for (const kind of RUN_KINDS) {
      this.openAccumulator(state, participant, event, kind, reason, qualityFlags);
    }
  }

  private openAccumulator(
    state: BuilderState,
    participant: ParticipantState,
    event: RaceEvent,
    runKind: SessionRunKind,
    reason: SessionRunBoundaryReason,
    qualityFlags: readonly string[],
    supporting: readonly RaceEventId[] = [],
  ): void {
    const key = accumulatorKey(
      participant.sessionId,
      participant.participantId,
      event.timelineEpoch,
      runKind,
    );
    if (state.accumulators.has(key)) return;
    const runId = sessionRunId({
      sessionId: participant.sessionId,
      participantId: participant.participantId,
      runKind,
      timelineEpoch: event.timelineEpoch,
      openingEventId: event.eventId,
    });
    const phase = state.phases.get(event.sessionId) ?? this.phaseFromEvent(event) ?? "unknown";
    const pendingKey = pendingEvidenceKey(
      participant.sessionId,
      participant.participantId,
      runKind,
    );
    const carriedEvidence = state.pendingEvidence.get(pendingKey) ?? [];
    state.pendingEvidence.delete(pendingKey);
    const tire = state.tireState.get(
      participantKey(participant.sessionId, participant.participantId),
    );
    const evidence = [
      { eventId: event.eventId, role: "opening" as const },
      ...carriedEvidence.map((eventId) => ({
        eventId,
        role: "supporting" as const,
      })),
      ...supporting.map((eventId) => ({
        eventId,
        role: "supporting" as const,
      })),
    ];
    state.accumulators.set(key, {
      open: {
        runId,
        schemaVersion: SESSION_RUN_SCHEMA_VERSION,
        algorithmVersion: SESSION_RUN_ALGORITHM_VERSION,
        sessionId: participant.sessionId,
        participantId: participant.participantId,
        participantKind: participant.participantKind,
        driverId: runKind === "driver" ? participant.driverId : participant.driverId,
        teamId: participant.teamId,
        classId: participant.classId,
        runKind,
        openingPhase: phase,
        observedPhases: [phase],
        timelineEpoch: event.timelineEpoch,
        openingSequence: event.sequence,
        openingEventOrder: event.eventOrder,
        openingBoundary: boundary(reason, event),
        startLapEventId: null,
        endLapEventId: null,
        startLapId: null,
        endLapId: null,
        startSourceTimeMs: null,
        endSourceTimeMs: null,
        startTrackDistanceM: null,
        endTrackDistanceM: null,
        startTrackDistancePct: null,
        endTrackDistancePct: null,
        tireCompound: tire?.compound ?? null,
        tireSetId: tire?.setId ?? null,
        sourceGeneration: event.sourceGeneration,
        analysisGenerationId: event.analysisGenerationId,
        qualityFlags: [...qualityFlags],
        evidenceEventIds: evidence.map(({ eventId }) => eventId),
        lapEventIds: [],
        hasContent: false,
      },
      laps: [],
      evidence,
      firstContentEvent: null,
      lastContentEvent: null,
    });
  }

  private closeAccumulator(
    state: BuilderState,
    artifacts: PreparedArtifacts,
    key: string,
    accumulator: RunAccumulator,
    reason: SessionRunBoundaryReason,
    event: RaceEvent | null,
    supporting: readonly RaceEventId[],
  ): void {
    state.accumulators.delete(key);
    const pendingKey = pendingEvidenceKey(
      accumulator.open.sessionId,
      accumulator.open.participantId,
      accumulator.open.runKind,
    );
    if (!accumulator.open.hasContent) {
      const pending = state.pendingEvidence.get(pendingKey) ?? [];
      for (const evidence of accumulator.evidence) addUnique(pending, evidence.eventId);
      if (event) addUnique(pending, event.eventId);
      for (const eventId of supporting) addUnique(pending, eventId);
      state.pendingEvidence.set(pendingKey, pending);
      return;
    }

    const closingRole: SessionRunEvidenceRole =
      reason === "tire_service" ||
      reason === "fuel_service" ||
      reason === "repair_service" ||
      reason === "driver_changed" ||
      reason === "driver_started"
        ? "service"
        : "closing";
    if (event) {
      accumulator.evidence.push({ eventId: event.eventId, role: closingRole });
    }
    for (const eventId of supporting) {
      accumulator.evidence.push({ eventId, role: "supporting" });
    }
    const firstLap = accumulator.laps[0] ?? null;
    const lastLap = accumulator.laps.at(-1) ?? null;
    const summary = deriveSessionRunSummary({
      runId: accumulator.open.runId,
      runKind: accumulator.open.runKind,
      laps: accumulator.laps,
      membershipCount: accumulator.open.lapEventIds.length,
      qualityLimitations: accumulator.open.qualityFlags,
    });
    const createdAt = event?.createdAt ?? accumulator.open.openingBoundary.eventId
      ? (event?.createdAt ?? "1970-01-01T00:00:00.000Z")
      : "1970-01-01T00:00:00.000Z";
    const runWithoutHash: Omit<SessionRun, "contentHash" | "createdAt"> = {
      runId: accumulator.open.runId,
      schemaVersion: accumulator.open.schemaVersion,
      algorithmVersion: accumulator.open.algorithmVersion,
      sessionId: accumulator.open.sessionId,
      participantId: accumulator.open.participantId,
      participantKind: accumulator.open.participantKind,
      driverId: accumulator.open.driverId,
      teamId: accumulator.open.teamId,
      classId: accumulator.open.classId,
      runKind: accumulator.open.runKind,
      status: INCOMPLETE_REASONS[reason] ? "incomplete" : "complete",
      openingPhase: accumulator.open.openingPhase,
      observedPhases: accumulator.open.observedPhases,
      timelineEpoch: accumulator.open.timelineEpoch,
      openingSequence: accumulator.open.openingSequence,
      openingEventOrder: accumulator.open.openingEventOrder,
      openingBoundary: accumulator.open.openingBoundary,
      closingBoundary: boundary(reason, event),
      startLapEventId: firstLap?.lapEventId ?? null,
      endLapEventId: lastLap?.lapEventId ?? null,
      startLapId: firstLap?.lapId ?? null,
      endLapId: lastLap?.lapId ?? null,
      startSourceTimeMs: accumulator.firstContentEvent?.sourceTimeMs ?? null,
      endSourceTimeMs: accumulator.lastContentEvent?.sourceEndTimeMs ?? accumulator.lastContentEvent?.sourceTimeMs ?? null,
      startTrackDistanceM: accumulator.firstContentEvent?.trackDistanceM ?? null,
      endTrackDistanceM: accumulator.lastContentEvent?.trackDistanceM ?? null,
      startTrackDistancePct: accumulator.firstContentEvent?.trackDistancePct ?? null,
      endTrackDistancePct: accumulator.lastContentEvent?.trackDistancePct ?? null,
      tireCompound: accumulator.open.tireCompound,
      tireSetId: accumulator.open.tireSetId,
      sourceGeneration: accumulator.open.sourceGeneration,
      analysisGenerationId: accumulator.open.analysisGenerationId,
      qualityFlags: [...accumulator.open.qualityFlags].sort(),
      summary,
    };
    const memberships = accumulator.laps.map((lap, ordinal) => ({
      runId: accumulator.open.runId,
      lapEventId: lap.lapEventId,
      lapId: lap.lapId,
      lapNumber: lap.lapNumber,
      ordinal,
      entryEventId: accumulator.open.openingBoundary.eventId,
      exitEventId: event?.eventId ?? null,
    }));
    const evidence = accumulator.evidence.map(({ eventId, role }) => ({
      runId: accumulator.open.runId,
      eventId,
      role,
    }));
    const run: SessionRun = {
      ...runWithoutHash,
      contentHash: sessionRunContentHash({
        run: runWithoutHash,
        memberships,
        evidence,
      }),
      createdAt,
    };
    artifacts.runs.push(run);
    artifacts.memberships.push(...memberships);
    artifacts.evidence.push(...evidence);
  }

  private markContent(accumulator: RunAccumulator, event: RaceEvent): void {
    accumulator.open.hasContent = true;
    accumulator.firstContentEvent ??= event;
    accumulator.lastContentEvent = event;
  }

  private splitKinds(
    state: BuilderState,
    artifacts: PreparedArtifacts,
    participant: ParticipantState,
    event: RaceEvent,
    kinds: readonly SessionRunKind[],
    reason: SessionRunBoundaryReason,
    supportingByKind:
      | Map<SessionRunKind, RaceEventId[]>
      | readonly RaceEventId[]
      | undefined,
  ): void {
    for (const kind of kinds) {
      const key = accumulatorKey(
        participant.sessionId,
        participant.participantId,
        event.timelineEpoch,
        kind,
      );
      const accumulator = state.accumulators.get(key);
      const supporting =
        supportingByKind instanceof Map
          ? (supportingByKind.get(kind) ?? [])
          : (supportingByKind ?? []);
      if (accumulator) {
        this.closeAccumulator(
          state,
          artifacts,
          key,
          accumulator,
          reason,
          event,
          supporting,
        );
      }
      this.openAccumulator(
        state,
        participant,
        event,
        kind,
        reason,
        [],
        supporting,
      );
    }
  }

  private closeParticipant(
    state: BuilderState,
    artifacts: PreparedArtifacts,
    participant: ParticipantState,
    event: RaceEvent,
    reason: SessionRunBoundaryReason,
    reopen: boolean,
    qualityFlags: readonly string[],
  ): void {
    for (const kind of RUN_KINDS) {
      const key = accumulatorKey(
        participant.sessionId,
        participant.participantId,
        event.timelineEpoch,
        kind,
      );
      const accumulator = state.accumulators.get(key);
      if (accumulator) {
        this.closeAccumulator(state, artifacts, key, accumulator, reason, event, []);
      }
      if (reopen && participant.available) {
        this.openAccumulator(
          state,
          participant,
          event,
          kind,
          reason,
          qualityFlags,
        );
      }
    }
  }

  private closeSession(
    state: BuilderState,
    artifacts: PreparedArtifacts,
    event: RaceEvent,
    reason: SessionRunBoundaryReason,
  ): void {
    for (const [key, accumulator] of [...state.accumulators]) {
      if (accumulator.open.sessionId !== event.sessionId) continue;
      this.closeAccumulator(state, artifacts, key, accumulator, reason, event, []);
    }
  }

  private applyPhaseEvent(
    state: BuilderState,
    artifacts: PreparedArtifacts,
    event: RaceEvent,
  ): void {
    const previous = state.phases.get(event.sessionId) ?? "unknown";
    const current = this.phaseFromEvent(event) ?? previous;
    const declaredPrevious =
      event.eventType === "session_phase_changed"
        ? event.payload.previousPhase
        : previous;
    state.phases.set(event.sessionId, current);

    if (current === "checkered" || current === "finished" || current === "inactive") {
      this.closeSession(state, artifacts, event, "session_ended");
      return;
    }
    const cautionPair =
      (declaredPrevious === "green" && current === "caution") ||
      (declaredPrevious === "caution" && current === "green");
    if (cautionPair) {
      this.forEachActiveParticipant(state, event.sessionId, (participant) => {
        this.splitKinds(
          state,
          artifacts,
          participant,
          event,
          ["participant"],
          "session_phase_changed",
          [],
        );
      });
      this.addObservedPhase(state, event.sessionId, current);
      return;
    }
    if (current === "red" && declaredPrevious !== "red") {
      state.awaitingRedRestart.add(event.sessionId);
      this.forEachActiveParticipant(state, event.sessionId, (participant) => {
        this.splitKinds(
          state,
          artifacts,
          participant,
          event,
          ["participant", "tire", "driver"],
          "red_flag_started",
          [],
        );
        const paceKey = accumulatorKey(
          participant.sessionId,
          participant.participantId,
          event.timelineEpoch,
          "pace",
        );
        const pace = state.accumulators.get(paceKey);
        if (pace) {
          this.closeAccumulator(
            state,
            artifacts,
            paceKey,
            pace,
            "red_flag_started",
            event,
            [],
          );
        }
      });
      this.addObservedPhase(state, event.sessionId, current);
      return;
    }
    const redRestart =
      event.eventType === "restart_started" &&
      (declaredPrevious === "red" || state.awaitingRedRestart.has(event.sessionId));
    if (redRestart) {
      this.forEachActiveParticipant(state, event.sessionId, (participant) => {
        if (declaredPrevious === "red") {
          this.splitKinds(
            state,
            artifacts,
            participant,
            event,
            ["participant", "tire", "driver"],
            "red_flag_restart",
            [],
          );
        }
        this.openAccumulator(
          state,
          participant,
          event,
          "pace",
          "red_flag_restart",
          [],
        );
      });
      state.awaitingRedRestart.delete(event.sessionId);
      this.addObservedPhase(state, event.sessionId, "green");
      return;
    }
    if (declaredPrevious === "red" && current === "green") {
      this.forEachActiveParticipant(state, event.sessionId, (participant) => {
        this.splitKinds(
          state,
          artifacts,
          participant,
          event,
          ["participant", "tire", "driver"],
          "red_flag_restart",
          [],
        );
      });
      state.awaitingRedRestart.add(event.sessionId);
      this.addObservedPhase(state, event.sessionId, current);
      return;
    }
    if (current !== declaredPrevious && current !== "unknown") {
      this.forEachActiveParticipant(state, event.sessionId, (participant) => {
        this.splitKinds(
          state,
          artifacts,
          participant,
          event,
          RUN_KINDS,
          "session_phase_changed",
          [],
        );
      });
    }
    this.addObservedPhase(state, event.sessionId, current);
  }

  private phaseFromEvent(event: RaceEvent): RaceSessionPhase | null {
    switch (event.eventType) {
      case "session_started":
      case "session_ended":
      case "session_phase_changed":
        return event.payload.phase;
      case "green_flag":
      case "caution_ended":
      case "restart_started":
        return "green";
      case "caution_started":
        return "caution";
      case "red_flag_started":
        return "red";
      case "checkered_flag":
        return "checkered";
      default:
        return null;
    }
  }

  private addObservedPhase(
    state: BuilderState,
    sessionId: number,
    phase: RaceSessionPhase,
  ): void {
    for (const accumulator of state.accumulators.values()) {
      if (accumulator.open.sessionId === sessionId) {
        addUnique(accumulator.open.observedPhases, phase);
      }
    }
  }

  private hasAnyAccumulator(
    state: BuilderState,
    participant: ParticipantState,
    timelineEpoch: number,
  ): boolean {
    return RUN_KINDS.some((kind) =>
      state.accumulators.has(
        accumulatorKey(
          participant.sessionId,
          participant.participantId,
          timelineEpoch,
          kind,
        ),
      ),
    );
  }

  private forEachActiveParticipant(
    state: BuilderState,
    sessionId: number,
    callback: (participant: ParticipantState) => void,
  ): void {
    for (const participant of state.participants.values()) {
      if (participant.sessionId === sessionId && participant.available) {
        callback(participant);
      }
    }
  }

  private forEachTargetParticipant(
    state: BuilderState,
    event: RaceEvent,
    callback: (participant: ParticipantState) => void,
  ): void {
    if (SESSION_SCOPED_TYPES[event.eventType] || event.participantId === null) {
      this.forEachActiveParticipant(state, event.sessionId, callback);
      return;
    }
    const participant = state.participants.get(
      participantKey(event.sessionId, event.participantId),
    );
    if (participant?.available) callback(participant);
  }

  private forEachTargetAccumulator(
    state: BuilderState,
    event: RaceEvent,
    callback: (accumulator: RunAccumulator) => void,
  ): void {
    if (SESSION_SCOPED_TYPES[event.eventType]) {
      for (const accumulator of state.accumulators.values()) {
        if (
          accumulator.open.sessionId === event.sessionId &&
          accumulator.open.timelineEpoch === event.timelineEpoch
        ) {
          callback(accumulator);
        }
      }
      return;
    }
    for (const kind of RUN_KINDS) {
      const accumulator = state.accumulators.get(
        accumulatorKey(
          event.sessionId,
          event.participantId,
          event.timelineEpoch,
          kind,
        ),
      );
      if (accumulator) callback(accumulator);
    }
  }
}
