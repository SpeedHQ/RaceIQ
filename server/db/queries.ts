import { eq, desc, and, or, sql, inArray, notInArray, isNull } from "drizzle-orm";
import { db } from "./index";
import { sessions, laps, trackCorners, trackOutlines, lapAnalyses, compareAnalyses, profiles, tunes } from "./schema";
import type { TelemetryPacket, LapMeta, SessionMeta, GameId } from "../../shared/types";
import type { Corner } from "../corner-detection";
import { fillNormSuspension } from "../telemetry-utils";
import { getServerGame } from "../games/registry";
import { tryGetGame } from "../../shared/games/registry";
import { gunzip } from "zlib";
import { promisify } from "util";
import { existsSync, unlinkSync } from "fs";

const gunzipAsync = promisify(gunzip);

// Fixed column order for CSV telemetry storage
const TELEMETRY_FIELDS: (keyof TelemetryPacket)[] = [
  "IsRaceOn","TimestampMS","EngineMaxRpm","EngineIdleRpm","CurrentEngineRpm",
  "AccelerationX","AccelerationY","AccelerationZ",
  "VelocityX","VelocityY","VelocityZ",
  "AngularVelocityX","AngularVelocityY","AngularVelocityZ",
  "Yaw","Pitch","Roll",
  "NormSuspensionTravelFL","NormSuspensionTravelFR","NormSuspensionTravelRL","NormSuspensionTravelRR",
  "TireSlipRatioFL","TireSlipRatioFR","TireSlipRatioRL","TireSlipRatioRR",
  "WheelRotationSpeedFL","WheelRotationSpeedFR","WheelRotationSpeedRL","WheelRotationSpeedRR",
  "WheelOnRumbleStripFL","WheelOnRumbleStripFR","WheelOnRumbleStripRL","WheelOnRumbleStripRR",
  "WheelInPuddleDepthFL","WheelInPuddleDepthFR","WheelInPuddleDepthRL","WheelInPuddleDepthRR",
  "SurfaceRumbleFL_2","SurfaceRumbleFR_2","SurfaceRumbleRL_2","SurfaceRumbleRR_2",
  "TireSlipCombinedFL_2",
  "TireTempFL","TireTempFR","TireTempRL","TireTempRR",
  "Boost","Fuel","DistanceTraveled","BestLap","LastLap","CurrentLap","CurrentRaceTime",
  "LapNumber","RacePosition","Accel","Brake","Clutch","HandBrake","Gear","Steer",
  "NormDrivingLine","NormAIBrakeDiff",
  "TireWearFL","TireWearFR","TireWearRL","TireWearRR",
  "SurfaceRumbleFL","SurfaceRumbleFR","SurfaceRumbleRL","SurfaceRumbleRR",
  "TireSlipAngleFL","TireSlipAngleFR","TireSlipAngleRL","TireSlipAngleRR",
  "TireCombinedSlipFL","TireCombinedSlipFR","TireCombinedSlipRL","TireCombinedSlipRR",
  "SuspensionTravelMFL","SuspensionTravelMFR","SuspensionTravelMRL","SuspensionTravelMRR",
  "CarOrdinal","CarClass","CarPerformanceIndex","DrivetrainType","NumCylinders",
  "PositionX","PositionY","PositionZ","Speed","Power","Torque","TrackOrdinal",
  "DrsActive","ErsStoreEnergy","ErsDeployMode","ErsDeployed","ErsHarvested",
  "WeatherType","TrackTemp","AirTemp","RainPercent",
  "BrakeTempFrontLeft","BrakeTempFrontRight","BrakeTempRearLeft","BrakeTempRearRight",
  "TirePressureFrontLeft","TirePressureFrontRight","TirePressureRearLeft","TirePressureRearRight",
  "TyreCompound",
];

/**
 * Build a per-lap meta object capturing non-numeric/extended data.
 * Stored as a JSON line before the CSV header.
 */
// Fields on F1ExtendedData useful for live UI only — not worth storing per-lap
const F1_LIVE_ONLY_KEYS = new Set([
  "grid",
  "frontLeftWingDamage", "frontRightWingDamage", "rearWingDamage",
  "floorDamage", "diffuserDamage", "sidepodDamage",
  "drsFault", "ersFault", "gearBoxDamage", "engineDamage",
  "engineMGUHWear", "engineESWear", "engineCEWear",
  "engineICEWear", "engineMGUKWear", "engineTCWear",
]);

function buildMeta(packets: TelemetryPacket[]): Record<string, unknown> | null {
  if (packets.length === 0) return null;
  const first = packets[0];
  const meta: Record<string, unknown> = {};
  if (first.gameId) meta.gameId = first.gameId;
  if (first.acc) meta.acc = first.acc;
  if (first.f1) {
    const stripped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(first.f1)) {
      if (!F1_LIVE_ONLY_KEYS.has(k)) stripped[k] = v;
    }
    meta.f1 = stripped;
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

/**
 * Compress telemetry packets to a gzip'd CSV blob for storage.
 * Format: optional JSON meta line, then CSV header, then CSV rows.
 */
export function compressTelemetry(packets: TelemetryPacket[]): Buffer {
  const meta = buildMeta(packets);
  const csvHeader = TELEMETRY_FIELDS.join(",");
  const parts: string[] = [];
  if (meta) parts.push(JSON.stringify(meta));
  parts.push(csvHeader);
  for (let i = 0; i < packets.length; i++) {
    const p = packets[i];
    parts.push(TELEMETRY_FIELDS.map(f => p[f]).join(","));
  }
  return Buffer.from(Bun.gzipSync(Buffer.from(parts.join("\n"))));
}

/**
 * Decompress a stored telemetry blob back to packet array.
 * Detects optional JSON meta line (starts with '{') and stamps
 * gameId/acc/f1 back onto each packet.
 */
export function decompressTelemetry(blob: Buffer): TelemetryPacket[] {
  let decompressed: Uint8Array;
  try {
    decompressed = Bun.gunzipSync(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer);
  } catch (err) {
    console.error("[DB] Failed to decompress telemetry blob:", err);
    return [];
  }
  const text = new TextDecoder().decode(decompressed);
  const nl = text.indexOf("\n");
  if (nl === -1) return [];

  let meta: Record<string, unknown> | null = null;
  let headerStart = 0;
  const firstLine = text.slice(0, nl);

  // Detect JSON meta line (starts with '{')
  if (firstLine.charCodeAt(0) === 123) {
    try { meta = JSON.parse(firstLine); } catch {}
    headerStart = nl + 1;
  }

  const headerEnd = text.indexOf("\n", headerStart);
  if (headerEnd === -1) return [];
  const fields = text.slice(headerStart, headerEnd).split(",") as (keyof TelemetryPacket)[];
  const body = text.slice(headerEnd + 1);
  const lines = body.split("\n");
  const result: TelemetryPacket[] = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const vals = lines[i].split(",");
    const p = {} as TelemetryPacket;
    for (let j = 0; j < fields.length; j++) {
      (p as any)[fields[j]] = Number(vals[j]);
    }
    if (meta) {
      if (meta.gameId) p.gameId = meta.gameId as GameId;
      if (meta.acc) p.acc = meta.acc as TelemetryPacket["acc"];
      if (meta.f1) p.f1 = meta.f1 as TelemetryPacket["f1"];
    }
    fillNormSuspension(p);
    result[i] = p;
  }
  return result;
}


/**
 * Insert a new session, returns the created session ID.
 */
export async function insertSession(
  carOrdinal: number,
  trackOrdinal: number,
  gameId: GameId,
  sessionType?: string
): Promise<number> {
  const result = await db
    .insert(sessions)
    .values({ carOrdinal, trackOrdinal, gameId, sessionType })
    .returning({ id: sessions.id })
    .get();
  return result.id;
}

/**
 * Update session metadata (e.g. session type discovered after session start).
 */
export async function updateSession(
  id: number,
  updates: { sessionType?: string; notes?: string | null }
): Promise<void> {
  await db.update(sessions).set(updates).where(eq(sessions.id, id)).run();
}

export async function updateLapNotes(id: number, notes: string | null): Promise<void> {
  await db.update(laps).set({ notes }).where(eq(laps.id, id)).run();
}

export async function updateLapValidity(id: number, isValid: boolean, invalidReason: string | null, sectors?: { s1: number; s2: number; s3: number } | null): Promise<void> {
  const values: Record<string, unknown> = { isValid, invalidReason };
  if (sectors) {
    values.s1Time = sectors.s1;
    values.s2Time = sectors.s2;
    values.s3Time = sectors.s3;
  }
  await db.update(laps).set(values).where(eq(laps.id, id)).run();
}

/**
 * Insert a completed lap with compressed telemetry.
 */
export function insertLap(
  sessionId: number,
  lapNumber: number,
  lapTime: number,
  isValid: boolean,
  rawByteOffset: number | null,
  rawFrameCount: number,
  profileId: number | null = null,
  tuneId: number | null = null,
  invalidReason: string | null = null,
  sectors: { s1: number; s2: number; s3: number } | null = null
): Promise<number> {
  return doInsertLap(sessionId, lapNumber, lapTime, isValid, rawByteOffset, rawFrameCount, profileId, tuneId, invalidReason, sectors);
}

async function doInsertLap(
  sessionId: number,
  lapNumber: number,
  lapTime: number,
  isValid: boolean,
  rawByteOffset: number | null,
  rawFrameCount: number,
  profileId: number | null,
  tuneId: number | null,
  invalidReason: string | null,
  sectors: { s1: number; s2: number; s3: number } | null = null
): Promise<number> {
  const result = await db
    .insert(laps)
    .values({
      sessionId,
      lapNumber,
      lapTime,
      isValid,
      rawByteOffset,
      rawFrameCount,
      s1Time: sectors?.s1 ?? null,
      s2Time: sectors?.s2 ?? null,
      s3Time: sectors?.s3 ?? null,
      profileId,
      tuneId,
      invalidReason,
    })
    .returning({ id: laps.id })
    .get();
  return result.id;
}

export async function updateSessionRawFile(sessionId: number, rawFile: string, lapDetectorVersion: string): Promise<void> {
  await db.update(sessions).set({ rawFile, lapDetectorVersion }).where(eq(sessions.id, sessionId)).run();
}

/**
 * Aggregate lap stats scoped to an optional game. Uses SQL COUNT/SUM so
 * totals don't get capped by getLaps()'s 200-row limit — home-page game
 * cards and per-game pages now both report the full picture.
 */
export interface LapStats {
  totalLaps: number;
  validLaps: number;
  totalTimeSec: number;
  uniqueCars: number;
  uniqueTracks: number;
  lapsByTrack: { trackOrdinal: number; count: number }[];
}

export async function getLapStats(gameId?: GameId): Promise<LapStats> {
  const whereClause = gameId ? sql`WHERE sessions.game_id = ${gameId}` : sql``;
  const whereClauseByTrack = gameId
    ? sql`WHERE sessions.game_id = ${gameId} AND laps.lap_time > 0 AND sessions.track_ordinal IS NOT NULL`
    : sql`WHERE laps.lap_time > 0 AND sessions.track_ordinal IS NOT NULL`;

  const totals = await db.all<{
    totalLaps: number;
    validLaps: number;
    totalTimeSec: number;
    uniqueCars: number;
    uniqueTracks: number;
  }>(sql`
    SELECT
      COUNT(*) as totalLaps,
      SUM(CASE WHEN laps.is_valid AND laps.lap_time > 0 THEN 1 ELSE 0 END) as validLaps,
      COALESCE(SUM(CASE WHEN laps.lap_time > 0 THEN laps.lap_time ELSE 0 END), 0) as totalTimeSec,
      COUNT(DISTINCT sessions.car_ordinal) as uniqueCars,
      COUNT(DISTINCT sessions.track_ordinal) as uniqueTracks
    FROM laps
    INNER JOIN sessions ON laps.session_id = sessions.id
    ${whereClause}
  `);

  const byTrack = await db.all<{ trackOrdinal: number; count: number }>(sql`
    SELECT sessions.track_ordinal as trackOrdinal, COUNT(*) as count
    FROM laps
    INNER JOIN sessions ON laps.session_id = sessions.id
    ${whereClauseByTrack}
    GROUP BY sessions.track_ordinal
  `);

  const row = totals[0] ?? { totalLaps: 0, validLaps: 0, totalTimeSec: 0, uniqueCars: 0, uniqueTracks: 0 };
  return {
    totalLaps: Number(row.totalLaps),
    validLaps: Number(row.validLaps),
    totalTimeSec: Number(row.totalTimeSec),
    uniqueCars: Number(row.uniqueCars),
    uniqueTracks: Number(row.uniqueTracks),
    lapsByTrack: byTrack.map((r) => ({ trackOrdinal: r.trackOrdinal, count: Number(r.count) })),
  };
}

/**
 * Get all laps with session metadata, newest first.
 * Optionally filter by profileId.
 */
export async function getLaps(gameId?: GameId, limit: number = 200): Promise<LapMeta[]> {
  const query = db
    .select({
      id: laps.id,
      sessionId: laps.sessionId,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      invalidReason: laps.invalidReason,
      notes: laps.notes,
      pi: laps.pi,
      carSetup: laps.carSetup,
      createdAt: laps.createdAt,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      tuneId: laps.tuneId,
      tuneName: tunes.name,
      gameId: sessions.gameId,
      s1Time: laps.s1Time,
      s2Time: laps.s2Time,
      s3Time: laps.s3Time,
      rawFile: sessions.rawFile,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .orderBy(desc(laps.id))
    .limit(limit);

  const rows = gameId
    ? await query.where(eq(sessions.gameId, gameId)).all()
    : await query.all();

  return rows.map(({ rawFile, ...r }) => ({
    ...r,
    isValid: Boolean(r.isValid),
    invalidReason: r.invalidReason ?? undefined,
    pi: r.pi ?? 0,
    carSetup: r.carSetup ?? undefined,
    tuneId: r.tuneId ?? undefined,
    tuneName: r.tuneName ?? undefined,
    notes: r.notes ?? undefined,
    gameId: r.gameId as GameId,
    s1Time: r.s1Time ?? undefined,
    s2Time: r.s2Time ?? undefined,
    s3Time: r.s3Time ?? undefined,
    isLegacy: rawFile == null,
  }));
}

export type LapSummary = {
  lapId: number;
  lapNumber: number;
  lapTime: number;
  carOrdinal: number;
  pi: number;
  gameId: GameId;
  sessionId: number;
  createdAt: string;
  s1Time: number | null;
  s2Time: number | null;
  s3Time: number | null;
  isValid: boolean;
  invalidReason: string | null;
  rawFile: string | null;
  notes: string | null;
};

export async function getLapSummariesByTrack(trackOrdinal: number, gameId?: GameId): Promise<LapSummary[]> {
  const query = db
    .select({
      lapId: laps.id,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      carOrdinal: sessions.carOrdinal,
      pi: laps.pi,
      gameId: sessions.gameId,
      sessionId: laps.sessionId,
      createdAt: laps.createdAt,
      s1Time: laps.s1Time,
      s2Time: laps.s2Time,
      s3Time: laps.s3Time,
      isValid: laps.isValid,
      invalidReason: laps.invalidReason,
      rawFile: sessions.rawFile,
      notes: laps.notes,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .where(
      gameId
        ? and(eq(sessions.trackOrdinal, trackOrdinal), eq(sessions.gameId, gameId))
        : eq(sessions.trackOrdinal, trackOrdinal)
    )
    .orderBy(desc(laps.id));

  const rows = await query.all();
  return rows
    .filter(r => (r.lapTime ?? 0) > 0)
    .map(r => ({
      lapId: r.lapId,
      lapNumber: r.lapNumber ?? 0,
      lapTime: r.lapTime,
      carOrdinal: r.carOrdinal ?? 0,
      pi: r.pi ?? 0,
      gameId: r.gameId as GameId,
      sessionId: r.sessionId,
      createdAt: r.createdAt,
      s1Time: r.s1Time ?? null,
      s2Time: r.s2Time ?? null,
      s3Time: r.s3Time ?? null,
      isValid: Boolean(r.isValid),
      invalidReason: r.invalidReason ?? null,
      rawFile: r.rawFile ?? null,
      notes: r.notes ?? null,
    }));
}

// Rough per-packet byte estimate. TelemetryPacket has ~50–80 numeric fields
// plus optional game-specific extensions (f1/acc/setup). Sniffing the first
// packet to pick a tighter estimate is precise enough for an eviction budget
// that the user controls in settings.
const BYTES_PER_PACKET_BASE = 500;
const BYTES_PER_PACKET_F1 = 1100;
const BYTES_PER_PACKET_ACC = 800;

const DEFAULT_CACHE_MAX_BYTES = 256 * 1024 * 1024;

interface CacheEntry {
  packets: TelemetryPacket[];
  bytes: number;
}

const telemetryCache = new Map<number, CacheEntry>();
let cacheMaxBytes = DEFAULT_CACHE_MAX_BYTES;
let cacheBytesUsed = 0;

function estimateBytes(packets: TelemetryPacket[]): number {
  if (packets.length === 0) return 0;
  const sample = packets[0] as TelemetryPacket & { f1?: unknown; acc?: unknown };
  const per = sample.f1 ? BYTES_PER_PACKET_F1
    : sample.acc ? BYTES_PER_PACKET_ACC
    : BYTES_PER_PACKET_BASE;
  return packets.length * per;
}

function cacheGet(id: number): TelemetryPacket[] | undefined {
  const entry = telemetryCache.get(id);
  if (entry) {
    telemetryCache.delete(id);
    telemetryCache.set(id, entry);
    return entry.packets;
  }
  return undefined;
}

function cacheSet(id: number, packets: TelemetryPacket[]): void {
  const existing = telemetryCache.get(id);
  if (existing) {
    cacheBytesUsed -= existing.bytes;
    telemetryCache.delete(id);
  }
  const bytes = estimateBytes(packets);
  telemetryCache.set(id, { packets, bytes });
  cacheBytesUsed += bytes;
  evictUntilWithinBudget();
}

function cacheDelete(id: number): boolean {
  const entry = telemetryCache.get(id);
  if (!entry) return false;
  cacheBytesUsed -= entry.bytes;
  return telemetryCache.delete(id);
}

function evictUntilWithinBudget(): void {
  while (cacheBytesUsed > cacheMaxBytes && telemetryCache.size > 0) {
    const oldest = telemetryCache.keys().next().value;
    if (oldest === undefined) break;
    cacheDelete(oldest);
  }
}

export function setCacheMaxBytes(bytes: number): void {
  cacheMaxBytes = Math.max(0, Math.floor(bytes));
  evictUntilWithinBudget();
}

export function getCacheStats(): { bytesUsed: number; maxBytes: number; entries: number } {
  return { bytesUsed: cacheBytesUsed, maxBytes: cacheMaxBytes, entries: telemetryCache.size };
}

export const _telemetryCacheForTest = {
  get: cacheGet,
  set: cacheSet,
  delete: cacheDelete,
  clear: () => { telemetryCache.clear(); cacheBytesUsed = 0; },
  size: () => telemetryCache.size,
  bytesUsed: () => cacheBytesUsed,
  maxBytes: () => cacheMaxBytes,
  setMaxBytes: setCacheMaxBytes,
  resetMaxBytes: () => { cacheMaxBytes = DEFAULT_CACHE_MAX_BYTES; },
  keys: () => Array.from(telemetryCache.keys()),
  estimateBytes,
};

/**
 * Re-parse raw UDP frames from a session .bin file for a specific lap.
 * Frame 0 is a meta frame (magic-prefixed); lap frames start at rawByteOffset.
 */
export interface LapParseErrorDetails {
  rawFile: string;
  rawByteOffset: number;
  rawFrameCount: number;
  fileSize: number;
  framesParsed: number;
  reason: "offset-past-eof" | "truncated-frame" | "truncated-meta" | "no-packets-parsed";
}

export class LapParseError extends Error {
  readonly details: LapParseErrorDetails;

  constructor(message: string, details: LapParseErrorDetails) {
    super(message);
    this.name = "LapParseError";
    this.details = details;
  }
}

async function parseRawLapFrames(
  rawFile: string,
  rawByteOffset: number,
  rawFrameCount: number,
  gameId: GameId
): Promise<TelemetryPacket[]> {
  const serverGame = getServerGame(gameId);
  const state = serverGame.createParserState?.() ?? null;

  let buf = Buffer.from(await Bun.file(rawFile).arrayBuffer());
  // Decompress if file is gzipped
  if (rawFile.endsWith(".gz")) {
    buf = await gunzipAsync(buf);
  }

  const fileSize = buf.length;

  // rawByteOffset past EOF means the lap row was written before the
  // corresponding bytes made it to disk (old bug), or something stomped
  // the file. Fail loudly so the client can surface a useful message.
  if (rawByteOffset >= fileSize) {
    throw new LapParseError(
      `Lap raw byte offset ${rawByteOffset} is past EOF (file is ${fileSize} bytes) in ${rawFile}`,
      { rawFile, rawByteOffset, rawFrameCount, fileSize, framesParsed: 0, reason: "offset-past-eof" }
    );
  }

  // Warm up stateful parsers (F1) by replaying frames from the start of the
  // file. Without this the accumulator starts empty mid-file and drops the
  // first ~1s of lap telemetry waiting for every sub-packet type to arrive.
  // Start at 12 to skip the meta frame.
  let warmupOffset = 12;
  while (warmupOffset < rawByteOffset && warmupOffset + 4 <= buf.length) {
    const wLen = buf.readUInt32LE(warmupOffset);
    if (wLen <= 0 || warmupOffset + 4 + wLen > buf.length) break;
    const wBuf = buf.subarray(warmupOffset + 4, warmupOffset + 4 + wLen);
    warmupOffset += 4 + wLen;
    try { serverGame.tryParse(wBuf, state); } catch { /* warmup best-effort */ }
  }

  let offset = rawByteOffset;
  const packets: TelemetryPacket[] = [];
  // Read one extra frame past the stored count so we can enrich the final
  // in-lap packet with the lap-completion info carried on the next-lap
  // trigger frame (LastLap, sector3Time, etc). The extra frame is NOT
  // returned to the caller.
  const readCount = rawFrameCount + 1;

  for (let i = 0; i < readCount; i++) {
    if (offset + 4 > buf.length) {
      // Extra frame may legitimately not exist (end of file). Only complain
      // about missing frames within rawFrameCount itself.
      if (i >= rawFrameCount) break;
      throw new LapParseError(
        `Truncated frame header at offset ${offset} (file ${fileSize} bytes, wanted frame ${i + 1}/${rawFrameCount})`,
        { rawFile, rawByteOffset, rawFrameCount, fileSize, framesParsed: packets.length, reason: "truncated-frame" }
      );
    }
    const frameLen = buf.readUInt32LE(offset);
    // NOTE: we do not check for META_FRAME_MAGIC here — the meta frame only
    // exists at file offset 0, which laps never start at. Treating any
    // mid-lap 0xFFFFFFFF as a meta frame would false-positive on legitimate
    // packet data containing that byte pattern and drift the frame reader
    // out of alignment.
    offset += 4;
    if (offset + frameLen > buf.length) {
      if (i >= rawFrameCount) break;
      throw new LapParseError(
        `Frame ${i + 1}/${rawFrameCount} at offset ${offset} claims ${frameLen} bytes but only ${buf.length - offset} remain`,
        { rawFile, rawByteOffset, rawFrameCount, fileSize, framesParsed: packets.length, reason: "truncated-frame" }
      );
    }
    const frameBuf = buf.subarray(offset, offset + frameLen);
    offset += frameLen;
    try {
      const packet = serverGame.tryParse(frameBuf, state);
      if (!packet) continue;
      // Apply coordinate normalization — same as processPacket does for live data.
      // ACC uses right-handed coords in the raw buffer; flip X to match display convention.
      const sharedAdapter = tryGetGame(packet.gameId);
      if (sharedAdapter?.coordSystem === "standard-xyz") {
        packet.PositionX = -packet.PositionX;
        packet.VelocityX = -packet.VelocityX;
        packet.AccelerationX = -packet.AccelerationX;
      }
      fillNormSuspension(packet);
      if (i < rawFrameCount) {
        packets.push(packet);
      } else {
        // Extra trailing frame = the next-lap trigger. It carries real
        // speed/throttle/etc. values for the finish-line crossing, but its
        // CurrentLap has already reset for the new lap. Append it as a
        // synthesized "finish" packet with CurrentLap rewritten to this
        // lap's time (from LastLap), and LapNumber patched back to the
        // outgoing lap so consumers don't see a stray new-lap entry.
        const last = packets[packets.length - 1];
        const finishTime = packet.LastLap ?? 0;
        if (last && finishTime > (last.CurrentLap ?? 0)) {
          packets.push({
            ...packet,
            CurrentLap: finishTime,
            LapNumber: last.LapNumber,
            DistanceTraveled: Math.max(packet.DistanceTraveled, last.DistanceTraveled),
          });
        }
      }
    } catch (err) {
      // A single malformed frame shouldn't kill the whole lap parse. Log
      // once (first occurrence) with enough context to diagnose, then skip.
      if (packets.length === 0 && i < 5) {
        console.warn(
          `[DB] tryParse threw on frame ${i + 1}/${rawFrameCount} of lap ` +
          `(gameId=${gameId}, offset=${offset - frameLen}, len=${frameLen}): ` +
          `${(err as Error).message}`
        );
      }
    }
  }

  // Parsed every frame successfully but the game adapter rejected all of
  // them — the state accumulator never built a complete packet. Surface it.
  if (packets.length === 0 && rawFrameCount > 0) {
    throw new LapParseError(
      `Parsed ${rawFrameCount} frames but produced 0 telemetry packets (gameId=${gameId})`,
      { rawFile, rawByteOffset, rawFrameCount, fileSize, framesParsed: 0, reason: "no-packets-parsed" }
    );
  }

  return packets;
}

/** Test-only export so integration tests can drive parseRawLapFrames directly. */
export const parseRawLapFramesForTest = parseRawLapFrames;

/**
 * Get a single lap by ID, re-parsing telemetry from the raw session .bin file.
 * Returns empty telemetry for pre-migration laps (rawByteOffset is null).
 */
export async function getLapById(
  id: number
): Promise<(LapMeta & { telemetry: TelemetryPacket[]; parseError?: string }) | null> {
  const row = await db
    .select({
      id: laps.id,
      sessionId: laps.sessionId,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      createdAt: laps.createdAt,
      rawByteOffset: laps.rawByteOffset,
      rawFrameCount: laps.rawFrameCount,
      rawFile: sessions.rawFile,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      tuneId: laps.tuneId,
      tuneName: tunes.name,
      gameId: sessions.gameId,
      carSetup: laps.carSetup,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .where(eq(laps.id, id))
    .get();

  if (!row) return null;

  const cached = cacheGet(id);
  if (cached) {
    return buildLapResult(row, cached);
  }

  let telemetry: TelemetryPacket[] = [];
  let parseError: string | undefined;
  if (row.rawByteOffset != null && row.rawFrameCount && row.rawFile) {
    try {
      telemetry = await parseRawLapFrames(
        row.rawFile,
        row.rawByteOffset,
        row.rawFrameCount,
        row.gameId as GameId
      );
    } catch (err) {
      if (err instanceof LapParseError) {
        console.error(`[DB] Lap ${id} parse failed (${err.details.reason}): ${err.message}`, err.details);
        parseError = err.message;
      } else {
        console.error(`[DB] Failed to parse raw frames for lap ${id}:`, err);
        parseError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  // Only cache successful, non-empty parses. Empty/errored results are
  // transient (often caused by a bug that gets fixed, or a buffer-flush
  // race) and caching them would require a server restart to recover.
  if (telemetry.length > 0) cacheSet(id, telemetry);
  const result = buildLapResult(row, telemetry);
  if (parseError) return { ...result, parseError };
  return result;
}

function buildLapResult(
  row: { id: number; sessionId: number; lapNumber: number; lapTime: number; isValid: number | boolean; createdAt: string; carOrdinal: number; trackOrdinal: number; tuneId: number | null; tuneName: string | null; gameId: string; carSetup: string | null; rawFile?: string | null },
  telemetry: TelemetryPacket[]
) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    lapNumber: row.lapNumber,
    lapTime: row.lapTime,
    isValid: Boolean(row.isValid),
    createdAt: row.createdAt,
    carOrdinal: row.carOrdinal,
    trackOrdinal: row.trackOrdinal,
    tuneId: row.tuneId ?? undefined,
    tuneName: row.tuneName ?? undefined,
    gameId: row.gameId as GameId,
    carSetup: row.carSetup ?? undefined,
    isLegacy: row.rawFile == null,
    telemetry,
  };
}


/**
 * Delete a lap by ID. Returns true if a row was deleted.
 * Automatically deletes the parent session if it has no remaining laps.
 */
export async function deleteLap(id: number): Promise<boolean> {
  // Get session ID before deleting
  const lap = await db.select({ sessionId: laps.sessionId }).from(laps).where(eq(laps.id, id)).get();
  const result = await db.delete(laps).where(eq(laps.id, id)).returning().all();
  if (result.length > 0) {
    cacheDelete(id);
    // Clean up empty parent session
    if (lap) {
      const remaining = await db.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, lap.sessionId)).limit(1).all();
      if (remaining.length === 0) {
        await db.delete(sessions).where(eq(sessions.id, lap.sessionId)).run();
      }
    }
  }
  return result.length > 0;
}

/**
 * Count sessions with stale lap detector version that have a raw file (can be reprocessed).
 */
export async function countStaleSessions(currentIds: string | string[]): Promise<number> {
  const ids = Array.isArray(currentIds) ? currentIds : [currentIds];
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        sql`${sessions.rawFile} IS NOT NULL`,
        or(isNull(sessions.lapDetectorVersion), notInArray(sessions.lapDetectorVersion, ids))
      )
    )
    .all();
  return rows.length;
}

/**
 * Get IDs of sessions with stale lap detector version that have a raw file.
 */
export async function getStaleSessions(currentIds: string | string[]): Promise<number[]> {
  const ids = Array.isArray(currentIds) ? currentIds : [currentIds];
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        sql`${sessions.rawFile} IS NOT NULL`,
        or(isNull(sessions.lapDetectorVersion), notInArray(sessions.lapDetectorVersion, ids))
      )
    )
    .all();
  return rows.map(r => r.id);
}

/**
 * Get sessions with uncompressed raw files (.bin) older than the given age in ms.
 */
export async function getUncompressedSessions(olderThanMs: number): Promise<{ id: number; rawFile: string }[]> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const rows = await db
    .select({ id: sessions.id, rawFile: sessions.rawFile })
    .from(sessions)
    .where(
      and(
        sql`${sessions.rawFile} IS NOT NULL`,
        sql`${sessions.rawFile} NOT LIKE '%.gz'`,
        sql`${sessions.createdAt} < ${cutoff}`
      )
    )
    .all();
  return rows.filter((r): r is { id: number; rawFile: string } => r.rawFile !== null);
}

/**
 * Delete a session and all its laps. Returns number of laps deleted.
 */
export async function deleteSession(sessionId: number): Promise<number> {
  const sessionLaps = await db.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, sessionId)).all();
  let count = 0;
  for (const lap of sessionLaps) {
    if (await deleteLap(lap.id)) count++;
  }
  await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  return count;
}

/** Get all laps for a session, including notes/tuneId for reprocess preservation. */
export async function getLapsForSession(sessionId: number): Promise<Array<{
  id: number; lapNumber: number; lapTime: number; isValid: boolean;
  notes: string | null; tuneId: number | null;
  rawByteOffset: number | null; rawFrameCount: number | null;
  s1Time: number | null; s2Time: number | null; s3Time: number | null;
}>> {
  const rows = await db
    .select({
      id: laps.id,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      notes: laps.notes,
      tuneId: laps.tuneId,
      rawByteOffset: laps.rawByteOffset,
      rawFrameCount: laps.rawFrameCount,
      s1Time: laps.s1Time,
      s2Time: laps.s2Time,
      s3Time: laps.s3Time,
    })
    .from(laps)
    .where(eq(laps.sessionId, sessionId))
    .orderBy(laps.lapNumber)
    .all();
  return rows.map(r => ({ ...r, isValid: Boolean(r.isValid) }));
}

/** Update lap frame index and metadata after reprocessing. */
export async function updateLapRawIndex(
  lapId: number,
  rawByteOffset: number | null,
  rawFrameCount: number,
  lapTime: number,
  isValid: boolean,
  sectors: { s1: number; s2: number; s3: number } | null
): Promise<void> {
  cacheDelete(lapId);
  await db.update(laps).set({
    rawByteOffset,
    rawFrameCount,
    lapTime,
    isValid,
    s1Time: sectors?.s1 ?? null,
    s2Time: sectors?.s2 ?? null,
    s3Time: sectors?.s3 ?? null,
  }).where(eq(laps.id, lapId));
}

/** Insert a lap during session reprocessing (preserves notes/tuneId from old lap). */
export async function insertReprocessedLap(
  sessionId: number,
  lapNumber: number,
  lapTime: number,
  isValid: boolean,
  rawByteOffset: number | null,
  rawFrameCount: number,
  tuneId: number | null,
  notes: string | null,
  invalidReason: string | null,
  sectors: { s1: number; s2: number; s3: number } | null
): Promise<number> {
  const result = await db.insert(laps).values({
    sessionId, lapNumber, lapTime, isValid,
    rawByteOffset, rawFrameCount,
    tuneId, notes, invalidReason,
    s1Time: sectors?.s1 ?? null,
    s2Time: sectors?.s2 ?? null,
    s3Time: sectors?.s3 ?? null,
  }).returning({ id: laps.id }).get();
  return result.id;
}

/** Delete all laps for a session (used when reprocess finds different lap count). */
export async function deleteLapsForSession(sessionId: number): Promise<void> {
  const rows = await db.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, sessionId)).all();
  for (const { id } of rows) cacheDelete(id);
  await db.delete(laps).where(eq(laps.sessionId, sessionId));
}

/**
 * Delete all sessions that have zero laps, excluding `activeSessionId` if
 * supplied. Also removes the associated raw .bin / .bin.gz file from disk —
 * empty sessions have no replay value. Pass the current session id when
 * calling outside of boot so a live recorder isn't yanked out from under
 * itself (it has 0 laps until the first one completes).
 *
 * Returns the number of sessions deleted.
 */
export async function deleteEmptySessions(activeSessionId?: number): Promise<number> {
  const empties = await db
    .select({ id: sessions.id, rawFile: sessions.rawFile })
    .from(sessions)
    .leftJoin(laps, eq(laps.sessionId, sessions.id))
    .groupBy(sessions.id)
    .having(sql`count(${laps.id}) = 0`)
    .all();
  const filtered = activeSessionId
    ? empties.filter((e) => e.id !== activeSessionId)
    : empties;
  if (filtered.length === 0) return 0;
  for (const { rawFile } of filtered) {
    if (!rawFile) continue;
    try {
      if (existsSync(rawFile)) unlinkSync(rawFile);
    } catch (err) {
      console.warn(`[DB] Failed to unlink raw file ${rawFile}:`, err instanceof Error ? err.message : err);
    }
  }
  const ids = filtered.map(r => r.id);
  await db.delete(sessions).where(inArray(sessions.id, ids)).run();
  return ids.length;
}

/**
 * Get all sessions with lap counts, newest first.
 */
export async function getSessions(gameId?: GameId): Promise<SessionMeta[]> {
  let query = db
    .select({
      id: sessions.id,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      createdAt: sessions.createdAt,
      gameId: sessions.gameId,
      sessionType: sessions.sessionType,
      notes: sessions.notes,
    })
    .from(sessions)
    .orderBy(desc(sessions.id));

  const rows = gameId
    ? await query.where(eq(sessions.gameId, gameId)).all()
    : await query.all();

  // Get lap counts and best lap per session
  const result: SessionMeta[] = [];
  for (const session of rows) {
    const lapRows = await db
      .select({ id: laps.id, lapTime: laps.lapTime, isValid: laps.isValid })
      .from(laps)
      .where(eq(laps.sessionId, session.id))
      .all();

    const validLaps = lapRows.filter((l) => l.isValid && l.lapTime > 0);
    const bestLapTime = validLaps.length > 0 ? Math.min(...validLaps.map((l) => l.lapTime)) : undefined;
    result.push({
      ...session,
      lapCount: lapRows.length,
      bestLapTime,
      sessionType: session.sessionType ?? undefined,
      notes: session.notes ?? undefined,
      gameId: session.gameId as GameId,
    });
  }
  return result;
}

/**
 * Get stored corner definitions for a track.
 * Returns empty array if none stored.
 */
export async function getCorners(trackOrdinal: number, gameId: GameId): Promise<Corner[]> {
  const rows = await db
    .select({
      cornerIndex: trackCorners.cornerIndex,
      label: trackCorners.label,
      distanceStart: trackCorners.distanceStart,
      distanceEnd: trackCorners.distanceEnd,
    })
    .from(trackCorners)
    .where(and(eq(trackCorners.trackOrdinal, trackOrdinal), eq(trackCorners.gameId, gameId)))
    .orderBy(trackCorners.cornerIndex)
    .all();

  return rows.map((r) => ({
    index: r.cornerIndex,
    label: r.label,
    distanceStart: r.distanceStart,
    distanceEnd: r.distanceEnd,
  }));
}

/**
 * Save/update corner definitions for a track.
 * Replaces all existing corners for that track.
 */
export async function saveCorners(
  trackOrdinal: number,
  corners: Corner[],
  gameId: GameId,
  isAuto: boolean = false
): Promise<void> {
  // Delete existing corners for this track
  await db.delete(trackCorners)
    .where(and(eq(trackCorners.trackOrdinal, trackOrdinal), eq(trackCorners.gameId, gameId)))
    .run();

  // Insert new corners
  if (corners.length > 0) {
    await db.insert(trackCorners)
      .values(
        corners.map((c) => ({
          trackOrdinal,
          cornerIndex: c.index,
          label: c.label,
          distanceStart: c.distanceStart,
          distanceEnd: c.distanceEnd,
          isAuto,
          gameId,
        }))
      )
      .run();
  }
}

/**
 * Find the first lap for a given track (to use for auto-detection).
 * Returns the lap ID or null if no laps exist for this track.
 */
export async function getFirstLapIdForTrack(trackOrdinal: number): Promise<number | null> {
  const row = await db
    .select({ id: laps.id })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .where(eq(sessions.trackOrdinal, trackOrdinal))
    .orderBy(desc(laps.id))
    .limit(1)
    .get();

  return row?.id ?? null;
}

/**
 * Get stored track outline for a track ordinal.
 * Returns array of {x, z, speed} or null if not stored.
 */
export async function getTrackOutline(
  trackOrdinal: number,
  gameId: GameId
): Promise<{ x: number; z: number; speed: number }[] | null> {
  const row = await db
    .select({ outline: trackOutlines.outline })
    .from(trackOutlines)
    .where(and(eq(trackOutlines.trackOrdinal, trackOrdinal), eq(trackOutlines.gameId, gameId)))
    .get();

  if (!row) return null;
  const outlineBuf = row.outline as Buffer;
  const decompressed = Bun.gunzipSync(outlineBuf.buffer.slice(outlineBuf.byteOffset, outlineBuf.byteOffset + outlineBuf.byteLength) as ArrayBuffer);
  return JSON.parse(new TextDecoder().decode(decompressed));
}

/**
 * Save a track outline from pre-processed points array.
 * Compresses and stores. Replaces any existing outline.
 * Optionally stores auto-computed sectors.
 */
export async function saveTrackOutline(
  trackOrdinal: number,
  points: { x: number; z: number; speed?: number }[],
  gameId: GameId,
): Promise<void> {
  if (points.length < 10) return;

  const compressed = Buffer.from(
    Bun.gzipSync(Buffer.from(JSON.stringify(points)))
  );

  // Upsert
  const existing = await db
    .select({ id: trackOutlines.id })
    .from(trackOutlines)
    .where(and(eq(trackOutlines.trackOrdinal, trackOrdinal), eq(trackOutlines.gameId, gameId)))
    .get();

  if (existing) {
    await db.update(trackOutlines)
      .set({ outline: compressed })
      .where(and(eq(trackOutlines.trackOrdinal, trackOrdinal), eq(trackOutlines.gameId, gameId)))
      .run();
  } else {
    await db.insert(trackOutlines)
      .values({ trackOrdinal, outline: compressed, gameId })
      .run();
  }

  console.log(
    `[Track] Saved outline for track ${trackOrdinal}: ${points.length} points`
  );
}

/**
 * Save a track outline from raw telemetry packets (legacy API).
 * Extracts position + speed, downsamples, and stores.
 */
export async function saveTrackOutlineFromPackets(
  trackOrdinal: number,
  packets: TelemetryPacket[],
  gameId: GameId
): Promise<void> {
  const points: { x: number; z: number; speed: number }[] = [];
  for (let i = 0; i < packets.length; i++) {
    const p = packets[i];
    if (p.PositionX === 0 && p.PositionZ === 0) continue;
    points.push({
      x: p.PositionX,
      z: p.PositionZ,
      speed: (p.Speed ?? 0) * 2.23694,
    });
  }
  await saveTrackOutline(trackOrdinal, points, gameId);
}

/**
 * Check if a recorded (DB) outline exists for a track ordinal.
 */
export async function hasRecordedOutline(trackOrdinal: number, gameId: GameId): Promise<boolean> {
  const row = await db
    .select({ id: trackOutlines.id })
    .from(trackOutlines)
    .where(and(eq(trackOutlines.trackOrdinal, trackOrdinal), eq(trackOutlines.gameId, gameId)))
    .get();
  return !!row;
}

/**
 * Get track outline metadata (createdAt timestamp) for a track ordinal.
 * Returns {createdAt} or null if no outline exists.
 */
export async function getTrackOutlineMetadata(
  trackOrdinal: number,
  gameId: GameId
): Promise<{ createdAt: string } | null> {
  const row = await db
    .select({ createdAt: trackOutlines.createdAt })
    .from(trackOutlines)
    .where(and(eq(trackOutlines.trackOrdinal, trackOrdinal), eq(trackOutlines.gameId, gameId)))
    .get();

  return row ?? null;
}

export interface AnalysisRow {
  analysis: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  model: string;
}

/**
 * Get cached AI analysis for a lap. Returns analysis + usage stats or null.
 */
export async function getAnalysis(lapId: number): Promise<AnalysisRow | null> {
  const row = await db
    .select({
      analysis: lapAnalyses.analysis,
      inputTokens: lapAnalyses.inputTokens,
      outputTokens: lapAnalyses.outputTokens,
      costUsd: lapAnalyses.costUsd,
      durationMs: lapAnalyses.durationMs,
      model: lapAnalyses.model,
    })
    .from(lapAnalyses)
    .where(eq(lapAnalyses.lapId, lapId))
    .get();
  return row ?? null;
}

export interface AnalysisUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  model: string;
}

/**
 * Save or replace AI analysis for a lap.
 */
export async function saveAnalysis(lapId: number, analysis: string, usage: AnalysisUsage): Promise<void> {
  const existing = await db
    .select({ id: lapAnalyses.id })
    .from(lapAnalyses)
    .where(eq(lapAnalyses.lapId, lapId))
    .get();

  const values = {
    analysis,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
    durationMs: usage.durationMs,
    model: usage.model,
    createdAt: sql`(datetime('now'))`,
  };

  if (existing) {
    await db.update(lapAnalyses)
      .set(values)
      .where(eq(lapAnalyses.lapId, lapId))
      .run();
  } else {
    await db.insert(lapAnalyses)
      .values({ lapId, ...values })
      .run();
  }
}

/**
 * Delete cached AI analysis for a lap.
 */
export async function deleteAnalysis(lapId: number): Promise<void> {
  await db.delete(lapAnalyses).where(eq(lapAnalyses.lapId, lapId)).run();
}

/**
 * Look up a cached compare-analysis for a lap pair.
 * The pair key is canonical (min, max) so the order of arguments doesn't matter.
 */
export async function getCompareAnalysis(
  idA: number,
  idB: number,
  kind: string = "inputs",
): Promise<AnalysisRow | null> {
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  const row = await db
    .select({
      analysis: compareAnalyses.analysis,
      inputTokens: compareAnalyses.inputTokens,
      outputTokens: compareAnalyses.outputTokens,
      costUsd: compareAnalyses.costUsd,
      durationMs: compareAnalyses.durationMs,
      model: compareAnalyses.model,
    })
    .from(compareAnalyses)
    .where(
      and(
        eq(compareAnalyses.lapAId, lo),
        eq(compareAnalyses.lapBId, hi),
        eq(compareAnalyses.kind, kind),
      ),
    )
    .get();
  return row ?? null;
}

export async function saveCompareAnalysis(
  idA: number,
  idB: number,
  analysis: string,
  usage: AnalysisUsage,
  kind: string = "inputs",
): Promise<void> {
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  const existing = await db
    .select({ id: compareAnalyses.id })
    .from(compareAnalyses)
    .where(
      and(
        eq(compareAnalyses.lapAId, lo),
        eq(compareAnalyses.lapBId, hi),
        eq(compareAnalyses.kind, kind),
      ),
    )
    .get();

  const values = {
    analysis,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
    durationMs: usage.durationMs,
    model: usage.model,
    createdAt: sql`(datetime('now'))`,
  };

  if (existing) {
    await db.update(compareAnalyses)
      .set(values)
      .where(
        and(
          eq(compareAnalyses.lapAId, lo),
          eq(compareAnalyses.lapBId, hi),
          eq(compareAnalyses.kind, kind),
        ),
      )
      .run();
  } else {
    await db.insert(compareAnalyses)
      .values({ lapAId: lo, lapBId: hi, kind, ...values })
      .run();
  }
}

export async function deleteCompareAnalysis(
  idA: number,
  idB: number,
  kind: string = "inputs",
): Promise<void> {
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  await db.delete(compareAnalyses)
    .where(
      and(
        eq(compareAnalyses.lapAId, lo),
        eq(compareAnalyses.lapBId, hi),
        eq(compareAnalyses.kind, kind),
      ),
    )
    .run();
}

/**
 * Get all profiles ordered by creation time.
 */
export async function getProfiles() {
  return await db.select().from(profiles).orderBy(profiles.createdAt).all();
}

/**
 * Insert a new profile, returns the created profile ID.
 */
export async function insertProfile(name: string): Promise<number> {
  const result = await db.insert(profiles).values({ name }).returning({ id: profiles.id }).get();
  return result.id;
}

/**
 * Update a profile name by ID. Returns true if a row was updated.
 */
export async function updateProfile(id: number, name: string): Promise<boolean> {
  const result = await db.update(profiles).set({ name }).where(eq(profiles.id, id)).returning().all();
  return result.length > 0;
}

/**
 * Delete a profile by ID. Returns true if a row was deleted.
 */
export async function deleteProfile(id: number): Promise<boolean> {
  const result = await db.delete(profiles).where(eq(profiles.id, id)).returning().all();
  return result.length > 0;
}

/**
 * Get lap data with raw frame index for zip export.
 * Telemetry is no longer stored as a blob — consumers re-parse from session .bin file.
 */
export async function getLapsRaw(ids?: number[]) {
  const base = db
    .select({
      id: laps.id,
      sessionId: laps.sessionId,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      pi: laps.pi,
      rawByteOffset: laps.rawByteOffset,
      rawFrameCount: laps.rawFrameCount,
      rawFile: sessions.rawFile,
      createdAt: laps.createdAt,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      gameId: sessions.gameId,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id));

  if (ids && ids.length > 0) {
    return await base.where(or(...ids.map((id) => eq(laps.id, id))) as any).all();
  }

  return await base.all();
}

/** Count laps per trackOrdinal for a given game. Returns a Map<trackOrdinal, count>. */
export async function getLapCountsByTrack(gameId: GameId): Promise<Map<number, number>> {
  const rows = await db
    .select({ trackOrdinal: sessions.trackOrdinal, count: sql<number>`count(*)` })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .where(eq(sessions.gameId, gameId))
    .groupBy(sessions.trackOrdinal)
    .all();
  return new Map(rows.map((r) => [r.trackOrdinal, Number(r.count)]));
}
