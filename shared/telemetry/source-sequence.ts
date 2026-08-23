import type { TelemetryPacket } from "./types";

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

interface TimestampBoundary {
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
  gapCandidates: PositiveBoundary[] | null;
  hasProvisionalBoundary: boolean;
  provisionalPreviousSequence: number;
  provisionalCurrentSequence: number;
  provisionalPreviousSourceTimeMs: number;
  provisionalCurrentSourceTimeMs: number;
  provisionalPreviousObservationIndex: number;
  provisionalCurrentObservationIndex: number;
  cadenceSamples: number;
  normalStepMax: number;
  positiveStepCounts: Map<number, number>;
  positiveStepCount: number;
  resetPending: boolean;
}

type NativeSequenceFamily =
  | "iracing-session-tick"
  | "kunos-physics"
  | "kunos-graphics"
  | number;

function weightedMedian(counts: ReadonlyMap<number, number>, count: number, fallback: number): number {
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
 * Incremental source-order tracker shared by recording and lap quality.
 * Gap and ordering evidence is materialized during finalization.
 */
export class SourceSequenceTracker {
  private readonly nativeStates = new Map<NativeSequenceFamily, NativeSequenceState>();
  private readonly timestampGapCandidates: TimestampBoundary[] = [];
  /**
   * Packet timestamps establish cadence for every stream. Timestamp-only mode
   * additionally retains gap candidates; native streams use sequence deltas for
   * missing-count inference. Duplicate/out-of-order boundaries remain because
   * exact diagnostics require their anchors.
   */
  private readonly positiveTimestampDeltaCounts = new Map<number, number>();
  private positiveTimestampDeltaCount = 0;
  private timestampCadenceSamples = 0;
  private timestampNormalDeltaMax = 0;
  private hasTimestampProvisionalBoundary = false;
  private timestampProvisionalPreviousSourceTimeMs = 0;
  private timestampProvisionalCurrentSourceTimeMs = 0;
  private timestampProvisionalPreviousObservationIndex = 0;
  private timestampProvisionalCurrentObservationIndex = 0;
  private readonly duplicates: SourceSequenceBoundary[] = [];
  private readonly outOfOrder: SourceSequenceBoundary[] = [];
  private packetCount = 0;
  private lastSourceTimeMs: number | null = null;
  private lastObservationIndex: number | null = null;
  private timestampResetPending = false;

  /**
   * Records packet-native coordinates directly. Normal observations mutate
   * existing state only; boundary and gap records are allocated only for anomalies.
   */
  observe(packet: TelemetryPacket): void {
    const currentObservationIndex = this.packetCount;
    this.packetCount += 1;
    let hasNativeSequence = false;

    const iracing = packet.iracing;
    if (iracing != null && Number.isFinite(iracing.sessionTick)) {
      hasNativeSequence = true;
      this.observeNative(
        "iracing-session-tick",
        iracing.sessionTick,
        packet.TimestampMS,
        currentObservationIndex,
      );
    } else if (packet.gameId === "f1-2025") {
      const f1 = packet.f1;
      const overall = f1?.overallFrameIdentifier;
      const packetId = f1?.packetId;
      if (
        typeof overall === "number" &&
        Number.isFinite(overall) &&
        typeof packetId === "number" &&
        Number.isFinite(packetId)
      ) {
        hasNativeSequence = true;
        this.observeNative(packetId, overall, packet.TimestampMS, currentObservationIndex);
      }
    } else {
      const acc = packet.acc;
      const physics = acc?.physicsPacketId ?? acc?.acEvo?.physicsPacketId;
      if (typeof physics === "number" && Number.isFinite(physics)) {
        hasNativeSequence = true;
        this.observeNative(
          "kunos-physics",
          physics,
          packet.TimestampMS,
          currentObservationIndex,
        );
      } else {
        const graphics = acc?.graphicsPacketId ?? acc?.acEvo?.graphicsPacketId;
        if (typeof graphics === "number" && Number.isFinite(graphics)) {
          hasNativeSequence = true;
          this.observeNative(
            "kunos-graphics",
            graphics,
            packet.TimestampMS,
            currentObservationIndex,
          );
        }
      }
    }

    this.observeTimestamp(
      packet.TimestampMS,
      currentObservationIndex,
      hasNativeSequence,
    );
  }

  private observeTimestamp(
    sourceTimeMs: number,
    currentObservationIndex: number,
    hasNativeSequence: boolean,
  ): void {
    if (this.lastSourceTimeMs == null || this.lastObservationIndex == null) {
      this.lastSourceTimeMs = sourceTimeMs;
      this.lastObservationIndex = currentObservationIndex;
      return;
    }
    if (this.timestampResetPending) {
      this.timestampResetPending = false;
      this.lastSourceTimeMs = sourceTimeMs;
      this.lastObservationIndex = currentObservationIndex;
      return;
    }

    const previousSourceTimeMs = this.lastSourceTimeMs;
    const previousObservationIndex = this.lastObservationIndex;
    const delta = sourceTimeMs - previousSourceTimeMs;
    if (delta <= 0) {
      if (!hasNativeSequence) {
        const boundary: SourceSequenceBoundary = {
          kind: delta === 0 ? "duplicate" : "out-of-order",
          sourceSequenceFamily: null,
          previousSequence: null,
          currentSequence: null,
          previousSourceTimeMs,
          currentSourceTimeMs: sourceTimeMs,
          previousObservationIndex,
          currentObservationIndex,
        };
        (delta === 0 ? this.duplicates : this.outOfOrder).push(boundary);
      }
      return;
    }

    if (
      !hasNativeSequence &&
      this.timestampCadenceSamples > 0 &&
      delta > this.timestampNormalDeltaMax * 1.5
    ) {
      this.timestampGapCandidates.push({
        previousSourceTimeMs,
        currentSourceTimeMs: sourceTimeMs,
        previousObservationIndex,
        currentObservationIndex,
      });
    }
    if (!hasNativeSequence && this.timestampCadenceSamples === 0) {
      this.hasTimestampProvisionalBoundary = true;
      this.timestampProvisionalPreviousSourceTimeMs = previousSourceTimeMs;
      this.timestampProvisionalCurrentSourceTimeMs = sourceTimeMs;
      this.timestampProvisionalPreviousObservationIndex = previousObservationIndex;
      this.timestampProvisionalCurrentObservationIndex = currentObservationIndex;
    } else if (
      !hasNativeSequence &&
      this.hasTimestampProvisionalBoundary &&
      this.timestampProvisionalCurrentSourceTimeMs -
        this.timestampProvisionalPreviousSourceTimeMs >
        delta
    ) {
      this.timestampGapCandidates.push({
        previousSourceTimeMs: this.timestampProvisionalPreviousSourceTimeMs,
        currentSourceTimeMs: this.timestampProvisionalCurrentSourceTimeMs,
        previousObservationIndex: this.timestampProvisionalPreviousObservationIndex,
        currentObservationIndex: this.timestampProvisionalCurrentObservationIndex,
      });
      this.hasTimestampProvisionalBoundary = false;
    }

    this.positiveTimestampDeltaCounts.set(
      delta,
      (this.positiveTimestampDeltaCounts.get(delta) ?? 0) + 1,
    );
    this.positiveTimestampDeltaCount += 1;
    this.timestampNormalDeltaMax =
      this.timestampCadenceSamples === 0
        ? delta
        : Math.min(this.timestampNormalDeltaMax, delta);
    this.timestampCadenceSamples += 1;
    this.lastSourceTimeMs = sourceTimeMs;
    this.lastObservationIndex = currentObservationIndex;
  }

  private observeNative(
    family: NativeSequenceFamily,
    sequence: number,
    sourceTimeMs: number,
    currentObservationIndex: number,
  ): void {
    const previous = this.nativeStates.get(family);
    if (previous == null) {
      this.nativeStates.set(family, {
        lastSequence: sequence,
        lastSourceTimeMs: sourceTimeMs,
        lastObservationIndex: currentObservationIndex,
        gapCandidates: null,
        hasProvisionalBoundary: false,
        provisionalPreviousSequence: 0,
        provisionalCurrentSequence: 0,
        provisionalPreviousSourceTimeMs: 0,
        provisionalCurrentSourceTimeMs: 0,
        provisionalPreviousObservationIndex: 0,
        provisionalCurrentObservationIndex: 0,
        cadenceSamples: 0,
        normalStepMax: 0,
        positiveStepCounts: new Map(),
        positiveStepCount: 0,
        resetPending: false,
      });
      return;
    }
    if (previous.resetPending) {
      previous.resetPending = false;
      previous.lastSequence = sequence;
      previous.lastSourceTimeMs = sourceTimeMs;
      previous.lastObservationIndex = currentObservationIndex;
      return;
    }

    const delta = sequence - previous.lastSequence;
    if (delta <= 0) {
      const boundary: SourceSequenceBoundary = {
        kind: delta === 0 ? "duplicate" : "out-of-order",
        sourceSequenceFamily: this.displayFamily(family),
        previousSequence: previous.lastSequence,
        currentSequence: sequence,
        previousSourceTimeMs: previous.lastSourceTimeMs,
        currentSourceTimeMs: sourceTimeMs,
        previousObservationIndex: previous.lastObservationIndex,
        currentObservationIndex,
      };
      (delta === 0 ? this.duplicates : this.outOfOrder).push(boundary);
      return;
    }
    if (
      previous.cadenceSamples > 0 &&
      delta > previous.normalStepMax * 1.5
    ) {
      (previous.gapCandidates ??= []).push({
        previousSequence: previous.lastSequence,
        currentSequence: sequence,
        previousSourceTimeMs: previous.lastSourceTimeMs,
        currentSourceTimeMs: sourceTimeMs,
        previousObservationIndex: previous.lastObservationIndex,
        currentObservationIndex,
      });
    }
    if (previous.cadenceSamples === 0) {
      previous.hasProvisionalBoundary = true;
      previous.provisionalPreviousSequence = previous.lastSequence;
      previous.provisionalCurrentSequence = sequence;
      previous.provisionalPreviousSourceTimeMs = previous.lastSourceTimeMs;
      previous.provisionalCurrentSourceTimeMs = sourceTimeMs;
      previous.provisionalPreviousObservationIndex = previous.lastObservationIndex;
      previous.provisionalCurrentObservationIndex = currentObservationIndex;
    } else if (
      previous.hasProvisionalBoundary &&
      previous.provisionalCurrentSequence - previous.provisionalPreviousSequence >
        delta
    ) {
      (previous.gapCandidates ??= []).push({
        previousSequence: previous.provisionalPreviousSequence,
        currentSequence: previous.provisionalCurrentSequence,
        previousSourceTimeMs: previous.provisionalPreviousSourceTimeMs,
        currentSourceTimeMs: previous.provisionalCurrentSourceTimeMs,
        previousObservationIndex: previous.provisionalPreviousObservationIndex,
        currentObservationIndex: previous.provisionalCurrentObservationIndex,
      });
      previous.hasProvisionalBoundary = false;
    }
    previous.normalStepMax =
      previous.cadenceSamples === 0
        ? delta
        : Math.min(previous.normalStepMax, delta);
    previous.cadenceSamples += 1;
    previous.positiveStepCounts.set(
      delta,
      (previous.positiveStepCounts.get(delta) ?? 0) + 1,
    );
    previous.positiveStepCount += 1;
    previous.lastSequence = sequence;
    previous.lastSourceTimeMs = sourceTimeMs;
    previous.lastObservationIndex = currentObservationIndex;
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
        if (state.gapCandidates == null) continue;
        const expectedStep = weightedMedian(
          state.positiveStepCounts,
          state.positiveStepCount,
          1,
        );
        for (const boundary of state.gapCandidates) {
          const step = boundary.currentSequence - boundary.previousSequence;
          const inferredMissing = Math.max(
            0,
            Math.round(step / expectedStep) - 1,
          );
          if (inferredMissing === 0) continue;
          const durationMs = Math.max(
            0,
            boundary.currentSourceTimeMs - boundary.previousSourceTimeMs,
          );
          missingCount += inferredMissing;
          largestContiguousGapMs = Math.max(largestContiguousGapMs, durationMs);
          gaps.push({
            sourceSequenceFamily: this.displayFamily(family),
            ...boundary,
            durationMs,
            missingCount: inferredMissing,
            countMethod: "native-sequence",
          });
        }
      }
    } else if (this.positiveTimestampDeltaCount > 0) {
      countMethod = "timestamp-estimate";
      const expectedIntervalMs = weightedMedian(
        this.positiveTimestampDeltaCounts,
        this.positiveTimestampDeltaCount,
        1,
      );
      for (const boundary of this.timestampGapCandidates) {
        const durationMs =
          boundary.currentSourceTimeMs - boundary.previousSourceTimeMs;
        const inferredMissing = Math.max(
          0,
          Math.round(durationMs / expectedIntervalMs) - 1,
        );
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
        totalMissingFraction:
          measured && expectedCount > 0 ? missingCount / expectedCount : null,
        largestContiguousGapMs,
        countMethod,
      },
      gaps,
      duplicates: [...this.duplicates],
      outOfOrder: [...this.outOfOrder],
      inferredIntervalMs:
        this.positiveTimestampDeltaCount > 0
          ? weightedMedian(
              this.positiveTimestampDeltaCounts,
              this.positiveTimestampDeltaCount,
              1,
            )
          : null,
    };
  }

  private displayFamily(family: NativeSequenceFamily): string {
    return typeof family === "number" ? `f1-packet-${family}` : family;
  }
}
