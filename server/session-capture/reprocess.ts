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
import { liveCaptures, originalActivitySourceLaps, sessions } from "../db/schema";
import { loadFullOriginalPortableCapture } from "./portable-identity";
import { eq } from "drizzle-orm";
import { readDb } from "../db/index";
import { enqueueSessionCaptureSplit } from "../db/session-queries";
import { withSessionCaptureMaintenanceLock } from "./cleanup";
import { PARSER_BOOTSTRAP_VERSION } from "@raceiq/capture-formats/session/framing";
import { isIRacingSessionFrame } from "@raceiq/capture-formats/iracing/source-frame";
import { applyFrameTime } from "./frame-time";
import { claimOnlineRecordingSourceReprocess, completeOnlineRecordingSourceReprocess, readOnlineRecordingSource, releaseOnlineRecordingSourceReprocess } from "../db/online-recording-source-queries";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { beginSessionSourceMutation, SessionSourceMutationActiveError } from "./source-mutation-activity";
import { isDelayedFinishContext } from "../db/telemetry-replay-storage";
export interface ReprocessResult {
  sessionId: number;
  lapsDetected: number;
  lapsUpdated: number;
  strategy: "in-place" | "replace";
}
type ReprocessRun = { result: ReprocessResult; token: string; generation: number };

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
  const releaseActivity = beginSessionSourceMutation(sessionId);
  let token: string | null = null;
  try {
    const source = await readOnlineRecordingSource(sessionId);
    if (!source) throw new SessionNotFoundError(sessionId);
    const completed = await withSessionCaptureMaintenanceLock(() =>
      reprocessSessionUnlocked(sessionId, source.generation, false, value => { token = value; }));
    await enqueueSessionCaptureSplit(sessionId);
    if (!await completeOnlineRecordingSourceReprocess(sessionId, completed.token, completed.generation)) {
      throw new Error(`Recording source ${sessionId} changed during reprocessing`);
    }
    return completed.result;
  } catch (error) {
    if (token) await releaseOnlineRecordingSourceReprocess(sessionId, token);
    throw error;
  } finally {
    releaseActivity();
  }
}

async function reprocessSessionUnlocked(sessionId: number, expectedGeneration: number, requirePending: boolean,
  onClaim: (token: string) => void): Promise<ReprocessRun> {
  const sessionRows = await readDb.select({
    rawFile: sessions.rawFile, source: sessions.source, gameId: sessions.gameId, carId: sessions.carId,
    trackId: sessions.trackId, lapDetectorVersion: sessions.lapDetectorVersion,
    captureFormatVersion: sessions.captureFormatVersion, originalActivityId: sessions.originalActivityId,
    originalSourceRevision: sessions.originalSourceRevision, nativeCaptureOrigin: sessions.nativeCaptureOrigin,
    ownerUserId: sessions.ownerUserId,
  }).from(sessions).where(eq(sessions.id, sessionId)).all();
  const liveCapture = await readDb.select({ status: liveCaptures.status }).from(liveCaptures)
    .where(eq(liveCaptures.sessionId, sessionId)).get();
  if (liveCapture && ["recording", "finalizing", "recovering"].includes(liveCapture.status)) {
    throw new SessionSourceMutationActiveError(sessionId);
  }
  const session = sessionRows[0];
  if (!session) {
    throw new SessionNotFoundError(sessionId);
  }
  if (session.source === "cloud-import") throw new Error("Cloud-imported laps use committed processing metadata and cannot be reprocessed");
  if (!session.rawFile) {
    throw new SessionRawFileMissingError(sessionId);
  }
  if (!(await Bun.file(session.rawFile).exists())) {
    throw new SessionRawFileMissingError(sessionId, session.rawFile);
  }

  const claim = await claimOnlineRecordingSourceReprocess(sessionId, expectedGeneration, requirePending);
  if (!claim) throw new SessionSourceMutationActiveError(sessionId);
  onClaim(claim.token);
  
  const completedSource = await readOnlineRecordingSource(sessionId);
  if (!completedSource || completedSource.generation !== claim.generation) throw new Error(`Recording source ${sessionId} changed during reprocessing`);
  const requiresOriginalGuidMap = session.nativeCaptureOrigin || session.originalActivityId !== null || session.originalSourceRevision !== null;
  const originalCapture = requiresOriginalGuidMap
    ? await loadFullOriginalPortableCapture(sessionId, { forReprocess: true })
    : null;
  if (requiresOriginalGuidMap && !originalCapture) {
    throw new Error(`Session ${sessionId} cannot be reprocessed safely: authoritative original lapGuid-to-owned-frame-window map or matching source proof is unavailable`);
  }
  const publishedOriginalGuids = new Set<string>();
  if (originalCapture && session.originalActivityId) {
    const ledgerRows = await readDb.select({
      lapGuid: originalActivitySourceLaps.lapGuid, ownerUserId: originalActivitySourceLaps.ownerUserId,
      sourceRevision: originalActivitySourceLaps.sourceRevision,
    }).from(originalActivitySourceLaps).where(eq(originalActivitySourceLaps.originalActivityId, session.originalActivityId)).all();
    for (const row of ledgerRows) {
      if (row.ownerUserId !== session.ownerUserId || row.sourceRevision !== session.originalSourceRevision) {
        throw new Error(`Session ${sessionId} original lap GUID ledger conflicts with retained owner or source revision`);
      }
      publishedOriginalGuids.add(row.lapGuid.toLowerCase());
    }
    for (const guid of publishedOriginalGuids) {
      if (!originalCapture.sourceWindows.has(guid)) {
        throw new Error(`Session ${sessionId} retained original GUID ${guid} has no authoritative source window`);
      }
    }
  }
  const gameId = session.gameId as GameId;
  const serverGame = getServerGame(gameId);
  const versionIdentity = currentTelemetryVersionIdentity(gameId);

  const source = {
    rawFile: session.rawFile, source: session.source, gameId,
    carId: session.carId, trackId: session.trackId, captureFormatVersion: session.captureFormatVersion,
    ...(originalCapture ? { buffer: originalCapture.bytes } : {}),
  };
  const loaded = session.rawFile.endsWith(".motec.zip") ? await loadSessionSource(source) : null;
  const sourceLaps = await getLapsForSession(sessionId);
  const existingLaps = originalCapture ? sourceLaps.map((lap) => {
    if (!lap.lapGuid) throw new Error(`Session ${sessionId} original lap ${lap.id} has no canonical lap GUID`);
    const window = originalCapture.sourceWindows.get(lap.lapGuid.toLowerCase());
    if (!window) throw new Error(`Session ${sessionId} original lap ${lap.id} has no authoritative source window`);
    return { ...lap, rawByteOffset: window.rawByteOffset, rawFrameCount: window.rawFrameCount };
  }) : sourceLaps;
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
    let parserState: unknown = serverGame.createParserState?.() ?? null;
    let inContext = false;
    let segmentHasFrames = false;
    let expectsSessionContext = false;
    let lastOwnedPacket: TelemetryPacket | null = null;
    let sourceOrdinal = 0;
    for await (const record of iterateSessionCaptureRecordsFromSource(source, { strict: true })) {
      if (record.kind === "segment-boundary") {
        // Imports start a fresh detector per segment while retaining the same
        // session. A boundary discards the previous detector's partial lap.
        detector = serverGame.createLapDetector({ db: capturingDb, bypassPacketRateFilter: true });
        detector.expectCompleteLapStart?.();
        expectsSessionContext = true;
        parserState = serverGame.createParserState?.() ?? null;
        segmentHasFrames = false;
        inContext = false;
        lastOwnedPacket = null;
        continue;
      }
      if (record.kind === "segment-context") {
        if (!segmentHasFrames) {
          detector.expectCompleteLapStart?.();
          expectsSessionContext = true;
        }
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
        continue;
      }
      if (record.kind !== "frame") continue;
      const ordinal = sourceOrdinal++;
      const contextOnly = expectsSessionContext && gameId === "iracing" && isIRacingSessionFrame(record.frame);
      const packet = serverGame.tryParse(record.frame, parserState, record.frameTimeMs);
      if (contextOnly) {
        expectsSessionContext = false;
        continue;
      }
      if (!packet) continue;
      expectsSessionContext = false;
      applyFrameTime(packet, record.frameTimeMs);
      if (inContext) {
        // Completion context may finish the preceding lap, but never owns source records.
        if (lastOwnedPacket && (packet.LapNumber > lastOwnedPacket.LapNumber ||
            isDelayedFinishContext(lastOwnedPacket, packet))) {
          await detector.feed(packet, undefined, ordinal);
        }
      } else {
        segmentHasFrames = true;
        lastOwnedPacket = packet;
        await detector.feed(packet, record.offset, ordinal);
      }
    }
  }

  await detector.flushIncompleteLap?.();
  let detectedLaps = capturingDb.laps;
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
  const originalGuidByDetectedOffset = new Map<number, string>();
  if (originalCapture) {
    const localGuids = new Set(existingLaps.flatMap((lap) => lap.lapGuid ? [lap.lapGuid.toLowerCase()] : []));
    const matchedGuids = new Set<string>();
    const sourceWindows = [...originalCapture.sourceWindows].map(([guid, window]) => ({
      guid, window: frameInterval(window.rawByteOffset, window.ownedFrameCount ?? window.rawFrameCount),
    }));
    const retained: typeof detectedLaps = [];
    for (const detected of detectedLaps) {
      if (detected.rawByteOffset === null) throw new Error(`Session ${sessionId} replay produced a lap without an original source offset`);
      const detectedWindow = frameInterval(detected.rawByteOffset, detected.rawFrameCount);
      if (!detectedWindow) throw new Error(`Session ${sessionId} replay lap has no authoritative source frame interval`);
      const matches = sourceWindows.filter(({ window }) => window !== null && overlaps(detectedWindow, window));
      if (matches.length !== 1) throw new Error(`Session ${sessionId} replay lap does not map uniquely to an original lap GUID window`);
      const guid = matches[0]!.guid;
      if (matchedGuids.has(guid)) throw new Error(`Session ${sessionId} replay mapped multiple laps to original GUID ${guid}`);
      matchedGuids.add(guid);
      if (publishedOriginalGuids.has(guid) && !localGuids.has(guid)) continue;
      originalGuidByDetectedOffset.set(detected.rawByteOffset, guid);
      retained.push(detected);
    }
    detectedLaps = retained;
    for (const guid of localGuids) {
      if (!matchedGuids.has(guid)) throw new Error(`Session ${sessionId} replay omitted surviving original lap GUID ${guid}`);
    }
    for (const guid of originalCapture.sourceWindows.keys()) {
      if (!publishedOriginalGuids.has(guid) && !localGuids.has(guid) && !matchedGuids.has(guid)) {
        throw new Error(`Session ${sessionId} replay omitted uncommitted original artifact GUID ${guid}`);
      }
    }
  }
  if (existingLaps.length > 0 && detectedLaps.length === 0) {
    throw new Error(`Session ${sessionId} replay detected no laps; preserving ${existingLaps.length} existing lap(s)`);
  }

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
        detected.classification,
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
      const originalGuid = originalCapture
        ? originalGuidByDetectedOffset.get(detected.rawByteOffset!)
        : undefined;
      if (originalCapture && !originalGuid) throw new Error(`Session ${sessionId} reprocess lost original lap GUID mapping`);
      const sourceWindow = originalGuid ? originalCapture?.sourceWindows.get(originalGuid) : undefined;
      const guidIndex = originalGuid
        ? available.findIndex((lap) => lap.lapGuid?.toLowerCase() === originalGuid)
        : -1;
      const preserved = originalGuid
        ? guidIndex >= 0 ? available.splice(guidIndex, 1)[0] : undefined
        : originalCapture ? undefined
          : candidates.length > 0
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
        classification: detected.classification,
        lapGuid: originalGuid ?? null,
        ...(sourceWindow?.captureChunkId ? { captureChunkId: sourceWindow.captureChunkId } : {}),
        ...(sourceWindow?.sourceFrameStart !== undefined ? { sourceFrameStart: sourceWindow.sourceFrameStart } : {}),
        ...(sourceWindow?.sourceFrameCount !== undefined ? { sourceFrameCount: sourceWindow.sourceFrameCount } : {}),
        versionIdentity,
        sourceFinishedAt: preserved?.sourceFinishedAt ?? null,
      };
    });
    const preserveOriginalSourceArtifacts = Boolean(originalCapture &&
      [...originalCapture.sourceWindows.values()].some((window) => window.captureChunkId !== undefined));
    await replaceLapsForSession(
      sessionId, replacements, identityChanged ? { carId, trackId } : undefined, { preserveOriginalSourceArtifacts },
    );
    lapsUpdated = detectedLaps.length;
  }

  return { result: { sessionId, lapsDetected: detectedLaps.length, lapsUpdated, strategy }, token: claim.token, generation: claim.generation };
}
