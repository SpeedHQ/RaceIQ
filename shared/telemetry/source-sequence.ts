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

export interface SourceSequenceObserveResult {
  sourceSequences: SourceSequenceObservation[];
  boundaries: SourceSequenceBoundary[];
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
  positiveBoundaries: PositiveBoundary[];
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
  private readonly timestampBoundaries: TimestampBoundary[] = [];
  private readonly positiveTimestampDeltaCounts = new Map<number, number>();
  private positiveTimestampDeltaCount = 0;
  private readonly duplicates: SourceSequenceBoundary[] = [];
  private readonly outOfOrder: SourceSequenceBoundary[] = [];
  private packetCount = 0;
  private lastSourceTimeMs: number | null = null;
  private lastObservationIndex: number | null = null;
  private timestampResetPending = false;

  observe(packet: TelemetryPacket): SourceSequenceObserveResult {
    const currentObservationIndex = this.packetCount;
    this.packetCount += 1;
    const sourceSequences = packetSequences(packet);
    const boundaries: SourceSequenceBoundary[] = [];

    if (this.lastSourceTimeMs != null && this.lastObservationIndex != null) {
      if (this.timestampResetPending) {
        this.timestampResetPending = false;
      } else {
        const delta = packet.TimestampMS - this.lastSourceTimeMs;
        if (delta > 0) {
          this.timestampBoundaries.push({
            previousSourceTimeMs: this.lastSourceTimeMs,
            currentSourceTimeMs: packet.TimestampMS,
            previousObservationIndex: this.lastObservationIndex,
            currentObservationIndex,
          });
          this.positiveTimestampDeltaCounts.set(delta, (this.positiveTimestampDeltaCounts.get(delta) ?? 0) + 1);
          this.positiveTimestampDeltaCount += 1;
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
    }
    this.lastSourceTimeMs = packet.TimestampMS;
    this.lastObservationIndex = currentObservationIndex;

    for (const observation of sourceSequences) {
      const previous = this.nativeStates.get(observation.family);
      if (!previous) {
        this.nativeStates.set(observation.family, {
          lastSequence: observation.sequence,
          lastSourceTimeMs: packet.TimestampMS,
          lastObservationIndex: currentObservationIndex,
          positiveBoundaries: [],
          positiveStepCounts: new Map(),
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
      previous.positiveBoundaries.push({
        previousSequence: previous.lastSequence,
        currentSequence: observation.sequence,
        previousSourceTimeMs: previous.lastSourceTimeMs,
        currentSourceTimeMs: packet.TimestampMS,
        previousObservationIndex: previous.lastObservationIndex,
        currentObservationIndex,
      });
      previous.positiveStepCounts.set(delta, (previous.positiveStepCounts.get(delta) ?? 0) + 1);
      previous.positiveStepCount += 1;
      previous.lastSequence = observation.sequence;
      previous.lastSourceTimeMs = packet.TimestampMS;
      previous.lastObservationIndex = currentObservationIndex;
    }

    return { sourceSequences, boundaries };
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

    if (this.nativeStates.size > 0) {
      countMethod = "native-sequence";
      for (const [family, state] of this.nativeStates) {
        if (state.positiveStepCount === 0) continue;
        const expectedStep = weightedMedian(state.positiveStepCounts, state.positiveStepCount, 1);
        for (const boundary of state.positiveBoundaries) {
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
    } else if (this.positiveTimestampDeltaCount > 0) {
      countMethod = "timestamp-estimate";
      const expectedIntervalMs = weightedMedian(this.positiveTimestampDeltaCounts, this.positiveTimestampDeltaCount, 1);
      for (const boundary of this.timestampBoundaries) {
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
