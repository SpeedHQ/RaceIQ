/**
 * Session reprocessing: replay raw .bin frames through the current lap detector
 * to update lap boundaries after a lap detection algorithm change.
 */
import { getServerGame } from "../games/registry";
import { CapturingDbAdapter, currentTelemetryVersionIdentity } from "../telemetry/pipeline-ports";
import type { GameId } from "@raceiq/shared/games/ids";
import { loadSessionSource, iterateSessionCaptureRecordsFromSource, loadCaptureManifest, resolveLapCaptureArtifact } from "./source-loader";
import { packetIndexToLegacyMotecOffset } from "../motec/source-archive";
import { getLapsForSession, updateLapRawIndex, replaceLapsForSession } from "../db/lap-reprocessing-queries";
import { liveCaptures, sessions } from "../db/schema";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { enqueueSessionCaptureSplit, updateSessionRawFile } from "../db/session-queries";
import { withSessionCaptureMaintenanceLock } from "./cleanup";
import { PARSER_BOOTSTRAP_VERSION } from "@raceiq/capture-formats/session/framing";
import { applyFrameTime } from "./frame-time";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { isDelayedFinishContext } from "../db/telemetry-replay-storage";
import { randomUUID } from "node:crypto";
import { StrategyRebuild } from "../live-strategy/strategy-rebuild";
import { activateStrategyRebuild } from "../db/strategy-queries";
import { STRATEGY_ALGORITHM_VERSION } from "../live-strategy/lap-metrics";
import type { LapDetectorCallbacks } from "../lap-detection/types";
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
  const result = await withSessionCaptureMaintenanceLock(() => reprocessSessionUnlocked(sessionId));
  await enqueueSessionCaptureSplit(sessionId);
  return result;
}

async function reprocessSessionUnlocked(sessionId: number): Promise<ReprocessResult> {
  const sessionRows = await db
    .select({ rawFile: sessions.rawFile, source: sessions.source, gameId: sessions.gameId, carId: sessions.carId, trackId: sessions.trackId, ownership: sessions.ownership, createdAt: sessions.createdAt, lapDetectorVersion: sessions.lapDetectorVersion, captureFormatVersion: sessions.captureFormatVersion })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .all();
  const liveCapture = await db.select({ status: liveCaptures.status }).from(liveCaptures)
    .where(eq(liveCaptures.sessionId, sessionId)).get();
  if (liveCapture && ["recording", "finalizing", "recovering"].includes(liveCapture.status)) {
    throw new Error(`Session ${sessionId} live capture is ${liveCapture.status}; reprocess after capture recovery/seal`);
  }
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
    carId: session.carId, trackId: session.trackId, captureFormatVersion: session.captureFormatVersion,
  };
  const loaded = session.rawFile.endsWith(".motec.zip") ? await loadSessionSource(source) : null;
  const existingLaps = await getLapsForSession(sessionId);
  const capturingDb = new CapturingDbAdapter();
  const createdAt = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(session.createdAt) ? session.createdAt : `${session.createdAt}Z`).toISOString();
  const strategyRebuild = new StrategyRebuild(sessionId, session.ownership === "mine" ? "local-player" : `unidentified-source:${sessionId}`, createdAt);
  const callbacks: LapDetectorCallbacks = {
    onLapComplete: (event) => strategyRebuild.prepare(event),
    onLapSaved: (event) => strategyRebuild.saved(event, capturingDb.getCapturedLap(event.lapId)),
  };
  let detector = serverGame.createLapDetector({ db: capturingDb, bypassPacketRateFilter: true, callbacks });
  let unownedCompletionTail = false;
  if (loaded?.kind === "packets") {
    for (let index = 0; index < loaded.packets.length; index++) {
      const offset = loaded.offsetEncoding === "packet-index"
        ? index
        : packetIndexToLegacyMotecOffset(gameId, index);
      strategyRebuild.ensure(loaded.packets[index]);
      await detector.feed(loaded.packets[index], offset);
      strategyRebuild.observe(loaded.packets[index]);
    }
  } else {
    // Canonical captures, including gzip and sparse records, stream one frame
    // at a time; only MoTeC archives require packet materialization.
    let parserState: unknown = serverGame.createParserState?.() ?? null;
    let inContext = false;
    let segmentHasFrames = false;
    let lastOwnedPacket: TelemetryPacket | null = null;
    let sourceOrdinal = 0;
    for await (const record of iterateSessionCaptureRecordsFromSource(source, { strict: true })) {
      if (record.kind === "segment-boundary") {
        // Imports start a fresh detector per segment while retaining the same
        // session. A boundary discards the previous detector's partial lap.
        strategyRebuild.breakSegment();
        detector = serverGame.createLapDetector({ db: capturingDb, bypassPacketRateFilter: true, callbacks });
        detector.expectCompleteLapStart?.();
        parserState = serverGame.createParserState?.() ?? null;
        segmentHasFrames = false;
        inContext = false;
        lastOwnedPacket = null;
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
      if (record.kind === "parser-bootstrap") {
        if (record.gameId !== gameId || record.formatVersion !== PARSER_BOOTSTRAP_VERSION) {
          throw new Error("Parser bootstrap does not match reprocessed game");
        }
        if (!serverGame.restoreParserCheckpoint) throw new Error(`Parser checkpoint restore unavailable for ${gameId}`);
        parserState = serverGame.restoreParserCheckpoint(parserState, record.payload);
        inContext = false;
        continue;
      }
      if (record.kind !== "frame") continue;
      const ordinal = sourceOrdinal++;
      const packet = serverGame.tryParse(record.frame, parserState);
      if (!packet) continue;
      applyFrameTime(packet, record.frameTimeMs);
      if (inContext) {
        // Completion context may finish the preceding lap, but never owns source records.
        if (lastOwnedPacket && (packet.LapNumber > lastOwnedPacket.LapNumber ||
            isDelayedFinishContext(lastOwnedPacket, packet))) {
          await detector.feed(packet, undefined, ordinal);
          unownedCompletionTail = true;
        }
      } else {
        segmentHasFrames = true;
        unownedCompletionTail = false;
        lastOwnedPacket = packet;
        strategyRebuild.ensure(packet);
        await detector.feed(packet, record.offset, ordinal);
        strategyRebuild.observe(packet);
      }
    }
    // Native-wire manifests intentionally expose owned frames only. The final lap's
    // independently replayable artifact retains its real finish-line context.
    if (source.rawFile.endsWith("manifest.json") && lastOwnedPacket) {
      const manifest = await loadCaptureManifest(source.rawFile);
      const tail = manifest.chunks.findLast((chunk) => chunk.kind === "lap");
      if (tail && (tail.trailingContextFrameCount ?? 0) > 0) {
        const artifact = await resolveLapCaptureArtifact(source.rawFile, tail.id);
        let frames = 0;
        let trailing = 0;
        for await (const record of iterateSessionCaptureRecordsFromSource({ ...source, rawFile: artifact.path, artifact: artifact.artifact }, { strict: true })) {
          if (record.kind !== "frame" || record.offset < tail.ownedFrameByteOffset!) continue;
          if (frames++ < tail.ownedFrameCount!) continue;
          if (trailing++ >= (tail.trailingContextFrameCount ?? 0)) break;
          const packet = serverGame.tryParse(record.frame, parserState);
          if (!packet) continue;
          applyFrameTime(packet, record.frameTimeMs);
          if (packet.LapNumber > lastOwnedPacket.LapNumber || isDelayedFinishContext(lastOwnedPacket, packet)) {
            await detector.feed(packet, undefined, sourceOrdinal++);
            unownedCompletionTail = true;
          }
        }
      }
    }
  }

  if (!unownedCompletionTail) await detector.flushIncompleteLap?.();
  const detectedLaps = capturingDb.laps;
  strategyRebuild.finish();
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
  if (detectedLaps.length === existingLaps.length && uniqueInPlaceMatches &&
      inPlaceMatches.every((lap, index) => lap?.lapNumber === detectedLaps[index]!.lapNumber &&
        lap.rawByteOffset === detectedLaps[index]!.rawByteOffset && lap.rawFrameCount === detectedLaps[index]!.rawFrameCount) &&
      !identityChanged && session.lapDetectorVersion !== null) {
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
  const savedLaps = await getLapsForSession(sessionId);
  const byWindow = new Map(savedLaps.map((lap) => [`${lap.rawByteOffset}:${lap.rawFrameCount}:${lap.lapNumber}`, lap.id]));
  const contributions = strategyRebuild.contributions.map((entry) => {
    const window = entry.window;
    const lapId = window ? byWindow.get(`${window.rawByteOffset}:${window.rawFrameCount}:${window.lapNumber}`) : undefined;
    if (lapId == null) throw new Error("Strategy rebuild could not associate a completed source lap with its saved identity");
    const summary = entry.accumulator.snapshot();
    return { sessionId, driverKey: summary.driverKey, lapId, stintId: summary.id, algorithmVersion: STRATEGY_ALGORITHM_VERSION, contribution: entry.contribution };
  });
  await activateStrategyRebuild(sessionId, { gameId, carId, trackId, ownership: session.ownership }, randomUUID(),
    strategyRebuild.accumulators.map((accumulator) => ({ summary: accumulator.snapshot(), totals: accumulator.totals() })), contributions);

  return { sessionId, lapsDetected: detectedLaps.length, lapsUpdated, strategy };
}
