/**
 * Session reprocessing: replay raw .bin frames through the current lap detector
 * to update lap boundaries after a lap detection algorithm change.
 */
import { getServerGame } from "../games/registry";
import { CapturingDbAdapter, currentTelemetryVersionIdentity } from "../telemetry/pipeline-ports";
import type { GameId } from "../../shared/games/ids";
import { loadSessionSource } from "./source-loader";
import { packetIndexToLegacyMotecOffset } from "../motec/source-archive";
import { getLapsForSession, updateLapRawIndex, insertReprocessedLap, deleteLapsForSession } from "../db/lap-reprocessing-queries";
import { updateSessionRawFile } from "../db/session-queries";
import { db } from "../db/index";
import { sessions } from "../db/schema";
import { eq } from "drizzle-orm";
import { readFrameStreamStart, iterateSessionCaptureRecords } from "./framing";
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

  const loaded = await loadSessionSource({
    rawFile: session.rawFile, source: session.source, gameId: session.gameId as GameId,
    carOrdinal: session.carOrdinal, trackOrdinal: session.trackOrdinal,
  });
  const existingLaps = await getLapsForSession(sessionId);
  if (loaded.kind === "capture") {
    const frameStreamStart = readFrameStreamStart(loaded.buffer);
    const hasSegmentBoundaries = [...iterateSessionCaptureRecords(loaded.buffer, frameStreamStart)]
      .some((record) => record.kind === "segment-boundary");
    if (hasSegmentBoundaries) {
      return {
        sessionId,
        lapsDetected: existingLaps.length,
        lapsUpdated: existingLaps.length,
        strategy: "in-place",
      };
    }
  }

  const capturingDb = new CapturingDbAdapter();
  const detector = serverGame.createLapDetector({ db: capturingDb, bypassPacketRateFilter: true });
  if (loaded.kind === "packets") {
    for (let index = 0; index < loaded.packets.length; index++) {
      const offset = loaded.offsetEncoding === "packet-index"
        ? index
        : packetIndexToLegacyMotecOffset(gameId, index);
      await detector.feed(loaded.packets[index], offset);
    }
  } else {
    const buf = loaded.buffer;
    const frameStreamStart = readFrameStreamStart(buf);
    let parserState = serverGame.createParserState?.() ?? null;
    let inContext = false;
    for (const record of iterateSessionCaptureRecords(buf, frameStreamStart)) {
      if (record.kind === "segment-boundary") {
        parserState = serverGame.createParserState?.() ?? null;
        inContext = false;
        continue;
      }
      if (record.kind === "segment-context") {
        inContext = true;
        continue;
      }
      if (record.kind === "segment-context-end") {
        inContext = false;
        continue;
      }
      if (record.kind !== "frame") continue;
      const packet = serverGame.tryParse(record.frame, parserState);
      if (packet && !inContext) await detector.feed(packet, record.offset);
    }
  }

  await detector.flushIncompleteLap?.();

  const detectedLaps = capturingDb.laps;

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
