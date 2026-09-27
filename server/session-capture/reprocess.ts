/**
 * Session reprocessing: replay raw .bin frames through the current lap detector
 * to update lap boundaries after a lap detection algorithm change.
 */
import { getServerGame } from "../games/registry";
import { CapturingDbAdapter, currentTelemetryVersionIdentity } from "../telemetry/pipeline-ports";
import type { GameId } from "../../shared/games/ids";
import { loadSessionSource, iterateSessionCaptureRecordsFromSource } from "./source-loader";
import { packetIndexToLegacyMotecOffset } from "../motec/source-archive";
import { getLapsForSession, updateLapRawIndex, insertReprocessedLap, deleteLapsForSession } from "../db/lap-reprocessing-queries";
import { updateSessionRawFile } from "../db/session-queries";
import { db } from "../db/index";
import { sessions } from "../db/schema";
import { eq } from "drizzle-orm";
import { withSessionCaptureMaintenanceLock } from "./cleanup";
import { applyFrameTime } from "./frame-time";
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
  return withSessionCaptureMaintenanceLock(() => reprocessSessionUnlocked(sessionId));
}

async function reprocessSessionUnlocked(sessionId: number): Promise<ReprocessResult> {
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

  const source = {
    rawFile: session.rawFile, source: session.source, gameId,
    carOrdinal: session.carOrdinal, trackOrdinal: session.trackOrdinal,
  };
  const loaded = session.rawFile.endsWith(".motec.zip") ? await loadSessionSource(source) : null;
  const existingLaps = await getLapsForSession(sessionId);

  const capturingDb = new CapturingDbAdapter();
  let detector = serverGame.createLapDetector({ db: capturingDb, bypassPacketRateFilter: true });
  if (loaded?.kind === "packets") {
    for (let index = 0; index < loaded.packets.length; index++) {
      const offset = loaded.offsetEncoding === "packet-index"
        ? index
        : packetIndexToLegacyMotecOffset(gameId, index);
      await detector.feed(loaded.packets[index], offset);
    }
  } else {
    // Canonical captures, including gzip and sparse records, stream one frame
    // at a time; only MoTeC archives require packet materialization.
    let parserState = serverGame.createParserState?.() ?? null;
    let inContext = false;
    let segmentHasFrames = false;
    for await (const record of iterateSessionCaptureRecordsFromSource(source)) {
      if (record.kind === "segment-boundary") {
        // Imports start a fresh detector per segment while retaining the same
        // session. A boundary discards the previous detector's partial lap.
        detector = serverGame.createLapDetector({ db: capturingDb, bypassPacketRateFilter: true });
        detector.expectCompleteLapStart?.();
        parserState = serverGame.createParserState?.() ?? null;
        segmentHasFrames = false;
        inContext = false;
        continue;
      }
      if (record.kind === "segment-context") {
        if (!segmentHasFrames) detector.expectCompleteLapStart?.();
        inContext = true;
        continue;
      }
      if (record.kind === "segment-context-end") {
        inContext = false;
        continue;
      }
      if (record.kind !== "frame") continue;
      if (!inContext) segmentHasFrames = true;
      const packet = serverGame.tryParse(record.frame, parserState);
      if (packet && !inContext) {
        applyFrameTime(packet, record.frameTimeMs);
        await detector.feed(packet, record.offset);
      }
    }
  }

  await detector.flushIncompleteLap?.();

  const detectedLaps = capturingDb.laps;

  let strategy: "in-place" | "replace";
  let lapsUpdated = 0;

  const matched = new Set<number>();
  const inPlaceMatches = detectedLaps.map((detected) => {
    const existing = existingLaps.find((lap) => lap.lapNumber === detected.lapNumber && lap.rawByteOffset === detected.rawByteOffset && !matched.has(lap.id))
      ?? existingLaps.find((lap) => lap.lapNumber === detected.lapNumber && !matched.has(lap.id));
    if (existing) matched.add(existing.id);
    return existing;
  });
  if (detectedLaps.length === existingLaps.length && inPlaceMatches.every(Boolean)) {
    strategy = "in-place";
    for (let index = 0; index < detectedLaps.length; index++) {
      const detected = detectedLaps[index]!;
      const existing = inPlaceMatches[index]!;
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
    // Rebuild when count or lap numbers change. Offset matches preserve notes,
    // tune links and favourites even when detector changes a lap's number.
    strategy = "replace";
    const available = [...existingLaps];
    const replacements = detectedLaps.map((detected) => {
      const exact = detected.rawByteOffset == null ? -1
        : available.findIndex((lap) => lap.rawByteOffset === detected.rawByteOffset);
      const byNumber = exact >= 0 ? exact
        : available.findIndex((lap) => lap.lapNumber === detected.lapNumber);
      const preserved = byNumber >= 0 ? available.splice(byNumber, 1)[0] : undefined;
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
        preserved?.isFavorite ?? false,
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
