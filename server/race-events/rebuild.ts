import { createHash } from "node:crypto";
import type { GameId } from "../../shared/games/ids";
import type { RaceEvent } from "../../shared/racing/events/contracts";
import type {
  ArchiveVerification,
  EvidenceSourceKind,
  ParticipantEvidence,
  RecordingQualitySummary,
  SourceChannelProfile,
  SourceLifecycleEvidence,
} from "../../shared/racing/quality/contracts";
import { RecordingQualityAccumulator } from "../../shared/racing/quality/measure";
import { packetSequences, SourceSequenceTracker, type SourceSequenceObservation } from "../../shared/telemetry/source-sequence";
import type { RaceSourceObservation } from "../race-results/types";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import { getServerGame } from "../games/registry";
import type { LapDetectorCallbacks } from "../lap-detection/types";
import {
  CapturingDbAdapter,
  type CapturedLap,
} from "../telemetry/pipeline-ports";
import { normalizeTelemetryPacket } from "../telemetry/normalization";
import { RaceSourceAccumulator } from "../race-results/source";
import { RaceEventCoordinator } from "./coordinator";

export interface RaceEventRebuildFrame {
  frame: Buffer;
  rawByteOffset: number;
}

export interface RebuildRaceEventTimelineInput {
  sessionId: number;
  gameId: GameId;
  frames: Iterable<RaceEventRebuildFrame> | AsyncIterable<RaceEventRebuildFrame>;
  sourceKind: EvidenceSourceKind;
  participant: ParticipantEvidence;
  versionIdentity: TelemetryVersionIdentity;
  sourceChannelProfile?: SourceChannelProfile;
  sourceVerification: ArchiveVerification;
  transportVerification?: ArchiveVerification;
  canonicalVerification?: ArchiveVerification;
  sourceLifecycle?: readonly SourceLifecycleEvidence[];
}

export interface RebuiltRaceEventTimeline {
  detectorId: string;
  events: RaceEvent[];
  laps: CapturedLap[];
  raceSource: RaceSourceObservation;
  packetCount: number;
  canonicalContentHash: string | null;
  recordingQuality: RecordingQualitySummary;
}

function lapEvaluation(
  coordinator: RaceEventCoordinator,
): NonNullable<LapDetectorCallbacks["onLapEvaluated"]> {
  return async (event, context) => {
    const lastPacket = event.packets.at(-1);
    coordinator.noteLapEvaluated({
      lapNumber: context.lapNumber,
      lapTimeMs: Number.isFinite(event.lapTime) ? event.lapTime * 1_000 : null,
      isValid: event.isValid,
      phase: event.phase,
      conditions: event.conditions,
      invalidReason: event.quality.invalidReason,
      sectors: event.sectors,
      position:
        lastPacket && Number.isInteger(lastPacket.RacePosition) && lastPacket.RacePosition > 0
          ? lastPacket.RacePosition
          : null,
      rawBoundaryOrdinal: event.packets.length,
    });
  };
}

/**
 * Deterministically stages one raw capture without mutating durable state.
 * The caller owns activation and may validate/project the returned generation
 * before replacing anything.
 */
export async function rebuildRaceEventTimeline(
  input: RebuildRaceEventTimelineInput,
): Promise<RebuiltRaceEventTimeline> {
  const adapter = getServerGame(input.gameId);
  const parserState = adapter.createParserState?.() ?? null;
  const db = new CapturingDbAdapter();
  const coordinator = new RaceEventCoordinator({
    sessionId: input.sessionId,
    sourceKind: input.sourceKind,
    sourceGeneration:
      input.canonicalVerification?.sourceGeneration ??
      input.sourceVerification.sourceGeneration,
    validationMode: "rebuild",
  });
  const recordingQuality = new RecordingQualityAccumulator(
    input.sourceKind,
    input.participant,
    input.versionIdentity,
  );
  const sourceSequence = new SourceSequenceTracker();
  const lifecycle = [...(input.sourceLifecycle ?? [])].sort(
    (left, right) => left.timestampMs - right.timestampMs || (left.eventId ?? "").localeCompare(right.eventId ?? ""),
  );
  let lifecycleIndex = 0;
  let sessionStarted = false;
  let pendingSourceSequences: SourceSequenceObservation[] = [];
  const callbacks: LapDetectorCallbacks = {
    onSessionStart: async (_session, context) => {
      if (sessionStarted) throw new Error("Raw rebuild contains multiple detected session boundaries");
      sessionStarted = true;
      coordinator.bindSession(input.sessionId, {
        reason: context.reason,
        observation: adapter.toRaceEventObservation(context.packet, {
          receivedAtMs: context.packet.TimestampMS,
          sourceSequences: pendingSourceSequences,
        }),
      });
    },
    onSessionEnd: async (_session, context) => {
      if (context.reason !== "stream-ended") coordinator.endSession(context);
    },
    onLapEvaluated: lapEvaluation(coordinator),
  };
  const detector = adapter.createLapDetector({
    db,
    lapTimelineContext: {
      classificationForLap: (_sessionId, lapNumber) =>
        coordinator.classificationForLap(input.sessionId, lapNumber),
      eventIdsForLap: (_sessionId, lapNumber) =>
        coordinator.eventIdsForLap(input.sessionId, lapNumber),
    },
    callbacks,
    bypassPacketRateFilter: true,
    sourceKind: input.sourceKind,
    participant: input.participant,
    sourceChannelProfile: input.sourceChannelProfile,
    versionIdentity: input.versionIdentity,
  });
  const resultSource = new RaceSourceAccumulator(input.gameId);
  let packetCount = 0;
  const canonicalHasher = createHash("sha256");

  for await (const { frame, rawByteOffset } of input.frames) {
    const packet = adapter.tryParse(frame, parserState);
    if (!packet) continue;
    normalizeTelemetryPacket(
      packet,
      adapter.coordSystem === "standard-xyz",
      adapter.runtime.normSuspensionTravelMm,
    );
    while (lifecycleIndex < lifecycle.length && lifecycle[lifecycleIndex]!.timestampMs <= packet.TimestampMS) {
      const evidence = lifecycle[lifecycleIndex++]!;
      if (evidence.kind === "reconnect") sourceSequence.markDiscontinuity();
      recordingQuality.noteSourceLifecycle(evidence);
      coordinator.noteSourceLifecycle(evidence, input.sessionId);
    }
    const sourceSequences = packetSequences(packet);
    pendingSourceSequences = sourceSequences;
    const sequenceEvidence = sourceSequence.observe(packet, sourceSequences);
    const preflight = coordinator.preflight(
      adapter.toRaceEventObservation(packet, {
        receivedAtMs: packet.TimestampMS,
        sourceSequences,
      }),
      {
        sourceSequenceBoundaries: sequenceEvidence.boundaries,
        sourceSequenceGapCandidates: sequenceEvidence.gapCandidates,
      },
    );
    recordingQuality.observe(packet, sourceSequences);
    if (packetCount > 0) canonicalHasher.update("\n");
    canonicalHasher.update(JSON.stringify(packet));
    resultSource.observe(packet);
    packetCount++;
    if (!preflight.accepted) {
      coordinator.processPreflight(preflight);
      continue;
    }
    await detector.feed(packet, rawByteOffset);
    coordinator.processPreflight(preflight);
  }

  while (lifecycleIndex < lifecycle.length) {
    const evidence = lifecycle[lifecycleIndex++]!;
    if (evidence.kind === "reconnect") sourceSequence.markDiscontinuity();
    recordingQuality.noteSourceLifecycle(evidence);
    coordinator.noteSourceLifecycle(evidence, input.sessionId);
  }
  const detectedSessionId = detector.session?.sessionId;
  await detector.finalizeCurrentSession?.("stream-ended");
  if (detectedSessionId != null) {
    await detector.waitForPendingLapWrites?.(detectedSessionId);
  }
  coordinator.endSession({ reason: "stream-ended", terminalObserved: false });
  coordinator.noteSourceSequenceFinalized(sourceSequence.finalize());
  if (db.sessions.length > 1) {
    throw new Error("Raw rebuild contains multiple detected session boundaries");
  }
  return {
    detectorId: detector.detectorId,
    events: coordinator.events(),
    laps: [...db.laps],
    raceSource: resultSource.finish(),
    packetCount,
    canonicalContentHash: packetCount === 0 ? null : `sha256:${canonicalHasher.digest("hex")}`,
    recordingQuality: recordingQuality.finalize("reprocessed", input.sourceVerification, {
      transportVerification: input.transportVerification,
      canonicalVerification: input.canonicalVerification,
    }),
  };
}
