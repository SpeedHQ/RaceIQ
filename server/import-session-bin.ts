import { gunzipSync } from "zlib";
import { existsSync, unlinkSync } from "fs";
import { KNOWN_GAME_IDS, type GameId, type LapMeta } from "../shared/types";
import { deleteSession } from "./db/queries";
import { getAllServerGames, getServerGame } from "./games/registry";
import { Pipeline } from "./pipeline";
import { RealDbAdapter, type DbAdapter, type WsAdapter } from "./pipeline-adapters";
import { META_FRAME_MAGIC } from "./udp-recorder";

export class NoopWsAdapter implements WsAdapter {
  broadcast(): void {}
  broadcastNotification(): void {}
  broadcastDevState(): void {}
}

export interface ImportedLap {
  lapId: number;
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  carOrdinal: number;
  trackOrdinal: number;
}

/**
 * Delegates to RealDbAdapter but captures the returned lap IDs + session
 * metadata so an import caller can tell the UI what got inserted and build
 * deep links into the analyse page.
 */
export class ImportCaptureAdapter implements DbAdapter {
  private readonly _inner = new RealDbAdapter();
  readonly laps: ImportedLap[] = [];
  readonly sessionIds = new Set<number>();
  readonly rawFiles = new Set<string>();
  private readonly _pendingLapWrites = new Set<Promise<number>>();
  private _lapWriteFailure: unknown;
  private readonly _sessionMeta = new Map<
    number,
    { carOrdinal: number; trackOrdinal: number }
  >();

  async insertSession(
    carOrdinal: number,
    trackOrdinal: number,
    gameId: GameId,
    sessionType?: string,
  ): Promise<number> {
    const id = await this._inner.insertSession(
      carOrdinal,
      trackOrdinal,
      gameId,
      sessionType,
    );
    this.sessionIds.add(id);
    this._sessionMeta.set(id, { carOrdinal, trackOrdinal });
    return id;
  }

  insertLap(
    sessionId: number,
    lapNumber: number,
    lapTime: number,
    isValid: boolean,
    rawByteOffset: number | null,
    rawFrameCount: number,
    profileId: number | null,
    tuneId: number | null,
    invalidReason: string | null,
    sectors: { s1: number; s2: number; s3: number } | null
  ): Promise<number> {
    const pending = this._inner.insertLap(
      sessionId, lapNumber, lapTime, isValid, rawByteOffset, rawFrameCount, profileId, tuneId, invalidReason, sectors
    ).then((id) => {
      const meta = this._sessionMeta.get(sessionId);
      this.laps.push({
        lapId: id,
        sessionId,
        lapNumber,
        lapTime,
        isValid,
        carOrdinal: meta?.carOrdinal ?? 0,
        trackOrdinal: meta?.trackOrdinal ?? 0,
      });
      return id;
    });
    this._pendingLapWrites.add(pending);
    void pending.then(
      () => this._pendingLapWrites.delete(pending),
      (error) => {
        this._pendingLapWrites.delete(pending);
        this._lapWriteFailure ??= error;
      },
    );
    return pending;
  }

  setLapMetrics(lapId: number, fuelPerLap: number | null, tyreWear: number | null): Promise<void> {
    return this._inner.setLapMetrics(lapId, fuelPerLap, tyreWear);
  }
  getLaps(gameId: GameId, limit: number): Promise<LapMeta[]> {
    return this._inner.getLaps(gameId, limit);
  }
  getTuneAssignment(gameId: GameId, carOrdinal: number, trackOrdinal: number) {
    return this._inner.getTuneAssignment(gameId, carOrdinal, trackOrdinal);
  }
  updateSessionRawFile(sessionId: number, rawFile: string, lapDetectorVersion: string): Promise<void> {
    this.rawFiles.add(rawFile);
    return this._inner.updateSessionRawFile(sessionId, rawFile, lapDetectorVersion);
  }
  updateSessionCarTrack(sessionId: number, carOrdinal: number, trackOrdinal: number): Promise<void> {
    this._sessionMeta.set(sessionId, { carOrdinal, trackOrdinal });
    return this._inner.updateSessionCarTrack(sessionId, carOrdinal, trackOrdinal);
  }
  getLapsForExclusionScope(tuningSessionId: number, tuneId: number) {
    return this._inner.getLapsForExclusionScope(tuningSessionId, tuneId);
  }
  setLapAutoExclusion(lapId: number, excluded: boolean): Promise<void> {
    return this._inner.setLapAutoExclusion(lapId, excluded);
  }
  getLapTuningScope(lapId: number) {
    return this._inner.getLapTuningScope(lapId);
  }

  async waitForPendingLapWrites(): Promise<void> {
    while (this._pendingLapWrites.size > 0) {
      await Promise.allSettled([...this._pendingLapWrites]);
    }
    if (this._lapWriteFailure) throw this._lapWriteFailure;
  }

  /**
   * Best-effort rollback for an isolated file import. The recorder must be
   * stopped before this runs so no process still owns the canonical capture.
   */
  async rollback(): Promise<void> {
    for (const sessionId of this.sessionIds) {
      await deleteSession(sessionId);
    }
    for (const rawFile of this.rawFiles) {
      if (existsSync(rawFile)) unlinkSync(rawFile);
    }
    this.laps.length = 0;
  }
}

/** Detect a gameId from an uploaded filename prefix (`<gameId>-...` / `<gameId>_...`). */
export function detectGameIdFromFilename(name: string): GameId | null {
  const sorted = [...KNOWN_GAME_IDS].sort((a, b) => b.length - a.length);
  for (const id of sorted) {
    if (name.startsWith(`${id}-`) || name.startsWith(`${id}_`)) return id;
  }
  return null;
}

function decompressIfGz(bytes: Buffer): Buffer {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return Buffer.from(gunzipSync(bytes));
  }
  return bytes;
}

/** Session-capture framing: optional 12-byte meta frame, then repeated [uint32 LE len][frame]. */
function* iterateFrames(buf: Buffer): Generator<Buffer> {
  let offset = 0;
  if (buf.length >= 4 && buf.readUInt32LE(0) === META_FRAME_MAGIC) offset = 12;
  while (offset + 4 <= buf.length) {
    const len = buf.readUInt32LE(offset);
    offset += 4;
    if (len <= 0 || offset + len > buf.length) break;
    yield buf.subarray(offset, offset + len);
    offset += len;
  }
}

export type SessionFrameSource =
  | Iterable<Buffer>
  | AsyncIterable<Buffer>;

export interface ImportSessionFramesOptions {
  /** Roll back the imported session and capture when no complete lap exists. */
  requireLaps?: boolean;
}

/**
 * Feed any canonical raw-frame stream through an isolated parser + pipeline.
 * The normal Pipeline recorder writes the imported source back out as RaceIQ's
 * standard session `.bin`, so replay/export/reprocessing work identically no
 * matter which source format supplied the frames.
 */
export async function importSessionFrames(
  frames: SessionFrameSource,
  gameId: GameId,
  options: ImportSessionFramesOptions = {},
): Promise<{
  packetCount: number;
  laps: ImportedLap[];
  sessionIds: number[];
}> {
  const serverGame = getServerGame(gameId);
  const state = serverGame.createParserState?.() ?? null;
  const db = new ImportCaptureAdapter();
  const pipeline = new Pipeline(db, new NoopWsAdapter(), {
    bypassPacketRateFilter: true,
  });

  let packetCount = 0;
  let failure: unknown;
  try {
    for await (const frame of frames) {
      const packet = serverGame.tryParse(frame, state);
      if (!packet) continue;
      await pipeline.processPacket(packet, frame);
      packetCount++;
    }

    await pipeline.flushIncompleteLap();
    await db.waitForPendingLapWrites();
  } catch (error) {
    failure = error;
  } finally {
    try {
      await pipeline.flushSessionRecorder();
    } catch (error) {
      failure ??= error;
    }
  }

  if (failure) {
    await db.rollback();
    throw failure;
  }
  if (options.requireLaps && db.laps.length === 0) {
    await db.rollback();
    throw new Error("No complete, importable laps were found");
  }

  return {
    packetCount,
    laps: db.laps,
    sessionIds: [...db.sessionIds],
  };
}

/**
 * Detect a gameId from the actual frame content of a session .bin capture,
 * by probing each registered game's `canHandle()` — the same detection every
 * adapter already does for live UDP dispatch (server/parsers/index.ts). This
 * doesn't depend on the uploaded filename following any naming convention.
 */
export function detectGameIdFromBuffer(bytes: Buffer): GameId | null {
  const buf = decompressIfGz(bytes);
  const games = getAllServerGames();
  let checked = 0;
  for (const frame of iterateFrames(buf)) {
    for (const game of games) {
      if (game.canHandle(frame)) return game.id;
    }
    checked++;
    if (checked >= 20) break;
  }
  return null;
}

/**
 * Feed a session `.bin` capture through the full pipeline (parser → lap
 * detection → DB writes) so its laps land in the database as a fresh session.
 *
 * Handles the canonical session recording format for every game: an optional
 * 12-byte meta frame at offset 0, then repeated `[uint32 LE len][frame bytes]`.
 * Each frame is whatever the live recorder wrote as `rawBuf` — a raw UDP packet
 * (Forza/F1) or a packed shared-memory triplet (ACC/AC Evo) — so the game's
 * `tryParse` decodes it exactly as it does when re-materializing stored laps.
 *
 * Accepts gzip'd input (detected by magic bytes) regardless of extension.
 */
export async function importSessionBin(
  bytes: Buffer,
  gameId: GameId
): Promise<{ packetCount: number; laps: ImportedLap[] }> {
  const buf = decompressIfGz(bytes);
  const { packetCount, laps } = await importSessionFrames(
    iterateFrames(buf),
    gameId,
  );
  return { packetCount, laps };
}
