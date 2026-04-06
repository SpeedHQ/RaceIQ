import { eq, desc, and, or, sql, inArray, isNull } from "drizzle-orm";
import { db } from "./index";
import { sessions, laps, trackCorners, trackOutlines, lapAnalyses, profiles, tunes } from "./schema";
import type { TelemetryPacket, LapMeta, SessionMeta, GameId } from "../../shared/types";
import type { Corner } from "../corner-detection";
import { fillNormSuspension } from "../telemetry-utils";

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
export function insertSession(
  carOrdinal: number,
  trackOrdinal: number,
  gameId: GameId,
  sessionType?: string
): number {
  const result = db
    .insert(sessions)
    .values({ carOrdinal, trackOrdinal, gameId, sessionType })
    .returning({ id: sessions.id })
    .get();
  return result.id;
}

/**
 * Update session metadata (e.g. session type discovered after session start).
 */
export function updateSession(
  id: number,
  updates: { sessionType?: string }
): void {
  db.update(sessions).set(updates).where(eq(sessions.id, id)).run();
}

/**
 * Insert a completed lap with compressed telemetry.
 */
/**
 * Insert a lap synchronously — used by import and when caller needs the ID immediately.
 */
export function insertLapSync(
  sessionId: number,
  lapNumber: number,
  lapTime: number,
  isValid: boolean,
  telemetryPackets: TelemetryPacket[],
  profileId: number | null = null,
  tuneId: number | null = null,
  invalidReason: string | null = null
): number {
  const compressed = compressTelemetry(telemetryPackets);
  return doInsertLap(sessionId, lapNumber, lapTime, isValid, compressed, telemetryPackets[0], profileId, tuneId, invalidReason);
}

/**
 * Insert a lap asynchronously — defers compression to avoid blocking the UDP handler.
 * Returns a promise that resolves with the lap ID.
 */
export function insertLap(
  sessionId: number,
  lapNumber: number,
  lapTime: number,
  isValid: boolean,
  telemetryPackets: TelemetryPacket[],
  profileId: number | null = null,
  tuneId: number | null = null,
  invalidReason: string | null = null
): Promise<number> {
  // Take ownership of the packet array immediately (caller will clear their buffer)
  const packets = telemetryPackets.slice();
  const first = packets[0];
  return new Promise((resolve) => {
    setTimeout(() => {
      const compressed = compressTelemetry(packets);
      const id = doInsertLap(sessionId, lapNumber, lapTime, isValid, compressed, first, profileId, tuneId, invalidReason);
      resolve(id);
    }, 0);
  });
}


function doInsertLap(
  sessionId: number,
  lapNumber: number,
  lapTime: number,
  isValid: boolean,
  compressed: Buffer,
  firstPacket: TelemetryPacket | undefined,
  profileId: number | null,
  tuneId: number | null,
  invalidReason: string | null
): number {
  const pi = firstPacket?.CarPerformanceIndex ?? 0;
  const f1 = firstPacket?.f1;
  const result = db
    .insert(laps)
    .values({
      sessionId,
      lapNumber,
      lapTime,
      isValid,
      pi,
      carSetup: f1?.setup ? JSON.stringify(f1.setup) : null,
      telemetry: compressed,
      profileId,
      tuneId,
      invalidReason,
    })
    .returning({ id: laps.id })
    .get();
  return result.id;
}

/**
 * Get all laps with session metadata, newest first.
 * Optionally filter by profileId.
 */
export function getLaps(profileId?: number | null, gameId?: GameId, limit: number = 200): LapMeta[] {
  const query = db
    .select({
      id: laps.id,
      sessionId: laps.sessionId,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      invalidReason: laps.invalidReason,
      pi: laps.pi,
      carSetup: laps.carSetup,
      createdAt: laps.createdAt,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      tuneId: laps.tuneId,
      tuneName: tunes.name,
      gameId: sessions.gameId,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .orderBy(desc(laps.id))
    .limit(limit);

  const conditions = [];
  if (profileId != null) {
    conditions.push(or(eq(laps.profileId, profileId), isNull(laps.profileId)));
  }
  if (gameId) {
    conditions.push(eq(sessions.gameId, gameId));
  }

  const rows = conditions.length > 0
    ? query.where(and(...conditions)).all()
    : query.all();

  return rows.map((r) => ({
    ...r,
    isValid: Boolean(r.isValid),
    invalidReason: r.invalidReason ?? undefined,
    pi: r.pi ?? 0,
    carSetup: r.carSetup ?? undefined,
    tuneId: r.tuneId ?? undefined,
    tuneName: r.tuneName ?? undefined,
    gameId: r.gameId as GameId,
  }));
}

const telemetryCache = new Map<number, TelemetryPacket[]>();

/**
 * Get a single lap by ID with full decompressed telemetry.
 */
export function getLapById(
  id: number
): (LapMeta & { telemetry: TelemetryPacket[] }) | null {
  const row = db
    .select({
      id: laps.id,
      sessionId: laps.sessionId,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      createdAt: laps.createdAt,
      telemetry: laps.telemetry,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      tuneId: laps.tuneId,
      tuneName: tunes.name,
      gameId: sessions.gameId,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .where(eq(laps.id, id))
    .get();

  if (!row) return null;

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
    telemetry: (() => {
      if (telemetryCache.has(id)) return telemetryCache.get(id)!;
      const parsed = decompressTelemetry(row.telemetry as Buffer);
      const gid = row.gameId as GameId;
      for (const p of parsed) {
        // Stamp gameId from session if CSV meta didn't have it
        if (!p.gameId) p.gameId = gid;
        if (gid === "f1-2025") {
          // Derive wheel rotation from speed if not recorded (Pirelli 18" radius 0.36m)
          if (p.WheelRotationSpeedFL === 0 && p.Speed > 0) {
            const wr = p.Speed / 0.36;
            p.WheelRotationSpeedFL = wr;
            p.WheelRotationSpeedFR = wr;
            p.WheelRotationSpeedRL = wr;
            p.WheelRotationSpeedRR = wr;
          }
          // Estimate slip angles if not recorded
          if (p.TireSlipAngleFL === 0 && p.Speed > 2) {
            const sy = Math.sin(-p.Yaw), cy = Math.cos(-p.Yaw);
            const vLat = p.VelocityX * cy + p.VelocityZ * sy;
            const vFwd = p.VelocityX * sy - p.VelocityZ * cy;
            const fwd = Math.abs(vFwd) || 0.1;
            const wb = 3.6;
            const yawRate = p.AccelerationX / (p.Speed || 1);
            const vLatF = vLat + yawRate * wb * 0.55;
            const vLatR = vLat - yawRate * wb * 0.45;
            const steerRad = (p.Steer / 127) * 0.35;
            p.TireSlipAngleFL = Math.atan2(vLatF, fwd) - steerRad;
            p.TireSlipAngleFR = Math.atan2(vLatF, fwd) - steerRad;
            p.TireSlipAngleRL = Math.atan2(vLatR, fwd);
            p.TireSlipAngleRR = Math.atan2(vLatR, fwd);
          }
        }
      }
      telemetryCache.set(id, parsed);
      return parsed;
    })(),
  };
}

/**
 * Delete a lap by ID. Returns true if a row was deleted.
 * Automatically deletes the parent session if it has no remaining laps.
 */
export function deleteLap(id: number): boolean {
  // Get session ID before deleting
  const lap = db.select({ sessionId: laps.sessionId }).from(laps).where(eq(laps.id, id)).get();
  const result = db.delete(laps).where(eq(laps.id, id)).returning().all();
  if (result.length > 0) {
    telemetryCache.delete(id);
    // Clean up empty parent session
    if (lap) {
      const remaining = db.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, lap.sessionId)).limit(1).all();
      if (remaining.length === 0) {
        db.delete(sessions).where(eq(sessions.id, lap.sessionId)).run();
      }
    }
  }
  return result.length > 0;
}

/**
 * Delete a session and all its laps. Returns number of laps deleted.
 */
export function deleteSession(sessionId: number): number {
  const sessionLaps = db.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, sessionId)).all();
  let count = 0;
  for (const lap of sessionLaps) {
    if (deleteLap(lap.id)) count++;
  }
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  return count;
}

/**
 * Delete all sessions that have zero laps.
 * Returns the number of sessions deleted.
 */
export function deleteEmptySessions(): number {
  const empties = db
    .select({ id: sessions.id })
    .from(sessions)
    .leftJoin(laps, eq(laps.sessionId, sessions.id))
    .groupBy(sessions.id)
    .having(sql`count(${laps.id}) = 0`)
    .all();
  if (empties.length === 0) return 0;
  const ids = empties.map(r => r.id);
  db.delete(sessions).where(inArray(sessions.id, ids)).run();
  return ids.length;
}

/**
 * Get all sessions with lap counts, newest first.
 */
export function getSessions(gameId?: GameId): SessionMeta[] {
  let query = db
    .select({
      id: sessions.id,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      createdAt: sessions.createdAt,
      gameId: sessions.gameId,
      sessionType: sessions.sessionType,
    })
    .from(sessions)
    .orderBy(desc(sessions.id));

  const rows = gameId
    ? query.where(eq(sessions.gameId, gameId)).all()
    : query.all();

  // Get lap counts and best lap per session
  return rows.map((session) => {
    const lapRows = db
      .select({ id: laps.id, lapTime: laps.lapTime, isValid: laps.isValid })
      .from(laps)
      .where(eq(laps.sessionId, session.id))
      .all();
    const validLaps = lapRows.filter((l) => l.isValid && l.lapTime > 0);
    const bestLapTime = validLaps.length > 0 ? Math.min(...validLaps.map((l) => l.lapTime)) : undefined;
    return {
      ...session,
      lapCount: lapRows.length,
      bestLapTime,
      sessionType: session.sessionType ?? undefined,
      gameId: session.gameId as GameId,
    };
  });
}

/**
 * Get stored corner definitions for a track.
 * Returns empty array if none stored.
 */
export function getCorners(trackOrdinal: number, gameId: GameId): Corner[] {
  const rows = db
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
export function saveCorners(
  trackOrdinal: number,
  corners: Corner[],
  gameId: GameId,
  isAuto: boolean = false
): void {
  // Delete existing corners for this track
  db.delete(trackCorners)
    .where(and(eq(trackCorners.trackOrdinal, trackOrdinal), eq(trackCorners.gameId, gameId)))
    .run();

  // Insert new corners
  if (corners.length > 0) {
    db.insert(trackCorners)
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
export function getFirstLapIdForTrack(trackOrdinal: number): number | null {
  const row = db
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
export function getTrackOutline(
  trackOrdinal: number,
  gameId: GameId
): { x: number; z: number; speed: number }[] | null {
  const row = db
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
export function saveTrackOutline(
  trackOrdinal: number,
  points: { x: number; z: number; speed?: number }[],
  gameId: GameId,
  sectors?: { s1End: number; s2End: number }
): void {
  if (points.length < 10) return;

  const compressed = Buffer.from(
    Bun.gzipSync(Buffer.from(JSON.stringify(points)))
  );

  const sectorsJson = sectors ? JSON.stringify(sectors) : null;

  // Upsert
  const existing = db
    .select({ id: trackOutlines.id })
    .from(trackOutlines)
    .where(and(eq(trackOutlines.trackOrdinal, trackOrdinal), eq(trackOutlines.gameId, gameId)))
    .get();

  if (existing) {
    db.update(trackOutlines)
      .set({ outline: compressed, sectors: sectorsJson })
      .where(and(eq(trackOutlines.trackOrdinal, trackOrdinal), eq(trackOutlines.gameId, gameId)))
      .run();
  } else {
    db.insert(trackOutlines)
      .values({ trackOrdinal, outline: compressed, sectors: sectorsJson, gameId })
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
export function saveTrackOutlineFromPackets(
  trackOrdinal: number,
  packets: TelemetryPacket[],
  gameId: GameId
): void {
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
  saveTrackOutline(trackOrdinal, points, gameId);
}

/**
 * Get stored sectors for a track ordinal from the track_outlines table.
 * Returns {s1End, s2End} or null if not stored.
 */
export function getTrackOutlineSectors(
  trackOrdinal: number,
  gameId: GameId
): { s1End: number; s2End: number } | null {
  const row = db
    .select({ sectors: trackOutlines.sectors })
    .from(trackOutlines)
    .where(and(eq(trackOutlines.trackOrdinal, trackOrdinal), eq(trackOutlines.gameId, gameId)))
    .get();

  if (!row?.sectors) return null;
  try {
    return JSON.parse(row.sectors as string);
  } catch {
    return null;
  }
}

/**
 * Update just the sector boundaries (s1End, s2End) for a track outline.
 * Returns true if a row was updated.
 */
export function updateTrackOutlineSectors(
  trackOrdinal: number,
  sectors: { s1End: number; s2End: number },
  gameId: GameId
): boolean {
  const existing = db
    .select({ id: trackOutlines.id })
    .from(trackOutlines)
    .where(and(eq(trackOutlines.trackOrdinal, trackOrdinal), eq(trackOutlines.gameId, gameId)))
    .get();

  if (!existing) return false;

  db.update(trackOutlines)
    .set({ sectors: JSON.stringify(sectors) })
    .where(and(eq(trackOutlines.trackOrdinal, trackOrdinal), eq(trackOutlines.gameId, gameId)))
    .run();

  return true;
}

/**
 * Check if a recorded (DB) outline exists for a track ordinal.
 */
export function hasRecordedOutline(trackOrdinal: number, gameId: GameId): boolean {
  const row = db
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
export function getTrackOutlineMetadata(
  trackOrdinal: number,
  gameId: GameId
): { createdAt: string } | null {
  const row = db
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
export function getAnalysis(lapId: number): AnalysisRow | null {
  const row = db
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
export function saveAnalysis(lapId: number, analysis: string, usage: AnalysisUsage): void {
  const existing = db
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
    db.update(lapAnalyses)
      .set(values)
      .where(eq(lapAnalyses.lapId, lapId))
      .run();
  } else {
    db.insert(lapAnalyses)
      .values({ lapId, ...values })
      .run();
  }
}

/**
 * Get all profiles ordered by creation time.
 */
export function getProfiles() {
  return db.select().from(profiles).orderBy(profiles.createdAt).all();
}

/**
 * Insert a new profile, returns the created profile ID.
 */
export function insertProfile(name: string): number {
  const result = db.insert(profiles).values({ name }).returning({ id: profiles.id }).get();
  return result.id;
}

/**
 * Update a profile name by ID. Returns true if a row was updated.
 */
export function updateProfile(id: number, name: string): boolean {
  const result = db.update(profiles).set({ name }).where(eq(profiles.id, id)).returning().all();
  return result.length > 0;
}

/**
 * Delete a profile by ID. Returns true if a row was deleted.
 */
export function deleteProfile(id: number): boolean {
  const result = db.delete(profiles).where(eq(profiles.id, id)).returning().all();
  return result.length > 0;
}

/**
 * Get raw lap data (with compressed telemetry blob) for zip export.
 */
export function getLapsRaw(ids?: number[]) {
  const base = db
    .select({
      id: laps.id,
      sessionId: laps.sessionId,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      pi: laps.pi,
      telemetry: laps.telemetry,
      createdAt: laps.createdAt,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      gameId: sessions.gameId,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id));

  if (ids && ids.length > 0) {
    return base.where(or(...ids.map((id) => eq(laps.id, id))) as any).all();
  }

  return base.all();
}
