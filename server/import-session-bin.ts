import { gunzipSync } from "zlib";
import { KNOWN_GAME_IDS, type GameId, type LapMeta } from "../shared/types";
import { getServerGame } from "./games/registry";
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
  private readonly _sessionMeta = new Map<
    number,
    { carOrdinal: number; trackOrdinal: number }
  >();

  async insertSession(
    carOrdinal: number,
    trackOrdinal: number,
    gameId: GameId,
    sessionType?: string
  ): Promise<number> {
    const id = await this._inner.insertSession(carOrdinal, trackOrdinal, gameId, sessionType);
    this._sessionMeta.set(id, { carOrdinal, trackOrdinal });
    return id;
  }

  async insertLap(
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
    const id = await this._inner.insertLap(
      sessionId, lapNumber, lapTime, isValid, rawByteOffset, rawFrameCount, profileId, tuneId, invalidReason, sectors
    );
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
  }

  getLaps(gameId: GameId, limit: number): Promise<LapMeta[]> {
    return this._inner.getLaps(gameId, limit);
  }
  getTuneAssignment(gameId: GameId, carOrdinal: number, trackOrdinal: number) {
    return this._inner.getTuneAssignment(gameId, carOrdinal, trackOrdinal);
  }
  updateSessionRawFile(sessionId: number, rawFile: string, lapDetectorVersion: string): Promise<void> {
    return this._inner.updateSessionRawFile(sessionId, rawFile, lapDetectorVersion);
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
  let buf = bytes;
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    buf = Buffer.from(gunzipSync(buf));
  }

  const serverGame = getServerGame(gameId);
  const state = serverGame.createParserState?.() ?? null;
  const db = new ImportCaptureAdapter();
  const pipeline = new Pipeline(db, new NoopWsAdapter(), { bypassPacketRateFilter: true });

  // Skip the 12-byte meta frame (magic length 0xFFFFFFFF) when present; older
  // meta-less dumps start straight at the first real frame.
  let offset = 0;
  if (buf.length >= 4 && buf.readUInt32LE(0) === META_FRAME_MAGIC) offset = 12;

  let packetCount = 0;
  while (offset + 4 <= buf.length) {
    const len = buf.readUInt32LE(offset);
    offset += 4;
    if (len <= 0 || offset + len > buf.length) break;
    const frame = buf.subarray(offset, offset + len);
    offset += len;
    const packet = serverGame.tryParse(frame, state);
    if (packet) {
      await pipeline.processPacket(packet, frame);
      packetCount++;
    }
  }

  await pipeline.flushIncompleteLap();
  // Lap-detector uses setTimeout(..., 0) for deferred insertLap calls.
  await new Promise<void>((r) => setTimeout(r, 100));

  return { packetCount, laps: db.laps };
}
