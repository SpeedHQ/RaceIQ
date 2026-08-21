/**
 * Session reprocessing: replay raw .bin frames through the current lap detector
 * to update lap boundaries after a lap detection algorithm change.
 */
import { getServerGame } from "../games/registry";
import { CapturingDbAdapter, currentTelemetryVersionIdentity } from "../telemetry/pipeline-ports";
import type { GameId } from "../../shared/games/ids";
import { gunzipBuffer, iterateSessionFrameRecords, readFrameStreamStart } from "./framing";
import { getLapsForSession, updateLapRawIndex, insertReprocessedLap, deleteLapsForSession } from "../db/lap-reprocessing-queries";
import { updateSessionQuality, updateSessionRawFile } from "../db/session-queries";
import { db } from "../db/index";
import { sessions } from "../db/schema";
import { eq } from "drizzle-orm";
import { LOCAL_PLAYER_EVIDENCE, type EvidenceSourceKind } from "../../shared/racing/quality/contracts";
import { RecordingQualityAccumulator } from "../../shared/racing/quality/measure";
import { sha256ContentHash } from "./identity";
import { linkSessionQualityEvents } from "../db/quality-event-queries";
import { mergeReprocessedRecordingQuality } from "./reprocess-quality";

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

/**
 * Replay a session's raw .bin file through the current lap detector.
 * Updates lap frame indexes and metadata in the DB.
 */
export async function reprocessSession(sessionId: number): Promise<ReprocessResult> {
  const session = await db
    .select({
      rawFile: sessions.rawFile,
      gameId: sessions.gameId,
      source: sessions.source,
      recordingQuality: sessions.recordingQuality,
      sourceChannelProfile: sessions.sourceChannelProfile,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();

  if (!session) {
    throw new SessionNotFoundError(sessionId);
  }
  if (!session.rawFile) {
    throw new SessionRawFileMissingError(sessionId);
  }

  const gameId = session.gameId as GameId;
  const serverGame = getServerGame(gameId);
  const versionIdentity = currentTelemetryVersionIdentity(gameId);
  const sourceKind = (session.source as EvidenceSourceKind | null) ?? "unknown";
  const participant = session.recordingQuality?.participant ?? LOCAL_PLAYER_EVIDENCE;
  const recordingQuality = new RecordingQualityAccumulator(sourceKind, participant, versionIdentity);

  // Read the raw session file
  const rawFileHandle = Bun.file(session.rawFile);
  if (!(await rawFileHandle.exists())) {
    throw new SessionRawFileMissingError(sessionId, session.rawFile);
  }
  const rawBuffer = Buffer.from(await rawFileHandle.arrayBuffer());
  // Decompress if file is gzipped
  const buf = session.rawFile.endsWith(".gz") ? await gunzipBuffer(rawBuffer) : rawBuffer;

  const frameStreamStart = readFrameStreamStart(buf);

  // Replay all frames through a capturing lap detector
  const capturingDb = new CapturingDbAdapter();
  const detector = serverGame.createLapDetector({
    db: capturingDb,
    bypassPacketRateFilter: true,
    sourceKind,
    participant,
    sourceChannelProfile: session.sourceChannelProfile ?? undefined,
    versionIdentity,
  });
  const parserState = serverGame.createParserState?.() ?? null;

  for (const { offset, frame } of iterateSessionFrameRecords(buf, frameStreamStart, {
    skipMetaFrames: true,
    allowEmptyFrames: false,
    strict: true,
    validateDeclaredFrameCount: true,
  })) {
    const packet = serverGame.tryParse(frame, parserState);
    if (packet) {
      recordingQuality.observe(packet);
      await detector.feed(packet, offset);
    }
  }

  await detector.flushIncompleteLap?.();

  const detectedLaps = capturingDb.laps;
  const existingLaps = await getLapsForSession(sessionId);

  let strategy: "in-place" | "replace";
  let lapsUpdated = 0;

  if (detectedLaps.length === existingLaps.length) {
    // Same count — update frame indexes and metadata in-place, matched by lap number
    strategy = "in-place";
    const existingByLapNum = new Map(existingLaps.map((l) => [l.lapNumber, l]));
    for (const detected of detectedLaps) {
      const existing = existingByLapNum.get(detected.lapNumber);
      if (!existing) continue;
      const sectors = detected.sectors ? [...detected.sectors] : null;
      await updateLapRawIndex({
        lapId: existing.id,
        rawByteOffset: detected.rawByteOffset,
        rawFrameCount: detected.rawFrameCount,
        lapTime: detected.lapTime,
        isValid: detected.isValid,
        invalidReason: detected.invalidReason,
        sectors,
        classification: {
          phase: detected.phase,
          conditions: detected.conditions,
          paceEligibility: detected.paceEligibility,
        },
        quality: detected.quality!,
        eligibility: detected.eligibility!,
        versionIdentity,
      });
      lapsUpdated++;
    }
  } else {
    // Count changed — rebuild detected laps. Match old rows by lap number and
    // raw offset so notes and tune links survive on detected replacements.
    // Existing rows without a detected replacement are removed.
    strategy = "replace";
    const candidatesByLapNumber = new Map<number, (typeof existingLaps)[number][]>();
    for (const existing of existingLaps) {
      const candidates = candidatesByLapNumber.get(existing.lapNumber);
      if (candidates) candidates.push(existing);
      else candidatesByLapNumber.set(existing.lapNumber, [existing]);
    }
    const replacements = detectedLaps.map((detected) => {
      const candidates = candidatesByLapNumber.get(detected.lapNumber) ?? [];
      const exactIndex = candidates.findIndex((candidate) => candidate.rawByteOffset === detected.rawByteOffset);
      const candidateIndex = exactIndex >= 0 ? exactIndex : 0;
      const preserved = candidates.length > 0 ? candidates.splice(candidateIndex, 1)[0] : undefined;
      return { detected, preserved };
    });
    await deleteLapsForSession(sessionId);
    for (const { detected, preserved } of replacements) {
      const sectors = detected.sectors ? [...detected.sectors] : null;
      await insertReprocessedLap({
        sessionId,
        lapNumber: detected.lapNumber,
        lapTime: detected.lapTime,
        isValid: detected.isValid,
        rawByteOffset: detected.rawByteOffset,
        rawFrameCount: detected.rawFrameCount,
        tuneId: preserved?.tuneId ?? null,
        notes: preserved?.notes ?? null,
        invalidReason: detected.invalidReason,
        sectors,
        classification: {
          phase: detected.phase,
          conditions: detected.conditions,
          paceEligibility: detected.paceEligibility,
        },
        quality: detected.quality!,
        eligibility: detected.eligibility!,
        versionIdentity,
      });
      lapsUpdated++;
    }
  }

  // Update session lap detector version
  await updateSessionRawFile(sessionId, session.rawFile, detector.detectorId, versionIdentity);
  const sourceVerification = session.recordingQuality?.archiveVerification ?? {
    state: "unknown" as const,
    sourceGeneration: "legacy",
    details: "Original source verification is unavailable",
  };
  const recomputedQuality = recordingQuality.finalize("reprocessed", sourceVerification, {
    transportVerification: session.recordingQuality?.transportVerification,
    canonicalVerification: {
      state: "verified",
      sourceGeneration: sha256ContentHash(buf),
    },
  });
  await updateSessionQuality(sessionId, mergeReprocessedRecordingQuality(session.recordingQuality, recomputedQuality));
  await linkSessionQualityEvents(sessionId);

  return {
    sessionId,
    lapsDetected: detectedLaps.length,
    lapsUpdated,
    strategy,
  };
}
