import { eq, desc, and, or, sql, inArray, notInArray, isNull } from "drizzle-orm";
import { db } from "./index";
import { sessions, laps, trackCorners, trackOutlines, lapAnalyses, compareAnalyses, profiles, tunes } from "./schema";
import type { TelemetryPacket, LapMeta, SessionMeta, GameId } from "../../shared/types";
import type { Corner } from "../corner-detection";
import { fillNormSuspension } from "../telemetry-utils";
import { getServerGame } from "../games/registry";
import { META_FRAME_MAGIC } from "../udp-recorder";

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
      rawByteOffset: laps.rawByteOffset,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .orderBy(desc(laps.id))
    .limit(limit);

  const rows = gameId
    ? await query.where(eq(sessions.gameId, gameId)).all()
    : await query.all();

  return rows.map((r) => ({
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
    isLegacy: r.rawByteOffset == null,
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
      notes: r.notes ?? null,
    }));
}

const telemetryCache = new Map<number, TelemetryPacket[]>();

/**
 * Re-parse raw UDP frames from a session .bin file for a specific lap.
 * Frame 0 is a meta frame (magic-prefixed); lap frames start at rawByteOffset.
 */
async function parseRawLapFrames(
  rawFile: string,
  rawByteOffset: number,
  rawFrameCount: number,
  gameId: GameId
): Promise<TelemetryPacket[]> {
  const serverGame = getServerGame(gameId);
  const state = serverGame.createParserState?.() ?? null;

  const fileData = await Bun.file(rawFile).arrayBuffer();
  const buf = Buffer.from(fileData);

  // Skip meta frame at offset 0: [0xFFFFFFFF][payload_len uint32][payload]
  // (Future: hydrate F1 state from payload when implemented)

  let offset = rawByteOffset;
  const packets: TelemetryPacket[] = [];

  for (let i = 0; i < rawFrameCount; i++) {
    if (offset + 4 > buf.length) break;
    const frameLen = buf.readUInt32LE(offset);
    // Skip any stray meta frames
    if (frameLen === META_FRAME_MAGIC) {
      if (offset + 8 > buf.length) break;
      const payloadLen = buf.readUInt32LE(offset + 4);
      offset += 8 + payloadLen;
      continue;
    }
    offset += 4;
    if (offset + frameLen > buf.length) break;
    const frameBuf = buf.subarray(offset, offset + frameLen);
    offset += frameLen;
    const packet = serverGame.tryParse(frameBuf, state);
    if (packet) packets.push(packet);
  }

  return packets;
}

/**
 * Get a single lap by ID, re-parsing telemetry from the raw session .bin file.
 * Returns empty telemetry for pre-migration laps (rawByteOffset is null).
 */
export async function getLapById(
  id: number
): Promise<(LapMeta & { telemetry: TelemetryPacket[] }) | null> {
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

  if (telemetryCache.has(id)) {
    const cached = telemetryCache.get(id)!;
    return buildLapResult(row, cached);
  }

  let telemetry: TelemetryPacket[] = [];
  if (row.rawByteOffset != null && row.rawFrameCount && row.rawFile) {
    try {
      telemetry = await parseRawLapFrames(
        row.rawFile,
        row.rawByteOffset,
        row.rawFrameCount,
        row.gameId as GameId
      );
    } catch (err) {
      console.error(`[DB] Failed to parse raw frames for lap ${id}:`, err);
    }
  }

  telemetryCache.set(id, telemetry);
  return buildLapResult(row, telemetry);
}

function buildLapResult(
  row: { id: number; sessionId: number; lapNumber: number; lapTime: number; isValid: number | boolean; createdAt: string; carOrdinal: number; trackOrdinal: number; tuneId: number | null; tuneName: string | null; gameId: string; carSetup: string | null; rawByteOffset?: number | null },
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
    isLegacy: row.rawByteOffset == null,
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
    telemetryCache.delete(id);
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
  telemetryCache.delete(lapId);
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
  for (const { id } of rows) telemetryCache.delete(id);
  await db.delete(laps).where(eq(laps.sessionId, sessionId));
}

/**
 * Delete all sessions that have zero laps.
 * Returns the number of sessions deleted.
 */
export async function deleteEmptySessions(): Promise<number> {
  const empties = await db
    .select({ id: sessions.id })
    .from(sessions)
    .leftJoin(laps, eq(laps.sessionId, sessions.id))
    .groupBy(sessions.id)
    .having(sql`count(${laps.id}) = 0`)
    .all();
  if (empties.length === 0) return 0;
  const ids = empties.map(r => r.id);
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
