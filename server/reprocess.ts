/**
 * Session reprocessing: replay raw .bin frames through the current lap detector
 * to update lap boundaries after a lap detection algorithm change.
 */
import { getServerGame } from "./games/registry";
import { CapturingDbAdapter } from "./pipeline-adapters";
import { META_FRAME_MAGIC } from "./udp-recorder";
import type { GameId } from "../shared/types";
import { gunzip } from "zlib";
import { promisify } from "util";

const gunzipAsync = promisify(gunzip);
import {
  getLapsForSession,
  updateLapRawIndex,
  insertReprocessedLap,
  deleteLapsForSession,
  updateSessionRawFile,
} from "./db/queries";
import { db } from "./db/index";
import { sessions } from "./db/schema";
import { eq } from "drizzle-orm";

export interface ReprocessResult {
  sessionId: number;
  lapsDetected: number;
  lapsUpdated: number;
  strategy: "in-place" | "replace";
}

/**
 * Replay a session's raw .bin file through the current lap detector.
 * Updates lap frame indexes and metadata in the DB.
 */
export async function reprocessSession(sessionId: number): Promise<ReprocessResult> {
  const session = await db
    .select({ rawFile: sessions.rawFile, gameId: sessions.gameId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();

  if (!session?.rawFile) {
    throw new Error(`Session ${sessionId} has no raw file to reprocess`);
  }

  const gameId = session.gameId as GameId;
  const serverGame = getServerGame(gameId);

  // Read the raw session file
  const rawFileHandle = Bun.file(session.rawFile);
  if (!(await rawFileHandle.exists())) {
    throw new Error(`Session ${sessionId} raw file not found: ${session.rawFile}`);
  }
  let buf = Buffer.from(await rawFileHandle.arrayBuffer());
  // Decompress if file is gzipped
  if (session.rawFile.endsWith(".gz")) {
    buf = await gunzipAsync(buf);
  }

  // Skip meta frame at offset 0: [0xFFFFFFFF][payload_len uint32][payload]
  let offset = 0;
  if (buf.length >= 8 && buf.readUInt32LE(0) === META_FRAME_MAGIC) {
    const payloadLen = buf.readUInt32LE(4);
    offset = 8 + payloadLen; // for the current fixed header this is always 12
  }

  // Replay all frames through a capturing lap detector
  const capturingDb = new CapturingDbAdapter();
  const detector = serverGame.createLapDetector({
    db: capturingDb,
    bypassPacketRateFilter: true,
  });
  const parserState = serverGame.createParserState?.() ?? null;

  while (offset < buf.length) {
    if (offset + 4 > buf.length) break;
    const frameLen = buf.readUInt32LE(offset);
    if (frameLen === META_FRAME_MAGIC) {
      if (offset + 8 > buf.length) break;
      const payloadLen = buf.readUInt32LE(offset + 4);
      offset += 8 + payloadLen;
      continue;
    }
    offset += 4;
    if (offset + frameLen > buf.length) break;
    const frameBuf = buf.subarray(offset, offset + frameLen);
    const frameStart = offset - 4; // byte offset of this frame's length prefix
    offset += frameLen;

    const packet = serverGame.tryParse(frameBuf, parserState);
    if (packet) {
      await detector.feed(packet, frameStart);
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
      const sectors = detected.sectors ? { s1: detected.sectors.s1, s2: detected.sectors.s2, s3: detected.sectors.s3 } : null;
      await updateLapRawIndex(
        existing.id,
        detected.rawByteOffset,
        detected.rawFrameCount,
        detected.lapTime,
        detected.isValid,
        sectors
      );
      lapsUpdated++;
    }
  } else {
    // Count changed — delete and re-insert, preserving notes/tuneId by lap number
    strategy = "replace";
    const notesByLapNum = new Map(existingLaps.map(l => [l.lapNumber, { notes: l.notes, tuneId: l.tuneId }]));
    await deleteLapsForSession(sessionId);
    for (const detected of detectedLaps) {
      const preserved = notesByLapNum.get(detected.lapNumber);
      const sectors = detected.sectors ? { s1: detected.sectors.s1, s2: detected.sectors.s2, s3: detected.sectors.s3 } : null;
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
        sectors
      );
      lapsUpdated++;
    }
  }

  // Update session lap detector version
  await updateSessionRawFile(sessionId, session.rawFile, detector.detectorId);

  return {
    sessionId,
    lapsDetected: detectedLaps.length,
    lapsUpdated,
    strategy,
  };
}
