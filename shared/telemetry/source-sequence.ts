import type { TelemetryPacket } from "./types";

export interface SourceSequenceObservation {
  family: string;
  sequence: number;
}

export type SourceSequenceBoundaryKind = "duplicate" | "out-of-order";
export type SourceSequenceCountMethod = "native-sequence" | "timestamp-estimate" | "unavailable";

export interface SourceSequenceBoundary {
  kind: SourceSequenceBoundaryKind;
  sourceSequenceFamily: string | null;
  previousSequence: number | null;
  currentSequence: number | null;
  previousSourceTimeMs: number;
  currentSourceTimeMs: number;
  previousObservationIndex: number;
  currentObservationIndex: number;
}

export interface SourceSequenceGapBoundary {
  sourceSequenceFamily: string | null;
  previousSequence: number | null;
  currentSequence: number | null;
  previousSourceTimeMs: number;
  currentSourceTimeMs: number;
  previousObservationIndex: number;
  currentObservationIndex: number;
  durationMs: number;
  missingCount: number;
  countMethod: Exclude<SourceSequenceCountMethod, "unavailable">;
}
/** A non-normal forward boundary whose timeline anchors must survive finalize. */
export interface SourceSequenceGapCandidate {
  sourceSequenceFamily: string | null;
  previousSequence: number | null;
  currentSequence: number | null;
  previousSourceTimeMs: number;
  currentSourceTimeMs: number;
  previousObservationIndex: number;
  currentObservationIndex: number;
}


export interface SourceSequenceObserveResult {
  sourceSequences: SourceSequenceObservation[];
  boundaries: SourceSequenceBoundary[];
  gapCandidates?: SourceSequenceGapCandidate[];
}

export interface SourceSequenceSummary {
  expectedCount: number;
  observedCount: number;
  totalMissingCount: number | null;
  totalMissingFraction: number | null;
  largestContiguousGapMs: number;
  countMethod: SourceSequenceCountMethod;
}

export interface SourceSequenceFinalized {
  summary: SourceSequenceSummary;
  gaps: SourceSequenceGapBoundary[];
  duplicates: SourceSequenceBoundary[];
  outOfOrder: SourceSequenceBoundary[];
  inferredIntervalMs: number | null;
}

interface PositiveBoundary {
  previousSequence: number;
  currentSequence: number;
  previousSourceTimeMs: number;
  currentSourceTimeMs: number;
  previousObservationIndex: number;
  currentObservationIndex: number;
}

interface NativeSequenceState {
  lastSequence: number;
  lastSourceTimeMs: number;
  lastObservationIndex: number;
  /**
   * First positive step establishes normal cadence. Only later deviations retain
   * anchors; contiguous streams retain high-water plus step frequencies.
   */
  gapCandidates: PositiveBoundary[];
  provisionalBoundary: PositiveBoundary | null;
  cadenceSamples: number;
  normalStepMax: number;
  positiveStepCounts: Map<number, number>;
  positiveStepCount: number;
  resetPending: boolean;
}

interface TimestampBoundary {
  previousSourceTimeMs: number;
  currentSourceTimeMs: number;
  previousObservationIndex: number;
  currentObservationIndex: number;
}


interface NativeSequenceRollback {
  family: string;
  state: NativeSequenceState | null;
  lastSequence: number;
  lastSourceTimeMs: number;
  lastObservationIndex: number;
  gapCandidateLength: number;
  provisionalBoundary: PositiveBoundary | null;
  cadenceSamples: number;
  normalStepMax: number;
  positiveStepCount: number;
  resetPending: boolean;
  positiveStep: number | null;
  positiveStepOccurrences: number | undefined;
}

/** Opaque token for reverting one uncommitted observation. */
export type SourceSequenceCheckpoint = number;
/** Native packet coordinate(s) used consistently by quality and event code. */
export function packetSequences(packet: TelemetryPacket): SourceSequenceObservation[] {
  if (packet.iracing && Number.isFinite(packet.iracing.sessionTick)) {
    return [
      {
        family: "iracing-session-tick",
        sequence: packet.iracing.sessionTick,
      },
    ];
  }
  if (packet.gameId === "f1-2025") {
    const overall = packet.f1?.overallFrameIdentifier;
    const packetId = packet.f1?.packetId;
    return typeof overall === "number" && Number.isFinite(overall) && typeof packetId === "number" && Number.isFinite(packetId) ? [{ family: `f1-packet-${packetId}`, sequence: overall }] : [];
  }
  const physics = packet.acc?.physicsPacketId ?? packet.acc?.acEvo?.physicsPacketId;
  if (typeof physics === "number" && Number.isFinite(physics)) {
    return [{ family: "kunos-physics", sequence: physics }];
  }
  const graphics = packet.acc?.graphicsPacketId ?? packet.acc?.acEvo?.graphicsPacketId;
  return typeof graphics === "number" && Number.isFinite(graphics) ? [{ family: "kunos-graphics", sequence: graphics }] : [];
}

export function weightedMedian(counts: ReadonlyMap<number, number>, count: number, fallback: number): number {
  if (count <= 0) return fallback;
  const lowerIndex = Math.floor((count - 1) / 2);
  const upperIndex = Math.floor(count / 2);
  let seen = 0;
  let lower = fallback;
  let upper = fallback;
  for (const [value, occurrences] of [...counts].sort(([left], [right]) => left - right)) {
    const end = seen + occurrences;
    if (seen <= lowerIndex && lowerIndex < end) lower = value;
    if (seen <= upperIndex && upperIndex < end) {
      upper = value;
      break;
    }
    seen = end;
  }
  return (lower + upper) / 2;
}

/**
 * Incremental source-order tracker shared by recording quality and the race
 * event timeline. Duplicate/out-of-order boundaries are available immediately;
 * gap inference waits for final cadence/step medians.
 */
export class SourceSequenceTracker {
  private readonly nativeStates = new Map<string, NativeSequenceState>();
  private readonly timestampGapCandidates: TimestampBoundary[] = [];
  /**
   * Timestamp-only mode establishes first positive cadence and retains later
   * deviations, never one boundary per normal packet. Duplicate/out-of-order
   * boundaries remain because exact diagnostics require their anchors.
   */
  private readonly positiveTimestampDeltaCounts = new Map<number, number>();
  private positiveTimestampDeltaCount = 0;
  private timestampCadenceSamples = 0;
  private timestampNormalDeltaMax = 0;
  private timestampProvisionalBoundary: TimestampBoundary | null = null;
  private readonly duplicates: SourceSequenceBoundary[] = [];
  private readonly outOfOrder: SourceSequenceBoundary[] = [];
  private packetCount = 0;
  private lastSourceTimeMs: number | null = null;
  private lastObservationIndex: number | null = null;
  private timestampResetPending = false;
  private rollbackToken = 0;
  private rollbackActiveToken = 0;
  private rollbackPacketCount = 0;
  private rollbackLastSourceTimeMs: number | null = null;
  private rollbackLastObservationIndex: number | null = null;
  private rollbackTimestampResetPending = false;
  private rollbackTimestampCadenceSamples = 0;
  private rollbackTimestampNormalDeltaMax = 0;
  private rollbackPositiveTimestampDeltaCount = 0;
  private rollbackTimestampProvisionalBoundary: TimestampBoundary | null = null;
  private rollbackTimestampGapCandidateLength = 0;
  private rollbackDuplicateLength = 0;
  private rollbackOutOfOrderLength = 0;
  private rollbackTimestampPositiveDelta: number | null = null;
  private rollbackTimestampPositiveDeltaOccurrences: number | undefined;
  private readonly rollbackNativeStates: NativeSequenceRollback[] = [];
  private rollbackNativeStateCount = 0;

  /**
   * Opens one allocation-free rollback window. Call `rollback` only if its
   * observation cannot be committed; a later checkpoint supersedes this token.
   */
  checkpoint(): SourceSequenceCheckpoint {
    const token = ++this.rollbackToken;
    this.rollbackActiveToken = token;
    this.rollbackPacketCount = this.packetCount;
    this.rollbackLastSourceTimeMs = this.lastSourceTimeMs;
    this.rollbackLastObservationIndex = this.lastObservationIndex;
    this.rollbackTimestampResetPending = this.timestampResetPending;
    this.rollbackTimestampCadenceSamples = this.timestampCadenceSamples;
    this.rollbackTimestampNormalDeltaMax = this.timestampNormalDeltaMax;
    this.rollbackPositiveTimestampDeltaCount = this.positiveTimestampDeltaCount;
    this.rollbackTimestampProvisionalBoundary = this.timestampProvisionalBoundary;
    this.rollbackTimestampGapCandidateLength = this.timestampGapCandidates.length;
    this.rollbackDuplicateLength = this.duplicates.length;
    this.rollbackOutOfOrderLength = this.outOfOrder.length;
    this.rollbackTimestampPositiveDelta = null;
    this.rollbackTimestampPositiveDeltaOccurrences = undefined;
    this.rollbackNativeStateCount = 0;
    return token;
  }

  /** Seal an observation after every downstream consumer accepts it. */
  commit(checkpoint: SourceSequenceCheckpoint): void {
    if (checkpoint !== this.rollbackActiveToken) {
      throw new Error("Source-sequence checkpoint is no longer active");
    }
    this.rollbackActiveToken = 0;
  }

  /** Restore all sequence evidence and high-water state from `checkpoint`. */
  rollback(checkpoint: SourceSequenceCheckpoint): void {
    if (checkpoint !== this.rollbackActiveToken) {
      throw new Error("Source-sequence checkpoint is no longer active");
    }
    this.packetCount = this.rollbackPacketCount;
    this.lastSourceTimeMs = this.rollbackLastSourceTimeMs;
    this.lastObservationIndex = this.rollbackLastObservationIndex;
    this.timestampResetPending = this.rollbackTimestampResetPending;
    this.timestampCadenceSamples = this.rollbackTimestampCadenceSamples;
    this.timestampNormalDeltaMax = this.rollbackTimestampNormalDeltaMax;
    this.positiveTimestampDeltaCount = this.rollbackPositiveTimestampDeltaCount;
    this.timestampProvisionalBoundary = this.rollbackTimestampProvisionalBoundary;
    this.timestampGapCandidates.length = this.rollbackTimestampGapCandidateLength;
    this.duplicates.length = this.rollbackDuplicateLength;
    this.outOfOrder.length = this.rollbackOutOfOrderLength;
    if (this.rollbackTimestampPositiveDelta != null) {
      if (this.rollbackTimestampPositiveDeltaOccurrences == null) {
        this.positiveTimestampDeltaCounts.delete(this.rollbackTimestampPositiveDelta);
      } else {
        this.positiveTimestampDeltaCounts.set(this.rollbackTimestampPositiveDelta, this.rollbackTimestampPositiveDeltaOccurrences);
      }
    }
    for (let index = this.rollbackNativeStateCount - 1; index >= 0; index -= 1) {
      const rollback = this.rollbackNativeStates[index]!;
      if (rollback.state == null) {
        this.nativeStates.delete(rollback.family);
        continue;
      }
      const state = rollback.state;
      state.lastSequence = rollback.lastSequence;
      state.lastSourceTimeMs = rollback.lastSourceTimeMs;
      state.lastObservationIndex = rollback.lastObservationIndex;
      state.gapCandidates.length = rollback.gapCandidateLength;
      state.provisionalBoundary = rollback.provisionalBoundary;
      state.cadenceSamples = rollback.cadenceSamples;
      state.normalStepMax = rollback.normalStepMax;
      state.positiveStepCount = rollback.positiveStepCount;
      state.resetPending = rollback.resetPending;
      if (rollback.positiveStep != null) {
        if (rollback.positiveStepOccurrences == null) {
          state.positiveStepCounts.delete(rollback.positiveStep);
        } else {
          state.positiveStepCounts.set(rollback.positiveStep, rollback.positiveStepOccurrences);
        }
      }
    }
    this.rollbackActiveToken = 0;
  }

  private checkpointNativeState(family: string, state: NativeSequenceState | undefined): NativeSequenceRollback | null {
    if (this.rollbackActiveToken === 0) return null;
    for (let index = 0; index < this.rollbackNativeStateCount; index += 1) {
      const rollback = this.rollbackNativeStates[index]!;
      if (rollback.family === family) return rollback;
    }
    const rollback = this.rollbackNativeStates[this.rollbackNativeStateCount++] ?? {
      family,
      state: null,
      lastSequence: 0,
      lastSourceTimeMs: 0,
      lastObservationIndex: 0,
      gapCandidateLength: 0,
      provisionalBoundary: null,
      cadenceSamples: 0,
      normalStepMax: 0,
      positiveStepCount: 0,
      resetPending: false,
      positiveStep: null,
      positiveStepOccurrences: undefined,
    };
    rollback.family = family;
    rollback.state = state ?? null;
    rollback.lastSequence = state?.lastSequence ?? 0;
    rollback.lastSourceTimeMs = state?.lastSourceTimeMs ?? 0;
    rollback.lastObservationIndex = state?.lastObservationIndex ?? 0;
    rollback.gapCandidateLength = state?.gapCandidates.length ?? 0;
    rollback.provisionalBoundary = state?.provisionalBoundary ?? null;
    rollback.cadenceSamples = state?.cadenceSamples ?? 0;
    rollback.normalStepMax = state?.normalStepMax ?? 0;
    rollback.positiveStepCount = state?.positiveStepCount ?? 0;
    rollback.resetPending = state?.resetPending ?? false;
    rollback.positiveStep = null;
    rollback.positiveStepOccurrences = undefined;
    this.rollbackNativeStates[this.rollbackNativeStateCount - 1] = rollback;
    return rollback;
  }

  observe(packet: TelemetryPacket, sourceSequences: SourceSequenceObservation[] = packetSequences(packet)): SourceSequenceObserveResult {
    const currentObservationIndex = this.packetCount;
    this.packetCount += 1;
    let gapCandidates: SourceSequenceGapCandidate[] | undefined;
    const boundaries: SourceSequenceBoundary[] = [];

    if (this.lastSourceTimeMs != null && this.lastObservationIndex != null) {
      if (this.timestampResetPending) {
        this.timestampResetPending = false;
        this.lastSourceTimeMs = packet.TimestampMS;
        this.lastObservationIndex = currentObservationIndex;
      } else {
        const delta = packet.TimestampMS - this.lastSourceTimeMs;
        if (delta > 0) {
          if (
            sourceSequences.length === 0 &&
            this.timestampCadenceSamples > 0 &&
            delta > this.timestampNormalDeltaMax * 1.5
          ) {
            const candidate = {
              sourceSequenceFamily: null,
              previousSequence: null,
              currentSequence: null,
              previousSourceTimeMs: this.lastSourceTimeMs,
              currentSourceTimeMs: packet.TimestampMS,
              previousObservationIndex: this.lastObservationIndex,
              currentObservationIndex,
            };
            this.timestampGapCandidates.push(candidate);
            (gapCandidates ??= []).push(candidate);
          }
          if (sourceSequences.length === 0 && this.timestampCadenceSamples === 0) {
            this.timestampProvisionalBoundary = {
              previousSourceTimeMs: this.lastSourceTimeMs,
              currentSourceTimeMs: packet.TimestampMS,
              previousObservationIndex: this.lastObservationIndex,
              currentObservationIndex,
            };
            (gapCandidates ??= []).push({
              sourceSequenceFamily: null,
              previousSequence: null,
              currentSequence: null,
              ...this.timestampProvisionalBoundary,
            });
          } else if (
            sourceSequences.length === 0 &&
            this.timestampProvisionalBoundary != null &&
            this.timestampProvisionalBoundary.currentSourceTimeMs -
              this.timestampProvisionalBoundary.previousSourceTimeMs >
              delta
          ) {
            this.timestampGapCandidates.push(this.timestampProvisionalBoundary);
            (gapCandidates ??= []).push({
              sourceSequenceFamily: null,
              previousSequence: null,
              currentSequence: null,
              ...this.timestampProvisionalBoundary,
            });
            this.timestampProvisionalBoundary = null;
          }
          this.rollbackTimestampPositiveDelta = delta;
          this.rollbackTimestampPositiveDeltaOccurrences = this.positiveTimestampDeltaCounts.get(delta);
          this.positiveTimestampDeltaCounts.set(delta, (this.rollbackTimestampPositiveDeltaOccurrences ?? 0) + 1);
          this.positiveTimestampDeltaCount += 1;
          this.timestampNormalDeltaMax =
            this.timestampCadenceSamples === 0
              ? delta
              : Math.min(this.timestampNormalDeltaMax, delta);
          this.timestampCadenceSamples += 1;
          this.lastSourceTimeMs = packet.TimestampMS;
          this.lastObservationIndex = currentObservationIndex;
        } else if (sourceSequences.length === 0) {
          const boundary: SourceSequenceBoundary = {
            kind: delta === 0 ? "duplicate" : "out-of-order",
            sourceSequenceFamily: null,
            previousSequence: null,
            currentSequence: null,
            previousSourceTimeMs: this.lastSourceTimeMs,
            currentSourceTimeMs: packet.TimestampMS,
            previousObservationIndex: this.lastObservationIndex,
            currentObservationIndex,
          };
          boundaries.push(boundary);
          (delta === 0 ? this.duplicates : this.outOfOrder).push(boundary);
        }
      }
    } else {
      this.lastSourceTimeMs = packet.TimestampMS;
      this.lastObservationIndex = currentObservationIndex;
    }

    for (const observation of sourceSequences) {
      const previous = this.nativeStates.get(observation.family);
      const rollback = this.checkpointNativeState(observation.family, previous);
      if (!previous) {
        this.nativeStates.set(observation.family, {
          lastSequence: observation.sequence,
          lastSourceTimeMs: packet.TimestampMS,
          lastObservationIndex: currentObservationIndex,
          gapCandidates: [],
          cadenceSamples: 0,
          normalStepMax: 0,
          positiveStepCounts: new Map(),
          provisionalBoundary: null,
          positiveStepCount: 0,
          resetPending: false,
        });
        continue;
      }
      if (previous.resetPending) {
        previous.resetPending = false;
        previous.lastSequence = observation.sequence;
        previous.lastSourceTimeMs = packet.TimestampMS;
        previous.lastObservationIndex = currentObservationIndex;
        continue;
      }
      const delta = observation.sequence - previous.lastSequence;
      if (delta <= 0) {
        const boundary: SourceSequenceBoundary = {
          kind: delta === 0 ? "duplicate" : "out-of-order",
          sourceSequenceFamily: observation.family,
          previousSequence: previous.lastSequence,
          currentSequence: observation.sequence,
          previousSourceTimeMs: previous.lastSourceTimeMs,
          currentSourceTimeMs: packet.TimestampMS,
          previousObservationIndex: previous.lastObservationIndex,
          currentObservationIndex,
        };
        boundaries.push(boundary);
        (delta === 0 ? this.duplicates : this.outOfOrder).push(boundary);
        continue;
      }
      if (
        previous.cadenceSamples > 0 &&
        delta > previous.normalStepMax * 1.5
      ) {
        const candidate = {
          sourceSequenceFamily: observation.family,
          previousSequence: previous.lastSequence,
          currentSequence: observation.sequence,
          previousSourceTimeMs: previous.lastSourceTimeMs,
          currentSourceTimeMs: packet.TimestampMS,
          previousObservationIndex: previous.lastObservationIndex,
          currentObservationIndex,
        };
        previous.gapCandidates.push(candidate);
        (gapCandidates ??= []).push(candidate);
      }
      if (previous.cadenceSamples === 0) {
        previous.provisionalBoundary = {
          previousSequence: previous.lastSequence,
          currentSequence: observation.sequence,
          previousSourceTimeMs: previous.lastSourceTimeMs,
          currentSourceTimeMs: packet.TimestampMS,
          previousObservationIndex: previous.lastObservationIndex,
          currentObservationIndex,
        };
        (gapCandidates ??= []).push({
          sourceSequenceFamily: observation.family,
          ...previous.provisionalBoundary,
        });
      } else if (
        previous.provisionalBoundary != null &&
        previous.provisionalBoundary.currentSequence -
          previous.provisionalBoundary.previousSequence >
          delta
      ) {
        previous.gapCandidates.push(previous.provisionalBoundary);
        (gapCandidates ??= []).push({
          sourceSequenceFamily: observation.family,
          ...previous.provisionalBoundary,
        });
        previous.provisionalBoundary = null;
      }
      previous.normalStepMax =
        previous.cadenceSamples === 0
          ? delta
          : Math.min(previous.normalStepMax, delta);
      previous.cadenceSamples += 1;
      if (rollback != null) {
        rollback.positiveStep = delta;
        rollback.positiveStepOccurrences = previous.positiveStepCounts.get(delta);
      }
      previous.positiveStepCounts.set(delta, (rollback?.positiveStepOccurrences ?? previous.positiveStepCounts.get(delta) ?? 0) + 1);
      previous.positiveStepCount += 1;
      previous.lastSequence = observation.sequence;
      previous.lastSourceTimeMs = packet.TimestampMS;
      previous.lastObservationIndex = currentObservationIndex;
    }

    return gapCandidates == null
      ? { sourceSequences, boundaries }
      : { sourceSequences, boundaries, gapCandidates };
  }

  /** Reconnect/timebase boundaries seed the next observation in each family. */
  markDiscontinuity(): void {
    for (const state of this.nativeStates.values()) state.resetPending = true;
    this.timestampResetPending = true;
  }

  finalize(): SourceSequenceFinalized {
    const gaps: SourceSequenceGapBoundary[] = [];
    let missingCount = 0;
    let largestContiguousGapMs = 0;
    let countMethod: SourceSequenceCountMethod = "unavailable";
    const hasNativeCadence = [...this.nativeStates.values()].some(({ positiveStepCount }) => positiveStepCount > 0);

    if (hasNativeCadence) {
      countMethod = "native-sequence";
      for (const [family, state] of this.nativeStates) {
        if (state.positiveStepCount === 0) continue;

        const expectedStep = weightedMedian(state.positiveStepCounts, state.positiveStepCount, 1);
        for (const boundary of state.gapCandidates) {
          const step = boundary.currentSequence - boundary.previousSequence;
          const inferredMissing = Math.max(0, Math.round(step / expectedStep) - 1);
          if (inferredMissing === 0) continue;
          const durationMs = Math.max(0, boundary.currentSourceTimeMs - boundary.previousSourceTimeMs);
          missingCount += inferredMissing;
          largestContiguousGapMs = Math.max(largestContiguousGapMs, durationMs);
          gaps.push({
            sourceSequenceFamily: family,
            ...boundary,
            durationMs,
            missingCount: inferredMissing,
            countMethod: "native-sequence",
          });
        }
      }
    } else if (this.nativeStates.size === 0 && this.positiveTimestampDeltaCount > 0) {
      countMethod = "timestamp-estimate";
      const expectedIntervalMs = weightedMedian(this.positiveTimestampDeltaCounts, this.positiveTimestampDeltaCount, 1);
      for (const boundary of this.timestampGapCandidates) {
        const durationMs = boundary.currentSourceTimeMs - boundary.previousSourceTimeMs;
        const inferredMissing = Math.max(0, Math.round(durationMs / expectedIntervalMs) - 1);
        if (inferredMissing === 0) continue;
        missingCount += inferredMissing;
        largestContiguousGapMs = Math.max(largestContiguousGapMs, durationMs);
        gaps.push({
          sourceSequenceFamily: null,
          previousSequence: null,
          currentSequence: null,
          ...boundary,
          durationMs,
          missingCount: inferredMissing,
          countMethod: "timestamp-estimate",
        });
      }
    }

    const measured = countMethod !== "unavailable";
    const expectedCount = this.packetCount + missingCount;
    return {
      summary: {
        expectedCount,
        observedCount: this.packetCount,
        totalMissingCount: measured ? missingCount : null,
        totalMissingFraction: measured && expectedCount > 0 ? missingCount / expectedCount : null,
        largestContiguousGapMs,
        countMethod,
      },
      gaps,
      duplicates: [...this.duplicates],
      outOfOrder: [...this.outOfOrder],
      inferredIntervalMs: this.positiveTimestampDeltaCount > 0 ? weightedMedian(this.positiveTimestampDeltaCounts, this.positiveTimestampDeltaCount, 1) : null,
    };
  }
}
