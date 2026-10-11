/**
 * Session reprocessing: replay raw .bin frames through the current lap detector
 * to update lap boundaries after a lap detection algorithm change.
 */
import { getServerGame } from "../games/registry";
import { CapturingDbAdapter, currentTelemetryVersionIdentity } from "../telemetry/pipeline-ports";
import type { GameId } from "@raceiq/shared/games/ids";
import { loadSessionSource, iterateSessionCaptureRecordsFromSource } from "./source-loader";
import { packetIndexToLegacyMotecOffset } from "../motec/source-archive";
import { getLapsForSession, updateLapRawIndex, replaceLapsForSession } from "../db/lap-reprocessing-queries";
import { updateSessionRawFile } from "../db/session-queries";
import { db } from "../db/index";
import { sessions } from "../db/schema";
import { eq } from "drizzle-orm";
import { withSessionCaptureMaintenanceLock } from "./cleanup";
import { applyFrameTime } from "./frame-time";
export interface ReprocessResult {
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
    .select({ rawFile: sessions.rawFile, source: sessions.source, gameId: sessions.gameId, carId: sessions.carId, trackId: sessions.trackId, lapDetectorVersion: sessions.lapDetectorVersion })
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
    carId: session.carId, trackId: session.trackId,
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
    for await (const record of iterateSessionCaptureRecordsFromSource(source, { strict: true })) {
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
  if (existingLaps.length > 0 && detectedLaps.length === 0) {
    throw new Error(`Session ${sessionId} replay detected no laps; preserving ${existingLaps.length} existing lap(s)`);
  }
  const detectedSession = capturingDb.sessions[0];
  const identityChanged = Boolean(detectedSession &&
    ((detectedSession.carId && detectedSession.carId !== session.carId) ||
      (detectedSession.trackId && detectedSession.trackId !== session.trackId)));
  const carId = detectedSession?.carId || session.carId;
  const trackId = detectedSession?.trackId || session.trackId;

  let strategy: "in-place" | "replace";
  let lapsUpdated = 0;

  const frameOrdinals = new Map<number, number>();
  if (loaded?.kind === "packets") {
    for (let index = 0; index < loaded.packets.length; index++) {
      const offset = loaded.offsetEncoding === "packet-index"
        ? index
        : packetIndexToLegacyMotecOffset(gameId, index);
      frameOrdinals.set(offset, index);
    }
  } else {
    let frameIndex = 0;
    for await (const record of iterateSessionCaptureRecordsFromSource(source, { strict: true })) {
      if (record.kind === "frame") frameOrdinals.set(record.offset, frameIndex++);
    }
  }
  const frameInterval = (offset: number | null, count: number): [number, number] | null => {
    if (offset == null || count <= 0) return null;
    const start = frameOrdinals.get(offset);
    return start == null ? null : [start, start + count];
  };
  const overlaps = (a: [number, number] | null, b: [number, number] | null) =>
    a != null && b != null && a[0] < b[1] && b[0] < a[1];
  const sharedFrames = (a: [number, number], b: [number, number]) =>
    Math.min(a[1], b[1]) - Math.max(a[0], b[0]);

  const inPlaceMatches = detectedLaps.map((detected) => {
    const detectedWindow = frameInterval(detected.rawByteOffset, detected.rawFrameCount);
    if (!detectedWindow) return undefined;
    const candidates = existingLaps
      .map((lap) => ({ lap, window: frameInterval(lap.rawByteOffset, lap.rawFrameCount ?? 0) }))
      .filter((candidate): candidate is { lap: typeof existingLaps[number]; window: [number, number] } =>
        candidate.window != null && overlaps(detectedWindow, candidate.window))
      .sort((a, b) => sharedFrames(detectedWindow, b.window) - sharedFrames(detectedWindow, a.window));
    return candidates[0]?.lap;
  });
  const uniqueInPlaceMatches = new Set(inPlaceMatches.filter(Boolean).map((lap) => lap!.id)).size === inPlaceMatches.length;
  if (detectedLaps.length === existingLaps.length && uniqueInPlaceMatches && inPlaceMatches.every((lap, index) => lap?.lapNumber === detectedLaps[index]!.lapNumber) && !identityChanged && session.lapDetectorVersion !== null) {
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
    strategy = "replace";
    const available = [...existingLaps];
    const replacements = detectedLaps.map((detected) => {
      const detectedWindow = frameInterval(detected.rawByteOffset, detected.rawFrameCount);
      const candidates = detectedWindow == null ? [] : available
        .map((lap) => ({ lap, window: frameInterval(lap.rawByteOffset, lap.rawFrameCount ?? 0) }))
        .filter((candidate): candidate is { lap: typeof existingLaps[number]; window: [number, number] } =>
          candidate.window != null && overlaps(detectedWindow, candidate.window))
        .sort((a, b) => sharedFrames(detectedWindow, b.window) - sharedFrames(detectedWindow, a.window));
      const preserved = candidates.length > 0
        ? available.splice(available.findIndex((lap) => lap.id === candidates[0]!.lap.id), 1)[0]
        : undefined;
      return {
        lapId: preserved?.id ?? null,
        lapNumber: detected.lapNumber,
        lapTime: detected.lapTime,
        isValid: detected.isValid,
        isFavorite: preserved?.isFavorite ?? false,
        rawByteOffset: detected.rawByteOffset,
        rawFrameCount: detected.rawFrameCount,
        tuneId: preserved?.tuneId ?? null,
        notes: preserved?.notes ?? null,
        invalidReason: detected.invalidReason,
        sectors: detected.sectors ? [...detected.sectors] : null,
        versionIdentity,
      };
    });
    await replaceLapsForSession(sessionId, replacements, identityChanged ? { carId, trackId } : undefined);
    lapsUpdated = detectedLaps.length;
  }

  await updateSessionRawFile(sessionId, session.rawFile, detector.detectorId, versionIdentity);

  return { sessionId, lapsDetected: detectedLaps.length, lapsUpdated, strategy };
}
