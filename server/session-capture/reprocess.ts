/** Deterministic, atomic raw-session rebuild. */
import { eq } from "drizzle-orm";
import type { GameId } from "../../shared/games/ids";
import {
  RaceEventsReplacedMessageSchema,
} from "../../shared/racing/events/contracts";
import { SessionRunsReplacedMessageSchema } from "../../shared/racing/runs/contracts";
import {
  LOCAL_PLAYER_EVIDENCE,
  type EvidenceSourceKind,
  type SourceLifecycleEvidence,
} from "../../shared/racing/quality/contracts";
import { db } from "../db";
import { getLapsForSession } from "../db/lap-reprocessing-queries";
import { cacheDelete } from "../db/telemetry-replay-storage";
import {
  replaceReplayableSessionArtifacts,
  type RaceEventResultProjection,
  type ReplayableLapReplacement,
} from "../db/race-event-queries";
import { rebuildPersistedSessionRuns } from "../db/session-run-queries";
import { linkSessionQualityEvents } from "../db/quality-event-queries";
import { sessions } from "../db/schema";
import {
  updateSessionQuality,
  updateSessionRawFile,
} from "../db/session-queries";
import { extractRaceSource } from "../race-results/source";
import { deriveRaceResult, normalizeSessionType } from "../race-results/derive";
import { rebuildRaceEventTimeline } from "../race-events/rebuild";
import { wsManager } from "../runtime/websocket-manager";
import {
  gunzipBuffer,
  iterateSessionFrameRecords,
  readFrameStreamStart,
} from "./framing";
import {
  rawCaptureObjectId,
  sha256ContentHash,
} from "./identity";
import { mergeReprocessedRecordingQuality } from "./reprocess-quality";
import { currentTelemetryVersionIdentity } from "../telemetry/pipeline-ports";

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
    const kind = fact.code === "source_reconnect"
      ? "reconnect"
      : fact.code === "timeline_discontinuity"
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
  existing: Awaited<ReturnType<typeof getLapsForSession>>,
): ReplayableLapReplacement[] {
  const candidates = new Map<number, typeof existing>();
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
      profileId: lap.profileId,
      tuneId: preserved?.tuneId ?? lap.tuneId,
      sectorTimes: lap.sectors,
      rawByteOffset: lap.rawByteOffset,
      rawFrameCount: lap.rawFrameCount,
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

function resultProjection(
  sessionId: number,
  gameId: GameId,
  sessionType: string | null,
  rebuilt: Awaited<ReturnType<typeof rebuildRaceEventTimeline>>,
  rawContentHash: string,
): RaceEventResultProjection {
  const source = extractRaceSource(gameId, rebuilt.packets);
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
    canonicalInput: rebuilt.packets.length === 0 ? null : {
      sessionId: String(sessionId),
      firstSequence: 0,
      lastSequence: rebuilt.packets.length - 1,
      contentHash: sha256ContentHash(
        Buffer.from(rebuilt.packets.map((packet) => JSON.stringify(packet)).join("\n")),
      ),
    },
  };
  return {
    processorVersion: "race-result-v4",
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

export async function reprocessSession(sessionId: number): Promise<ReprocessResult> {
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
  if (!(await file.exists())) throw new SessionRawFileMissingError(sessionId, session.rawFile);
  const stored = Buffer.from(await file.arrayBuffer());
  const bytes = session.rawFile.endsWith(".gz") ? await gunzipBuffer(stored) : stored;
  const frameStreamStart = readFrameStreamStart(bytes);
  const gameId = session.gameId as GameId;
  const sourceKind = (session.source as EvidenceSourceKind | null) ?? "unknown";
  const versionIdentity = currentTelemetryVersionIdentity(gameId);
  const rawContentHash = sha256ContentHash(bytes);
  const sourceVerification = session.recordingQuality?.archiveVerification ?? {
    state: "unknown" as const,
    sourceGeneration: "legacy",
    details: "Original source verification is unavailable",
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
  const rebuilt = await rebuildRaceEventTimeline({
    sessionId,
    gameId,
    frames,
    sourceKind,
    participant: session.recordingQuality?.participant ?? LOCAL_PLAYER_EVIDENCE,
    versionIdentity,
    ...(session.sourceChannelProfile
      ? { sourceChannelProfile: session.sourceChannelProfile }
      : {}),
    sourceVerification,
    ...(session.recordingQuality?.transportVerification
      ? { transportVerification: session.recordingQuality.transportVerification }
      : {}),
    canonicalVerification: { state: "verified", sourceGeneration: rawContentHash },
    sourceLifecycle: retainedLifecycleEvidence(session.recordingQuality),
  });
  const existingLaps = await getLapsForSession(sessionId);
  const laps = replacementLaps(rebuilt.laps, existingLaps);
  const strategy = rebuilt.laps.length === existingLaps.length ? "in-place" as const : "replace" as const;
  const mergedQuality = mergeReprocessedRecordingQuality(
    session.recordingQuality,
    rebuilt.recordingQuality,
  );
  const result = resultProjection(sessionId, gameId, session.sessionType, rebuilt, rawContentHash);
  let qualityGeneration = mergedQuality.provenance.outputGeneration;

  await db.transaction(async (tx) => {
    await replaceReplayableSessionArtifacts(
      {
        sessionId,
        events: rebuilt.events,
        runs: rebuilt.runs,
        memberships: rebuilt.memberships,
        evidence: rebuilt.evidence,
        laps,
        result,
      },
      tx,
    );
    await updateSessionRawFile(sessionId, session.rawFile!, rebuilt.detectorId, versionIdentity, tx);
    qualityGeneration = (await updateSessionQuality(sessionId, mergedQuality, tx)).provenance.outputGeneration;
    await linkSessionQualityEvents(sessionId, tx);
    await rebuildPersistedSessionRuns(sessionId, tx);
  });
  for (const lap of existingLaps) cacheDelete(lap.id);

  wsManager.broadcastNotification(
    RaceEventsReplacedMessageSchema.parse({ type: "race-events-replaced", sessionId }),
  );
  wsManager.broadcastNotification(
    SessionRunsReplacedMessageSchema.parse({
      type: "session-runs-replaced",
      sessionId,
    }),
  );
  wsManager.broadcastNotification({
    type: "race-result-reconciled",
    sessionId,
    status: result.outcomeStatus === "confirmed" ? "enriched" : "ambiguous",
  });
  wsManager.broadcastNotification({
    type: "quality-updated",
    sessionId,
    qualityGeneration,
  });
  return {
    sessionId,
    lapsDetected: rebuilt.laps.length,
    lapsUpdated: rebuilt.laps.length,
    strategy,
  };
}
