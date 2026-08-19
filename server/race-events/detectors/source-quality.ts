import type {
  SourceLifecycleEvidence,
} from "../../../shared/racing/quality/contracts";
import type {
  SourceSequenceBoundary,
  SourceSequenceFinalized,
  SourceSequenceGapBoundary,
} from "../../../shared/telemetry/source-sequence";
import {
  EVENT_ORDER_PRIORITY,
  type DetectorContext,
  type DetectorEventDraft,
} from "../types";

export const SOURCE_QUALITY_DETECTOR_ID = "source-quality";
export const SOURCE_QUALITY_DETECTOR_VERSION = "1";

function boundaryDraft(
  _context: DetectorContext,
  boundary: SourceSequenceBoundary,
): DetectorEventDraft {
  const eventType =
    boundary.kind === "duplicate"
      ? "duplicate_input_suppressed"
      : "out_of_order_input";
  return {
    eventType,
    payload: {
      sourceSequenceFamily: boundary.sourceSequenceFamily,
      previousSequence: boundary.previousSequence,
      currentSequence: boundary.currentSequence,
    },
    detectorId: SOURCE_QUALITY_DETECTOR_ID,
    detectorVersion: SOURCE_QUALITY_DETECTOR_VERSION,
    priority: EVENT_ORDER_PRIORITY.sourceQuality,
    boundaryKey: [
      boundary.sourceSequenceFamily ?? "source-time",
      boundary.previousSequence ?? boundary.previousSourceTimeMs,
      boundary.currentSequence ?? boundary.currentSourceTimeMs,
      boundary.previousObservationIndex,
      boundary.currentObservationIndex,
      eventType,
    ].join(":"),
    sourceTimeMs: boundary.currentSourceTimeMs,
    sourceEndTimeMs: boundary.currentSourceTimeMs,
    sourceSequenceFamily: boundary.sourceSequenceFamily,
    sourceSequence: boundary.currentSequence,
    evidenceKind: "observed",
    confidence: "high",
    qualityState: eventType === "duplicate_input_suppressed" ? "degraded" : "ambiguous",
  };
}

function gapDraft(
  _context: DetectorContext,
  gap: SourceSequenceGapBoundary,
): DetectorEventDraft {
  return {
    eventType: "telemetry_gap",
    payload: {
      durationMs: gap.durationMs,
      missingCount: gap.missingCount,
      countMethod: gap.countMethod,
      sourceSequenceFamily: gap.sourceSequenceFamily,
    },
    detectorId: SOURCE_QUALITY_DETECTOR_ID,
    detectorVersion: SOURCE_QUALITY_DETECTOR_VERSION,
    priority: EVENT_ORDER_PRIORITY.sourceQuality,
    boundaryKey: [
      gap.sourceSequenceFamily ?? "source-time",
      gap.previousSequence ?? gap.previousSourceTimeMs,
      gap.currentSequence ?? gap.currentSourceTimeMs,
      gap.previousObservationIndex,
      gap.currentObservationIndex,
      "gap",
    ].join(":"),
    sourceTimeMs: gap.previousSourceTimeMs,
    sourceEndTimeMs: gap.currentSourceTimeMs,
    sourceSequenceFamily: gap.sourceSequenceFamily,
    sourceSequence: gap.currentSequence,
    evidenceKind: "derived",
    confidence: "high",
    qualityState: "degraded",
  };
}

export class SourceQualityDetector {
  private pendingUnscopedStart: SourceLifecycleEvidence | null = null;
  private connected = false;

  reset(): void {
    this.connected = false;
  }

  holdLifecycle(evidence: SourceLifecycleEvidence): void {
    if (evidence.kind === "start") this.pendingUnscopedStart = evidence;
  }

  bind(context: DetectorContext): DetectorEventDraft[] {
    const pending = this.pendingUnscopedStart;
    this.pendingUnscopedStart = null;
    if (pending) return this.lifecycle(context, pending);
    if (this.connected) return [];
    this.connected = true;
    return [
      this.lifecycleDraft("source_connected", {
        kind: "start",
        timestampMs: context.observation.sourceTimeMs,
        details: "first accepted session observation",
      }),
    ];
  }

  boundaries(
    context: DetectorContext,
    boundaries: readonly SourceSequenceBoundary[],
  ): DetectorEventDraft[] {
    return boundaries.map((boundary) => boundaryDraft(context, boundary));
  }

  finalizeGaps(
    context: DetectorContext,
    finalized: SourceSequenceFinalized,
  ): DetectorEventDraft[] {
    return finalized.gaps.map((gap) => gapDraft(context, gap));
  }

  lifecycle(
    _context: DetectorContext,
    evidence: SourceLifecycleEvidence,
  ): DetectorEventDraft[] {
    if (evidence.kind === "start") {
      if (this.connected) return [];
      this.connected = true;
      return [this.lifecycleDraft("source_connected", evidence)];
    }
    if (evidence.kind === "timeout") {
      return [this.lifecycleDraft("source_stale", evidence)];
    }
    if (evidence.kind === "reconnect") {
      this.connected = true;
      return [this.lifecycleDraft("source_recovered", evidence)];
    }
    this.connected = false;
    return [this.lifecycleDraft("source_disconnected", evidence)];
  }

  storage(
    context: DetectorContext,
    input: {
      kind: "drop" | "failure";
      operation: string;
      details: string | null;
      boundaryKey?: string;
    },
  ): DetectorEventDraft {
    return {
      eventType: input.kind === "drop" ? "storage_drop" : "storage_failure",
      payload: { operation: input.operation, details: input.details },
      detectorId: SOURCE_QUALITY_DETECTOR_ID,
      detectorVersion: SOURCE_QUALITY_DETECTOR_VERSION,
      priority: EVENT_ORDER_PRIORITY.sourceQuality,
      boundaryKey:
        input.boundaryKey ??
        `${context.boundaryKey}:storage:${input.kind}:${input.operation}`,
      evidenceKind: "observed",
      confidence: "high",
      qualityState: "degraded",
    };
  }

  private lifecycleDraft(
    eventType:
      | "source_connected"
      | "source_disconnected"
      | "source_stale"
      | "source_recovered",
    evidence: SourceLifecycleEvidence,
  ): DetectorEventDraft {
    return {
      eventType,
      payload: {
        lifecycleKind: evidence.kind,
        details: evidence.details ?? null,
      },
      detectorId: SOURCE_QUALITY_DETECTOR_ID,
      detectorVersion: SOURCE_QUALITY_DETECTOR_VERSION,
      priority: EVENT_ORDER_PRIORITY.sourceQuality,
      boundaryKey:
        evidence.eventId ??
        `source-lifecycle:${evidence.kind}:${evidence.timestampMs}`,
      sourceTimeMs: evidence.timestampMs,
      sourceEndTimeMs: evidence.timestampMs,
      evidenceKind: "observed",
      confidence: "high",
      qualityState:
        eventType === "source_stale" ? "unavailable" : "available",
    };
  }
}
