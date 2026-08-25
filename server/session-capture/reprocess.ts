/** Deterministic, atomic raw-session rebuild. */
import { eq } from "drizzle-orm";
import type { GameId } from "../../shared/games/ids";
import {
  RaceEventsReplacedMessageSchema,
  type RaceEvent,
} from "../../shared/racing/events/contracts";
import { SessionRunsReplacedMessageSchema } from "../../shared/racing/runs/contracts";
import {
  LOCAL_PLAYER_EVIDENCE,
  normalizeEvidenceSourceKind,
  type SourceLifecycleEvidence,
} from "../../shared/racing/quality/contracts";
import {
  activateAnalysisGeneration,
  beginAnalysisGeneration,
  failAnalysisGeneration,
  type AnalysisReceiptRow,
} from "../db/analysis-receipt-queries";
import { db } from "../db";
import {
  getLapsForSession,
  updateLapRawIndex,
  type ReprocessingLap,
} from "../db/lap-reprocessing-queries";
import { rebuildPersistedSessionRuns } from "../db/session-run-queries";
import { cacheDelete } from "../db/telemetry-replay-storage";
import {
  replaceReplayableSessionArtifacts,
  type RaceEventResultProjection,
  type ReplayableLapReplacement,
} from "../db/race-event-queries";
import { invalidateLapEvidence } from "../db/lap-evidence-invalidation";
import { linkSessionQualityEvents } from "../db/quality-event-queries";
import { sessions } from "../db/schema";
import {
  updateSessionQuality,
  updateSessionRawFile,
} from "../db/session-queries";
import { RACE_RESULT_PROCESSOR_ID } from "../race-results/constants";
import { deriveRaceResult, normalizeSessionType } from "../race-results/derive";
import { rebuildRaceEventTimeline } from "../race-events/rebuild";
import { wsManager } from "../runtime/websocket-manager";
import {
  gunzipBuffer,
  iterateSessionFrameRecords,
  readFrameStreamStart,
} from "./framing";
import {
  loadRawCaptureIdentity,
  rawCaptureObjectId,
  sha256ContentHash,
} from "./identity";
import { mergeReprocessedRecordingQuality } from "./reprocess-quality";
import { withSessionCaptureMaintenanceLock } from "./cleanup";
import { currentAnalysisContract } from "../analysis-provenance/current-contract";
import { createPersistedSessionAnalysisReceipt } from "../analysis-provenance/receipt";
import {
  currentTelemetryVersionIdentity,
  type CapturedLap,
} from "../telemetry/pipeline-ports";

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

type RebuiltLap = CapturedLap;
type ExistingLap = ReprocessingLap;
type FinalizedRebuiltLap = RebuiltLap & {
  quality: NonNullable<RebuiltLap["quality"]>;
  eligibility: NonNullable<RebuiltLap["eligibility"]>;
  versionIdentity: NonNullable<RebuiltLap["versionIdentity"]>;
};

interface MatchedReprocessedLap {
  detected: FinalizedRebuiltLap;
  preserved: ExistingLap | undefined;
}

function finalizedRebuiltLaps(
  laps: readonly RebuiltLap[],
): FinalizedRebuiltLap[] {
  return laps.map((lap) => {
    if (!lap.quality || !lap.eligibility || !lap.versionIdentity) {
      throw new Error(
        `Rebuilt lap ${lap.lapNumber} is missing finalized quality evidence`,
      );
    }
    return lap as FinalizedRebuiltLap;
  });
}

function matchReprocessedLaps(
  detected: readonly FinalizedRebuiltLap[],
  existing: readonly ExistingLap[],
): MatchedReprocessedLap[] {
  const candidates = new Map<number, ExistingLap[]>();
  for (const lap of existing) {
    const values = candidates.get(lap.lapNumber);
    if (values) values.push(lap);
    else candidates.set(lap.lapNumber, [lap]);
  }
  return detected.map((lap) => {
    const values = candidates.get(lap.lapNumber) ?? [];
    const exact = values.findIndex(
      (candidate) =>
        candidate.rawByteOffset === lap.rawByteOffset,
    );
    return {
      detected: lap,
      preserved: values.splice(exact >= 0 ? exact : 0, 1)[0],
    };
  });
}

function replacementLaps(
  matches: readonly MatchedReprocessedLap[],
  analysisGenerationId: string,
): ReplayableLapReplacement[] {
  return matches.map(({ detected: lap, preserved }) => ({
    lapNumber: lap.lapNumber,
    lapTime: lap.lapTime,
    isValid: lap.isValid,
    phase: lap.phase,
    conditions: lap.conditions,
    paceEligibility: lap.paceEligibility,
    invalidReason: lap.invalidReason,
    notes: preserved?.notes ?? null,
    profileId: preserved?.profileId ?? lap.profileId,
    pi: preserved?.pi ?? null,
    carSetup: preserved?.carSetup ?? null,
    tuneId: preserved?.tuneId ?? lap.tuneId,
    experimentId: preserved?.experimentId ?? null,
    experimentVersionId:
      preserved?.experimentVersionId ?? null,
    experimentExcluded: preserved?.experimentExcluded ?? null,
    experimentExcludedSource:
      preserved?.experimentExcludedSource ?? null,
    ...(preserved ? { createdAt: preserved.createdAt } : {}),
    sectorTimes: lap.sectors,
    rawByteOffset: lap.rawByteOffset,
    rawFrameCount: lap.rawFrameCount,
    analysisGenerationId,
    ...lap.versionIdentity,
    quality: lap.quality,
    eligibility: lap.eligibility,
    qualitySchemaVersion: lap.quality.provenance.schemaVersion,
    qualityPolicyVersion: lap.quality.provenance.policyVersion,
    qualityConfigVersion:
      lap.quality.provenance.configurationVersion,
    qualityGeneration: lap.quality.provenance.outputGeneration,
  }));
}

function remapEventsToExistingLaps(
  events: readonly RaceEvent[],
  matches: readonly MatchedReprocessedLap[],
): RaceEvent[] {
  const lapIdByNumber = new Map(
    matches.flatMap(({ detected, preserved }) =>
      preserved ? [[detected.lapNumber, preserved.id] as const] : [],
    ),
  );
  return events.map((event) =>
    event.lapNumber == null
      ? event
      : ({
          ...event,
          lapId: lapIdByNumber.get(event.lapNumber) ?? null,
        } as RaceEvent),
  );
}

function resultProjection(
  sessionId: number,
  sessionType: string | null,
  rebuilt: Awaited<ReturnType<typeof rebuildRaceEventTimeline>>,
  rawContentHash: string,
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
    rawInput: { objectId: rawCaptureObjectId(sessionId), contentHash: rawContentHash },
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
  let existingLaps: ReprocessingLap[] = [];
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
      if (!session.rawFile) throw new SessionRawFileMissingError(sessionId);

      const file = Bun.file(session.rawFile);
      if (!(await file.exists())) {
        throw new SessionRawFileMissingError(sessionId, session.rawFile);
      }
      const stored = Buffer.from(await file.arrayBuffer());
      const bytes = session.rawFile.endsWith(".gz")
        ? await gunzipBuffer(stored)
        : stored;
      const frameStreamStart = readFrameStreamStart(bytes);
      const gameId = session.gameId as GameId;
      const sourceKind = normalizeEvidenceSourceKind(session.source);
      const versionIdentity = currentTelemetryVersionIdentity(gameId);
      const rawContentHash = sha256ContentHash(bytes);
      const contract = currentAnalysisContract(
        gameId,
        session.sourceChannelProfile ?? null,
      );
      attempt = await beginAnalysisGeneration({
        sessionId,
        artifactSetType: "session_analysis",
        sourceContentHash: rawContentHash,
        contractHash: contract.contractHash,
        configurationHash: contract.configurationHash,
      });
      const sourceVerification = session.recordingQuality?.archiveVerification ?? {
        state: "unknown" as const,
        sourceGeneration: "legacy",
        details: "Original source verification is unavailable",
      };
      const frames = (function* () {
        for (const { offset, frame } of iterateSessionFrameRecords(
          bytes,
          frameStreamStart,
          {
            skipMetaFrames: true,
            allowEmptyFrames: false,
            strict: true,
            validateDeclaredFrameCount: true,
          },
        )) {
          yield { frame, rawByteOffset: offset };
        }
      })();
      const rebuilt = await rebuildRaceEventTimeline({
        sessionId,
        analysisGenerationId: attempt.generationId,
        gameId,
        frames,
        sourceKind,
        participant:
          session.recordingQuality?.participant ?? LOCAL_PLAYER_EVIDENCE,
        versionIdentity,
        ...(session.sourceChannelProfile
          ? { sourceChannelProfile: session.sourceChannelProfile }
          : {}),
        sourceVerification,
        ...(session.recordingQuality?.transportVerification
          ? {
              transportVerification:
                session.recordingQuality.transportVerification,
            }
          : {}),
        canonicalVerification: {
          state: "verified",
          sourceGeneration: rawContentHash,
        },
        sourceLifecycle: retainedLifecycleEvidence(session.recordingQuality),
      });
      const detectedLaps = finalizedRebuiltLaps(rebuilt.laps);
      existingLaps = await getLapsForSession(sessionId);
      const matches = matchReprocessedLaps(detectedLaps, existingLaps);
      const detectedLapNumbers = new Set(
        detectedLaps.map(({ lapNumber }) => lapNumber),
      );
      const canUpdateInPlace =
        detectedLaps.length === existingLaps.length &&
        detectedLapNumbers.size === detectedLaps.length &&
        matches.every(({ preserved }) => preserved !== undefined);
      strategy = canUpdateInPlace ? "in-place" : "replace";
      const activatedEvents = canUpdateInPlace
        ? remapEventsToExistingLaps(rebuilt.events, matches)
        : rebuilt.events;
      const replacementRows = canUpdateInPlace
        ? undefined
        : replacementLaps(matches, attempt.generationId);
      const mergedQuality = mergeReprocessedRecordingQuality(
        session.recordingQuality,
        rebuilt.recordingQuality,
      );
      result = resultProjection(
        sessionId,
        session.sessionType,
        rebuilt,
        rawContentHash,
        attempt.generationId,
      );
      rebuiltLaps = rebuilt.laps.length;

      await db.transaction(async (tx) => {
        if (canUpdateInPlace) {
          const preservedLapIds = matches.map(
            ({ preserved }) => preserved!.id,
          );
          await invalidateLapEvidence(
            {
              lapIds: preservedLapIds,
              sessionId,
              telemetryBoundariesChanged: true,
            },
            tx,
          );
          for (const { detected, preserved } of matches) {
            await updateLapRawIndex(
              {
                lapId: preserved!.id,
                rawByteOffset: detected.rawByteOffset,
                rawFrameCount: detected.rawFrameCount,
                lapTime: detected.lapTime,
                isValid: detected.isValid,
                invalidReason: detected.invalidReason,
                sectors: detected.sectors,
                classification: {
                  phase: detected.phase,
                  conditions: detected.conditions,
                  paceEligibility: detected.paceEligibility,
                },
                quality: detected.quality,
                eligibility: detected.eligibility,
                versionIdentity: detected.versionIdentity,
                analysisGenerationId: attempt!.generationId,
              },
              tx,
            );
          }
        }
        await replaceReplayableSessionArtifacts(
          {
            sessionId,
            events: activatedEvents,
            runs: rebuilt.runs,
            memberships: rebuilt.memberships,
            evidence: rebuilt.evidence,
            ...(replacementRows ? { laps: replacementRows } : {}),
            result: result!,
          },
          tx,
        );
        await updateSessionRawFile(
          sessionId,
          session.rawFile!,
          rebuilt.detectorId,
          versionIdentity,
          tx,
        );
        qualityGeneration = (
          await updateSessionQuality(sessionId, mergedQuality, tx)
        ).provenance.outputGeneration;
        await linkSessionQualityEvents(sessionId, tx);
        await rebuildPersistedSessionRuns(sessionId, tx);
        const latest = await loadRawCaptureIdentity(session.rawFile!);
        if (!latest || latest.contentHash !== rawContentHash) {
          throw new Error("Raw source changed during analysis rebuild");
        }
        const receipt = await createPersistedSessionAnalysisReceipt(
          attempt!,
          gameId,
          tx,
        );
        await activateAnalysisGeneration(
          { generationId: attempt!.generationId, receipt },
          tx,
        );
      });
      return attempt!;

    });
    for (const lap of existingLaps) cacheDelete(lap.id);
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
          code: error instanceof SessionRawFileMissingError
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
