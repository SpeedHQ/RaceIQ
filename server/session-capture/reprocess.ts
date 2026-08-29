/**
 * Session reprocessing: replay raw .bin frames through the current lap detector
 * to update lap boundaries after a lap detection algorithm change.
 */
import { getServerGame } from "../games/registry";
import { CapturingDbAdapter, currentTelemetryVersionIdentity } from "../telemetry/pipeline-ports";
import type { GameId } from "../../shared/games/ids";
import { loadSessionCapture } from "./source-loader";
import { getLapsForSession, updateLapRawIndex, insertReprocessedLap, deleteLapsForSession } from "../db/lap-reprocessing-queries";
import { updateSessionRawFile } from "../db/session-queries";
import { db } from "../db/index";
import { sessions } from "../db/schema";
import { eq } from "drizzle-orm";
import { readFrameStreamStart, iterateSessionFrameRecords } from "./framing";
interface ReprocessResult {
  sessionId: number;
  lapsDetected: number;
  lapsUpdated: number;
  strategy: "in-place" | "replace";
}

export class SessionRawFileMissingError extends Error {
  constructor(sessionId: number, rawFile?: string) {
    super(
      rawFile
        ? `Session ${sessionId} raw file not found: ${rawFile}`
        : `Session ${sessionId} has no raw file to reprocess`,
    );
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
  const sessionRows = await db
    .select({ rawFile: sessions.rawFile, source: sessions.source, gameId: sessions.gameId, carOrdinal: sessions.carOrdinal, trackOrdinal: sessions.trackOrdinal })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .all();
  const session = sessionRows[0];
  if (!session) {
    throw new SessionNotFoundError(sessionId);
  }
  if (!session.rawFile) {
    throw new SessionRawFileMissingError(sessionId);
  }
  if (!(await Bun.file(session.rawFile).exists())) {
    throw new SessionRawFileMissingError(sessionId, session.rawFile);
  }

  const gameId = session.gameId as GameId;
  const serverGame = getServerGame(gameId);
  const versionIdentity = currentTelemetryVersionIdentity(gameId);

  const buf = await loadSessionCapture({
    rawFile: session.rawFile, source: session.source, gameId: session.gameId as GameId,
    carOrdinal: session.carOrdinal, trackOrdinal: session.trackOrdinal,
  });

  const frameStreamStart = readFrameStreamStart(buf);

  // Replay all frames through a capturing lap detector
  const capturingDb = new CapturingDbAdapter();
  const detector = serverGame.createLapDetector({
    db: capturingDb,
    bypassPacketRateFilter: true,
  });
  const parserState = serverGame.createParserState?.() ?? null;

  for (const { offset, frame } of iterateSessionFrameRecords(
    buf,
    frameStreamStart,
    { skipMetaFrames: true, allowEmptyFrames: true },
  )) {
    const packet = serverGame.tryParse(frame, parserState);
    if (packet) {
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
    const existingByLapNum = new Map(existingLaps.map(l => [l.lapNumber, l]));
    for (const detected of detectedLaps) {
      const existing = existingByLapNum.get(detected.lapNumber);
      if (!existing) continue;
      const sectors = detected.sectors ? [...detected.sectors] : null;
      await updateLapRawIndex(
        existing.id,
        detected.rawByteOffset,
        detected.rawFrameCount,
        detected.lapTime,
        detected.isValid,
        detected.invalidReason,
        sectors,
        versionIdentity,
      );
      lapsUpdated++;
    }
  } else {
    // Count changed — rebuild detected laps. Match old rows by lap number and
    // raw offset so notes and tune links survive on detected replacements.
    // Existing rows without a detected replacement are removed.
    strategy = "replace";
    const candidatesByLapNumber = new Map<
      number,
      (typeof existingLaps)[number][]
    >();
    for (const existing of existingLaps) {
      const candidates = candidatesByLapNumber.get(existing.lapNumber);
      if (candidates) candidates.push(existing);
      else candidatesByLapNumber.set(existing.lapNumber, [existing]);
    }
    const replacements = detectedLaps.map((detected) => {
      const candidates = candidatesByLapNumber.get(detected.lapNumber) ?? [];
      const exactIndex = candidates.findIndex(
        (candidate) =>
          candidate.rawByteOffset === detected.rawByteOffset,
      );
      const candidateIndex = exactIndex >= 0 ? exactIndex : 0;
      const preserved =
        candidates.length > 0
          ? candidates.splice(candidateIndex, 1)[0]
          : undefined;
      return { detected, preserved };
    });
    await deleteLapsForSession(sessionId);
    for (const { detected, preserved } of replacements) {
      const sectors = detected.sectors ? [...detected.sectors] : null;
      await insertReprocessedLap(
        sessionId,
        detected.lapNumber,
        detected.lapTime,
        detected.isValid,
        detected.rawByteOffset,
        detected.rawFrameCount,
        preserved?.tuneId ?? null,
        preserved?.notes ?? null,
        detected.invalidReason,
        sectors,
        versionIdentity,
      );
      lapsUpdated++;
    }
  }

  // Update session lap detector version
  await updateSessionRawFile(
    sessionId,
    session.rawFile,
    detector.detectorId,
    versionIdentity,
  );

  return {
    sessionId,
    lapsDetected: detectedLaps.length,
    lapsUpdated,
    strategy,
  };
}
