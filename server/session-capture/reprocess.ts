/** Deterministic, atomic raw-session rebuild. */
import { and, eq, inArray } from "drizzle-orm";
import type { GameId } from "../../shared/games/ids";
import { AnalysisProvenanceReceiptSchema, type AnalysisProvenanceReceipt } from "../../shared/racing/provenance/contracts";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import {
  RaceEventsReplacedMessageSchema,
} from "../../shared/racing/events/contracts";
import { SessionRunsReplacedMessageSchema } from "../../shared/racing/runs/contracts";
import {
  LOCAL_PLAYER_EVIDENCE,
  type ArchiveVerification,
  type EvidenceSourceKind,
  type ParticipantEvidence,
  type SourceChannelProfile,
  type SourceLifecycleEvidence,
} from "../../shared/racing/quality/contracts";
import {
  activateAnalysisGeneration,
  beginAnalysisGeneration,
  failAnalysisGeneration,
  getActiveAnalysisReceipt,
  type AnalysisReceiptRow,
  type DbTransaction,
} from "../db/analysis-receipt-queries";
import { db } from "../db";
import { getActiveVerifiedCanonicalArchive } from "../db/canonical-archive-queries";
import { readCanonicalArchiveSamples } from "../db/canonical-archive-reader";
import { getLapsForSession, type ReprocessingLapRow } from "../db/lap-reprocessing-queries";
import { rebuildPersistedSessionRuns } from "../db/session-run-queries";
import { cacheDelete } from "../db/telemetry-replay-storage";
import {
  replaceReplayableSessionArtifacts,
  type RaceEventResultProjection,
  type ReplayableLapReplacement,
} from "../db/race-event-queries";
import { linkSessionQualityEvents } from "../db/quality-event-queries";
import { canonicalArchiveNodes, canonicalArchives, sessions } from "../db/schema";
import {
  updateSessionQuality,
  updateSessionRawFile,
} from "../db/session-queries";
import { RACE_RESULT_PROCESSOR_ID } from "../race-results/constants";
import { rebuildCompletedSessionFindings } from "../findings/session-finalization";

import { deriveRaceResult, normalizeSessionType } from "../race-results/derive";
import {
  buildSessionRunsFromTimeline,
  rebuildRaceEventTimeline,
  type RebuiltRaceEventTimeline,
} from "../race-events/rebuild";
import { getServerGame } from "../games/registry";
import type { RaceEventObservationContext } from "../games/types";
import {
  applyRaceEventSemanticProjection,
  RaceEventSemanticProjector,
} from "../race-events/semantic-projector";

import type { LapDetectorCallbacks } from "../lap-detection/types";
import { wsManager } from "../runtime/websocket-manager";
import {
  gunzipBuffer,
  iterateSessionFrameRecords,
  readFrameStreamStart,
} from "./framing";
import {
  inspectRawCaptureIdentity,
  rawCaptureObjectId,
  sha256ContentHash,
} from "./identity";
import { mergeReprocessedRecordingQuality } from "./reprocess-quality";
import { withSessionCaptureMaintenanceLock } from "./cleanup";
import { currentAnalysisContract } from "../analysis-provenance/current-contract";
import { createPersistedSessionAnalysisReceipt, validateCanonicalArchiveReceipt } from "../analysis-provenance/receipt";
import { RaceEventCoordinator } from "../race-events/coordinator";
import { CanonicalPacketHasher } from "../race-results/canonical-input";
import { RaceSourceAccumulator } from "../race-results/source";
import { packetSequences, SourceSequenceTracker, type SourceSequenceObservation } from "../../shared/telemetry/source-sequence";
import { RecordingQualityAccumulator } from "../../shared/racing/quality/measure";
import { CapturingDbAdapter, currentTelemetryVersionIdentity } from "../telemetry/pipeline-ports";

interface ReprocessResult {
  sessionId: number;
  lapsDetected: number;
  lapsUpdated: number;
  strategy: "in-place" | "replace";
}

export class SessionRawFileMissingError extends Error {
  constructor(sessionId: number, rawFile?: string) {
    super(rawFile ? `Session ${sessionId} raw file not found: ${rawFile}` : `Session ${sessionId} has no raw file to reprocess`);
    this.name = "SessionRawFileMissingError";
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: number) {
    super(`Session ${sessionId} not found`);
    this.name = "SessionNotFoundError";
  }
}

class SessionCanonicalArchiveUnavailableError extends Error {
  constructor(sessionId: number, details: string) {
    super(`Session ${sessionId} canonical archive unavailable: ${details}`);
    this.name = "SessionCanonicalArchiveUnavailableError";
  }
}

interface CanonicalArchiveEvidence {
  archiveId: string;
  byteSize: number;
  canonicalInventory: NonNullable<AnalysisProvenanceReceipt["canonicalInventory"]>;
  originalSourceKind: EvidenceSourceKind;
  outputContentHash: string;
  schemaVersion: string;
}

interface CanonicalRebuildInput {
  sessionId: number;
  analysisGenerationId: string;
  gameId: GameId;
  packets: readonly TelemetryPacket[];
  versionIdentity: TelemetryVersionIdentity;
  participant: ParticipantEvidence;
  sourceChannelProfile?: SourceChannelProfile;
  sourceVerification: ArchiveVerification;
  canonicalVerification: ArchiveVerification;
  originalSourceKind: EvidenceSourceKind;
  sourceLifecycle: readonly SourceLifecycleEvidence[];
}
interface LoadedCanonicalRebuildInput {
  packets: TelemetryPacket[];
  sourceContentHash: string;
  sourceVerification: ArchiveVerification;
  canonicalVerification: ArchiveVerification;
  evidence: CanonicalArchiveEvidence;
}


async function loadCanonicalRebuildInput(sessionId: number, gameId: GameId): Promise<LoadedCanonicalRebuildInput> {
  const archive = await getActiveVerifiedCanonicalArchive(sessionId, { verifyOutput: true });
  if (!archive || archive.status !== "verified" || archive.completeness !== "complete" || !archive.outputContentHash || archive.byteSize == null) {
    throw new SessionCanonicalArchiveUnavailableError(sessionId, "no complete verified archive");
  }
  const active = await getActiveAnalysisReceipt({ sessionId, artifactSetType: "canonical_archive" });
  if (!active?.receipt) throw new SessionCanonicalArchiveUnavailableError(sessionId, "active archive receipt is unavailable");
  let archiveReceipt;
  try {
    archiveReceipt = validateCanonicalArchiveReceipt(active.receipt);
  } catch {
    throw new SessionCanonicalArchiveUnavailableError(sessionId, "active archive receipt failed verification");
  }
  const archiveOutput = archiveReceipt.outputs.find((entry) => entry.artifactType === "canonical_archive");
  if (
    archiveReceipt.evidence.objectId !== archive.archiveId
    || archiveReceipt.evidence.contentHash !== archive.outputContentHash
    || archiveOutput?.contentHash !== archive.outputContentHash
  ) {
    throw new SessionCanonicalArchiveUnavailableError(sessionId, "active archive receipt does not match durable archive");
  }
  if (archiveReceipt.context.gameId !== gameId || archive.context.gameId !== gameId) {
    throw new SessionCanonicalArchiveUnavailableError(sessionId, "archive game does not match session game");
  }
  let rows;
  try {
    rows = await readCanonicalArchiveSamples(archive.archivePath, 0, archive.sampleCount);
  } catch (error) {
    throw new SessionCanonicalArchiveUnavailableError(
      sessionId,
      `archive read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (rows.length !== archive.sampleCount) {
    throw new SessionCanonicalArchiveUnavailableError(
      sessionId,
      `archive sample count mismatch: expected ${archive.sampleCount}, got ${rows.length}`,
    );
  }
  const packets: TelemetryPacket[] = [];
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(row.packetJson);
    } catch {
      throw new SessionCanonicalArchiveUnavailableError(sessionId, `invalid packet JSON at sample ${row.sampleOrdinal}`);
    }
    if (!value || typeof value !== "object" || !("gameId" in value) || value.gameId !== gameId) {
      throw new SessionCanonicalArchiveUnavailableError(sessionId, `packet game mismatch at sample ${row.sampleOrdinal}`);
    }
    packets.push(value as TelemetryPacket);
  }
  if (packets.length === 0) {
    throw new SessionCanonicalArchiveUnavailableError(sessionId, "archive contains zero telemetry samples");
  }
  return {
    packets,
    sourceContentHash: archive.outputContentHash,
    sourceVerification: {
      state: "verified",
      sourceGeneration: archive.sourceContentHash,
      details: "Verified canonical archive source",
    },
    canonicalVerification: {
      state: "verified",
      sourceGeneration: archive.outputContentHash,
      details: "Verified canonical archive replay",
    },
    evidence: {
      archiveId: archive.archiveId,
      byteSize: archive.byteSize,
      canonicalInventory: archiveReceipt.canonicalInventory!,
      originalSourceKind: archiveReceipt.evidence.originalSourceKind,
      outputContentHash: archive.outputContentHash,
      schemaVersion: archive.schemaVersion,
    },
  };
}

function canonicalSessionAnalysisReceipt(
  receipt: AnalysisProvenanceReceipt,
  evidence: CanonicalArchiveEvidence,
): AnalysisProvenanceReceipt {
  return AnalysisProvenanceReceiptSchema.parse({
    ...receipt,
    evidence: {
      kind: "canonical-archive",
      originalSourceKind: evidence.originalSourceKind,
      objectId: evidence.archiveId,
      contentHash: evidence.outputContentHash,
      byteSize: evidence.byteSize,
      formatVersion: evidence.schemaVersion,
      recordCounts: {
        telemetry_samples: evidence.canonicalInventory.rowCounts.frames ?? 0,
        hierarchy_nodes: evidence.canonicalInventory.rowCounts.nodes ?? 0,
      },
    },
    canonicalInventory: evidence.canonicalInventory,
    warnings: [...new Set([...receipt.warnings, "Rebuilt from verified canonical telemetry; native source bytes unavailable"])],
    rebuildCapability: {
      mode: "limited",
      sourceKind: "canonical-archive",
      rebuildableArtifacts: ["laps", "race_events", "session_runs", "race_result", "quality"],
      unavailableArtifacts: [],
      limitations: ["Canonical telemetry cannot exactly re-decode game-native source frames"],
    },
    verification: receipt.verification.map((check) =>
      check.id === "source_hash"
        ? { id: "source_hash", status: "passed", details: "Verified canonical archive output hash recorded" }
        : check,
    ),
  });
}

async function rebuildCanonicalRaceEventTimeline(input: CanonicalRebuildInput): Promise<RebuiltRaceEventTimeline> {
  const adapter = getServerGame(input.gameId);
  const db = new CapturingDbAdapter();
  const coordinator = new RaceEventCoordinator({
    sessionId: input.sessionId,
    sourceKind: input.originalSourceKind,
    sourceGeneration: input.canonicalVerification.sourceGeneration,
    analysisGenerationId: input.analysisGenerationId,
    validationMode: "rebuild",
  });
  const recordingQuality = new RecordingQualityAccumulator(
    "canonical-archive",
    input.participant,
    input.versionIdentity,
  );
  const sourceSequence = new SourceSequenceTracker();
  const lifecycle = [...input.sourceLifecycle].sort(
    (left, right) => left.timestampMs - right.timestampMs || (left.eventId ?? "").localeCompare(right.eventId ?? ""),
  );
  let lifecycleIndex = 0;
  let sessionStarted = false;
  let pendingSourceSequences: SourceSequenceObservation[] = [];
  const semanticProjector = new RaceEventSemanticProjector();
  let pendingObservationContext: RaceEventObservationContext | null = null;

  const callbacks: LapDetectorCallbacks = {
    onSessionStart: async (_session, context) => {
      if (sessionStarted) throw new Error("Canonical rebuild contains multiple detected session boundaries");
      sessionStarted = true;
      const observationContext =
        pendingObservationContext ?? {
          receivedAtMs: context.packet.TimestampMS,
          sourceSequences: pendingSourceSequences,
          semantic: semanticProjector.project(context.packet, context.packet.TimestampMS),
        };
      const observation = adapter.toRaceEventObservation(
        context.packet,
        observationContext,
      );
      coordinator.bindSession(input.sessionId, {
        reason: context.reason,
        observation: observationContext.semantic
          ? applyRaceEventSemanticProjection(observation, observationContext.semantic)
          : observation,
      });
    },
    onSessionEnd: async (_session, context) => {
      if (context.reason !== "stream-ended") coordinator.endSession(context);
    },
    onLapEvaluated: async (event, context) => {
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
    },
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
    sourceKind: input.originalSourceKind,
    participant: input.participant,
    sourceChannelProfile: input.sourceChannelProfile,
    versionIdentity: input.versionIdentity,
  });
  const resultSource = new RaceSourceAccumulator(input.gameId);
  const canonicalHasher = new CanonicalPacketHasher();
  const packets: TelemetryPacket[] = [];
  for (const packet of input.packets) {
    while (lifecycleIndex < lifecycle.length && lifecycle[lifecycleIndex]!.timestampMs <= packet.TimestampMS) {
      const evidence = lifecycle[lifecycleIndex++]!;
      if (evidence.kind === "reconnect") {
        sourceSequence.markDiscontinuity();
        semanticProjector.resetSourceState();
      }
      recordingQuality.noteSourceLifecycle(evidence);
      coordinator.noteSourceLifecycle(evidence, input.sessionId);
    }
    const sourceSequences = packetSequences(packet);
    pendingSourceSequences = sourceSequences;
    const sequenceEvidence = sourceSequence.observe(packet, sourceSequences);
    const observationContext = {
      receivedAtMs: packet.TimestampMS,
      sourceSequences,
      semantic: semanticProjector.project(packet, packet.TimestampMS),
    };
    pendingObservationContext = observationContext;
    const preflight = coordinator.preflight(
      applyRaceEventSemanticProjection(
        adapter.toRaceEventObservation(packet, observationContext),
        observationContext.semantic,
      ),
      {
        sourceSequenceBoundaries: sequenceEvidence.boundaries,
        sourceSequenceGapCandidates: sequenceEvidence.gapCandidates,
      },
    );
    recordingQuality.observe(packet, sourceSequences);
    packets.push(packet);
    canonicalHasher.update(packet);
    resultSource.observe(packet);
    if (!preflight.accepted) {
      coordinator.processPreflight(preflight);
      continue;
    }
    await detector.feed(packet);
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
  if (detectedSessionId != null) await detector.waitForPendingLapWrites?.(detectedSessionId);
  coordinator.endSession({ reason: "stream-ended", terminalObserved: false });
  coordinator.noteSourceSequenceFinalized(sourceSequence.finalize());
  if (db.sessions.length > 1) throw new Error("Canonical rebuild contains multiple detected session boundaries");
  const runArtifacts = buildSessionRunsFromTimeline(coordinator.events(), db.laps, { reason: "source-ended" });
  return {
    detectorId: detector.detectorId,
    events: coordinator.events(),
    laps: [...db.laps],
    raceSource: resultSource.finish(),
    packetCount: canonicalHasher.packetCount,
    canonicalContentHash: canonicalHasher.digest(),
    runs: runArtifacts.runs,
    memberships: runArtifacts.memberships,
    evidence: runArtifacts.evidence,
    packets,
    recordingQuality: recordingQuality.finalize("reprocessed", input.sourceVerification, {
      canonicalVerification: input.canonicalVerification,
    }),
  };
}

function retainedLifecycleEvidence(
  quality: (typeof sessions.$inferSelect)["recordingQuality"],
): SourceLifecycleEvidence[] {
  if (!quality) return [];
  const evidence: SourceLifecycleEvidence[] = [];
  for (const fact of quality.facts) {
    const lifecycleEvent = fact.details?.lifecycleEvent;
    const kind =
      fact.code === "source_reconnect" && lifecycleEvent === "reconnect"
        ? "reconnect"
        : fact.code === "timeline_discontinuity" && lifecycleEvent === "timeout"
          ? "timeout"
          : null;
    const timestampMs = fact.timeRange?.startMs;
    if (!kind || timestampMs == null) continue;
    evidence.push({
      kind,
      timestampMs,
      ...(fact.eventIds[0] ? { eventId: fact.eventIds[0] } : {}),
      ...(typeof fact.details?.details === "string" ? { details: fact.details.details } : {}),
    });
  }
  return evidence;
}

function replacementLaps(
  detected: Awaited<ReturnType<typeof rebuildRaceEventTimeline>>["laps"],
  existing: ReprocessingLapRow[],
  analysisGenerationId: string,
): ReplayableLapReplacement[] {
  const candidates = new Map<number, ReprocessingLapRow[]>();
  for (const lap of existing) {
    const values = candidates.get(lap.lapNumber);
    if (values) values.push(lap);
    else candidates.set(lap.lapNumber, [lap]);
  }
  return detected.map((lap) => {
    const values = candidates.get(lap.lapNumber) ?? [];
    const exact = values.findIndex((candidate) => candidate.rawByteOffset === lap.rawByteOffset);
    const preserved = values.splice(exact >= 0 ? exact : 0, 1)[0];
    return {
      lapNumber: lap.lapNumber,
      lapTime: lap.lapTime,
      isValid: lap.isValid,
      phase: lap.phase,
      conditions: lap.conditions,
      paceEligibility: lap.paceEligibility,
      invalidReason: lap.invalidReason,
      notes: preserved?.notes ?? null,
      profileId: preserved ? preserved.profileId : lap.profileId,
      pi: preserved ? preserved.pi : null,
      carSetup: preserved?.carSetup ?? null,
      tuneId: preserved ? preserved.tuneId : lap.tuneId,
      experimentId: preserved ? preserved.experimentId : null,
      experimentVersionId: preserved ? preserved.experimentVersionId : null,
      experimentExcluded: preserved ? preserved.experimentExcluded : null,
      experimentExcludedSource: preserved ? preserved.experimentExcludedSource : null,
      fuelPerLap: preserved ? preserved.fuelPerLap : null,
      tyreWear: preserved ? preserved.tyreWear : null,
      sectorTimes: lap.sectors,
      rawByteOffset: lap.rawByteOffset,
      rawFrameCount: lap.rawFrameCount,
      analysisGenerationId,
      ...(preserved ? { replacesLapId: preserved.id } : {}),
      ...(lap.versionIdentity ?? {}),
      quality: lap.quality,
      eligibility: lap.eligibility,
      qualitySchemaVersion: lap.quality?.provenance.schemaVersion ?? null,
      qualityPolicyVersion: lap.quality?.provenance.policyVersion ?? null,
      qualityConfigVersion: lap.quality?.provenance.configurationVersion ?? null,
      qualityGeneration: lap.quality?.provenance.outputGeneration ?? null,
    };
  });
}

interface CanonicalArchiveLapLink {
  nodeId: string;
  lapId: number | null;
}

async function canonicalArchiveLapLinks(
  sessionId: number,
  existing: readonly ReprocessingLapRow[],
  tx: DbTransaction,
): Promise<CanonicalArchiveLapLink[]> {
  if (existing.length === 0) return [];
  return tx
    .select({ nodeId: canonicalArchiveNodes.nodeId, lapId: canonicalArchiveNodes.lapId })
    .from(canonicalArchiveNodes)
    .innerJoin(canonicalArchives, eq(canonicalArchiveNodes.archiveId, canonicalArchives.archiveId))
    .where(and(
      eq(canonicalArchives.sessionId, sessionId),
      eq(canonicalArchiveNodes.level, "lap"),
      inArray(canonicalArchiveNodes.lapId, existing.map((lap) => lap.id)),
    ))
    .all();
}

async function relinkCanonicalArchiveLaps(
  links: readonly CanonicalArchiveLapLink[],
  replacementsByOldLapId: ReadonlyMap<number, number>,
  tx: DbTransaction,
): Promise<void> {
  for (const link of links) {
    const replacementId = link.lapId == null ? undefined : replacementsByOldLapId.get(link.lapId);
    if (replacementId == null) continue;
    await tx
      .update(canonicalArchiveNodes)
      .set({ lapId: replacementId })
      .where(eq(canonicalArchiveNodes.nodeId, link.nodeId))
      .run();
  }
}

function resultProjection(
  sessionId: number,
  sessionType: string | null,
  rebuilt: RebuiltRaceEventTimeline,
  rawContentHash: string | null,
  analysisGenerationId: string,
): RaceEventResultProjection {
  const source = rebuilt.raceSource;
  if (sessionType) {
    if (!source.sessionType) {
      source.sessionType = sessionType;
      source.evidence.fieldStatus.sessionType = "direct";
    } else if (normalizeSessionType(sessionType) !== normalizeSessionType(source.sessionType)) {
      source.evidence.conflicts.push(`session-type:session-row=${sessionType}|telemetry=${source.sessionType}`);
    }
  }
  const derived = deriveRaceResult(source, rebuilt.events);
  derived.provenance = {
    ...derived.provenance,
    rawInput: rawContentHash == null ? null : {
      objectId: rawCaptureObjectId(sessionId),
      contentHash: rawContentHash,
    },
    canonicalInput: rebuilt.canonicalContentHash == null ? null : {
      sessionId: String(sessionId),
      firstSequence: 0,
      lastSequence: rebuilt.packetCount - 1,
      contentHash: rebuilt.canonicalContentHash,
    },
  };
  return {
    processorVersion: RACE_RESULT_PROCESSOR_ID,
    analysisGenerationId,
    sessionType: derived.sessionType,
    classification: derived.classification,
    outcomeStatus: derived.outcomeStatus,
    finishingPosition: derived.finishingPosition,
    qualifyingPosition: derived.qualifyingPosition,
    isPodium: derived.isPodium,
    isFastestLap: derived.isFastestLap,
    pitCount: derived.pitCount,
    eventIds: derived.eventIds,
    tyreStrategy: derived.tyreStrategy,
    fuelStrategy: derived.fuelStrategy,
    provenance: derived.provenance,
    evidence: derived.evidence,
    reasons: derived.reasons,
  };
}

export async function reprocessSession(sessionId: number): Promise<ReprocessResult & { analysisGenerationId: string }> {
  let attempt: AnalysisReceiptRow | null = null;
  let result: RaceEventResultProjection | null = null;
  let existingLaps: ReprocessingLapRow[] = [];
  let rebuiltLaps = 0;
  let strategy: ReprocessResult["strategy"] = "replace";
  let qualityGeneration = "";
  try {
    const outcome = await withSessionCaptureMaintenanceLock(async () => {
      const session = await db
        .select({
          rawFile: sessions.rawFile,
          gameId: sessions.gameId,
          sessionType: sessions.sessionType,
          source: sessions.source,
          recordingQuality: sessions.recordingQuality,
          sourceChannelProfile: sessions.sourceChannelProfile,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .get();
      if (!session) throw new SessionNotFoundError(sessionId);
      const gameId = session.gameId as GameId;
      const versionIdentity = currentTelemetryVersionIdentity(gameId);
      const contract = currentAnalysisContract(gameId, session.sourceChannelProfile ?? null);
      const participant = session.recordingQuality?.participant ?? LOCAL_PLAYER_EVIDENCE;
      const sourceLifecycle = retainedLifecycleEvidence(session.recordingQuality);
      const rawFile = session.rawFile;
      let rawContentHash: string | null = null;
      let rebuilt: RebuiltRaceEventTimeline | null = null;
      let canonicalEvidence: CanonicalArchiveEvidence | null = null;
      let rawFileMissing = false;
      if (rawFile) {
        const file = Bun.file(rawFile);
        if (!(await file.exists())) {
          rawFileMissing = true;
        } else {
          const stored = Buffer.from(await file.arrayBuffer());
          const bytes = rawFile.endsWith(".gz") ? await gunzipBuffer(stored) : stored;
          const frameStreamStart = readFrameStreamStart(bytes);
          rawContentHash = sha256ContentHash(bytes);
          attempt = await beginAnalysisGeneration({
            sessionId,
            artifactSetType: "session_analysis",
            sourceContentHash: rawContentHash,
            contractHash: contract.contractHash,
            configurationHash: contract.configurationHash,
          });
          const sourceVerification = session.recordingQuality?.archiveVerification ?? {
            state: "verified" as const,
            sourceGeneration: rawContentHash,
            details: "Verified retained raw capture",
          };
          const frames = (function* () {
            for (const { offset, frame } of iterateSessionFrameRecords(bytes, frameStreamStart, {
              skipMetaFrames: true,
              allowEmptyFrames: false,
              strict: true,
              validateDeclaredFrameCount: true,
            })) {
              yield { frame, rawByteOffset: offset };
            }
          })();
          rebuilt = await rebuildRaceEventTimeline({
            sessionId,
            analysisGenerationId: attempt.generationId,
            gameId,
            frames,
            sourceKind: (session.source as EvidenceSourceKind | null) ?? "unknown",
            participant,
            versionIdentity,
            ...(session.sourceChannelProfile ? { sourceChannelProfile: session.sourceChannelProfile } : {}),
            sourceVerification,
            ...(session.recordingQuality?.transportVerification
              ? { transportVerification: session.recordingQuality.transportVerification }
              : {}),
            sourceLifecycle,
          });
        }
      }
      if (!rawContentHash) {
        let canonical: LoadedCanonicalRebuildInput;
        try {
          canonical = await loadCanonicalRebuildInput(sessionId, gameId);
        } catch (error) {
          const activeCanonical = await getActiveAnalysisReceipt({
            sessionId,
            artifactSetType: "canonical_archive",
          });
          if (activeCanonical) throw error;
          if (!rawFile || rawFileMissing) {
            throw new SessionRawFileMissingError(sessionId, rawFile ?? undefined);
          }
          throw error;
        }
        canonicalEvidence = canonical.evidence;
        attempt = await beginAnalysisGeneration({
          sessionId,
          artifactSetType: "session_analysis",
          sourceContentHash: canonical.sourceContentHash,
          contractHash: contract.contractHash,
          configurationHash: contract.configurationHash,
        });
        rebuilt = await rebuildCanonicalRaceEventTimeline({
          sessionId,
          analysisGenerationId: attempt.generationId,
          gameId,
          packets: canonical.packets,
          participant,
          versionIdentity,
          ...(session.sourceChannelProfile ? { sourceChannelProfile: session.sourceChannelProfile } : {}),
          sourceVerification: canonical.sourceVerification,
          canonicalVerification: canonical.canonicalVerification,
          originalSourceKind: canonical.evidence.originalSourceKind,
          sourceLifecycle,
        });
      }
      if (!attempt || !rebuilt) throw new Error("No source evidence available for analysis rebuild");
      existingLaps = await getLapsForSession(sessionId);
      const laps = replacementLaps(rebuilt.laps, existingLaps, attempt.generationId);
      strategy = rebuilt.laps.length === existingLaps.length ? "in-place" : "replace";
      const mergedQuality = mergeReprocessedRecordingQuality(session.recordingQuality, rebuilt.recordingQuality);
      result = resultProjection(sessionId, session.sessionType, rebuilt, rawContentHash, attempt.generationId);
      rebuiltLaps = rebuilt.laps.length;

      await db.transaction(async (tx) => {
        const archiveLapLinks = await canonicalArchiveLapLinks(sessionId, existingLaps, tx);
        const replacedArtifacts = await replaceReplayableSessionArtifacts(
          {
            sessionId,
            events: rebuilt.events,
            runs: rebuilt.runs,
            memberships: rebuilt.memberships,
            evidence: rebuilt.evidence,
            laps,
            result: result!,
          },
          tx,
        );
        await relinkCanonicalArchiveLaps(archiveLapLinks, replacedArtifacts.lapIdsByReplacedId, tx);
        if (rawFile && rawContentHash) {
          await updateSessionRawFile(sessionId, rawFile, rebuilt.detectorId, versionIdentity, tx);
        } else {
          await tx.update(sessions)
            .set({ lapDetectorVersion: rebuilt.detectorId, ...versionIdentity })
            .where(eq(sessions.id, sessionId))
            .run();
        }
        qualityGeneration = (await updateSessionQuality(sessionId, mergedQuality, tx)).provenance.outputGeneration;
        await linkSessionQualityEvents(sessionId, tx);
        await rebuildPersistedSessionRuns(sessionId, tx);
        if (rawFile && rawContentHash) {
          const latest = await inspectRawCaptureIdentity(rawFile);
          if (!latest || latest.contentHash !== rawContentHash) {
            throw new Error("Raw source changed during analysis rebuild");
          }
        }
        const persistedReceipt = await createPersistedSessionAnalysisReceipt(attempt!, gameId, tx);
        const receipt = canonicalEvidence
          ? canonicalSessionAnalysisReceipt(persistedReceipt, canonicalEvidence)
          : persistedReceipt;
        await activateAnalysisGeneration({ generationId: attempt!.generationId, receipt }, tx);
      });
      for (const lap of existingLaps) cacheDelete(lap.id);
      await rebuildCompletedSessionFindings(sessionId, gameId);
      return attempt!;
    });
    wsManager.broadcastNotification(
      RaceEventsReplacedMessageSchema.parse({ type: "race-events-replaced", sessionId }),
    );
    wsManager.broadcastNotification(
      SessionRunsReplacedMessageSchema.parse({ type: "session-runs-replaced", sessionId }),
    );
    wsManager.broadcastNotification({
      type: "race-result-reconciled",
      sessionId,
      status: result!.outcomeStatus === "confirmed" ? "enriched" : "ambiguous",
    });
    wsManager.broadcastNotification({ type: "quality-updated", sessionId, qualityGeneration });
    return {
      sessionId,
      lapsDetected: rebuiltLaps,
      lapsUpdated: rebuiltLaps,
      strategy,
      analysisGenerationId: outcome.generationId,
    };
  } catch (error) {
    const failedGenerationId = (attempt as AnalysisReceiptRow | null)?.generationId;
    if (failedGenerationId) {
      try {
        await failAnalysisGeneration(failedGenerationId, {
          code: error instanceof SessionRawFileMissingError || error instanceof SessionCanonicalArchiveUnavailableError
            ? "source_unavailable"
            : error instanceof Error && error.message.includes("Raw source changed")
              ? "source_hash_changed"
              : error instanceof Error && error.message.includes("verification")
                ? "output_verification_failed"
                : error instanceof Error && (error.message.includes("activation") || error.message.includes("receipt"))
                  ? "activation_failed"
                  : "build_failed",
          message: error instanceof Error && error.message.includes("Raw source changed")
            ? "Raw source changed during analysis rebuild"
            : "Analysis rebuild failed before activation",
          failedAt: new Date().toISOString(),
          checks: [{
            id: "source_hash",
            status: error instanceof Error && error.message.includes("Raw source changed") ? "failed" : "not_applicable",
            details: "Analysis rebuild did not activate a verified receipt",
          }],
        });
      } catch {
        // Preserve original rebuild error; failure recording is best effort.
      }
    }
    throw error;
  }
}
