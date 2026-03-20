import { eq, desc, and, sql, or, isNull } from "drizzle-orm";
import { db } from "./index";
import { sessions, laps, trackCorners, trackOutlines, lapAnalyses, profiles, tunes } from "./schema";
import type { TelemetryPacket, LapMeta, SessionMeta } from "../../shared/types";
import type { Corner } from "../corner-detection";

/**
 * Compress telemetry packets to a gzip'd JSON blob for storage.
 */
export function compressTelemetry(packets: TelemetryPacket[]): Buffer {
  const json = JSON.stringify(packets);
  const compressed = Bun.gzipSync(Buffer.from(json));
  return Buffer.from(compressed);
}

/**
 * Decompress a stored telemetry blob back to packet array.
 */
export function decompressTelemetry(blob: Buffer): TelemetryPacket[] {
  const decompressed = Bun.gunzipSync(blob);
  return JSON.parse(new TextDecoder().decode(decompressed));
}

/**
 * Insert a new session, returns the created session ID.
 */
export function insertSession(
  carOrdinal: number,
  trackOrdinal: number
): number {
  const result = db
    .insert(sessions)
    .values({ carOrdinal, trackOrdinal })
    .returning({ id: sessions.id })
    .get();
  return result.id;
}

/**
 * Insert a completed lap with compressed telemetry.
 */
export function insertLap(
  sessionId: number,
  lapNumber: number,
  lapTime: number,
  isValid: boolean,
  telemetryPackets: TelemetryPacket[],
  profileId: number | null = null,
  tuneId: number | null = null
): number {
  const compressed = compressTelemetry(telemetryPackets);
  const pi = telemetryPackets[0]?.CarPerformanceIndex ?? 0;
  const result = db
    .insert(laps)
    .values({
      sessionId,
      lapNumber,
      lapTime,
      isValid,
      pi,
      telemetry: compressed,
      profileId,
      tuneId,
    })
    .returning({ id: laps.id })
    .get();
  return result.id;
}

/**
 * Get all laps with session metadata, newest first.
 * Optionally filter by profileId.
 */
export function getLaps(profileId?: number | null): LapMeta[] {
  const query = db
    .select({
      id: laps.id,
      sessionId: laps.sessionId,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      pi: laps.pi,
      createdAt: laps.createdAt,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      tuneId: laps.tuneId,
      tuneName: tunes.name,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .orderBy(desc(laps.id));

  const rows = profileId != null
    ? query.where(or(eq(laps.profileId, profileId), isNull(laps.profileId))).all()
    : query.all();

  return rows.map((r) => ({
    ...r,
    isValid: Boolean(r.isValid),
    pi: r.pi ?? 0,
    tuneId: r.tuneId ?? undefined,
    tuneName: r.tuneName ?? undefined,
  }));
}

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
    telemetry: decompressTelemetry(row.telemetry as Buffer),
  };
}

/**
 * Delete a lap by ID. Returns true if a row was deleted.
 */
export function deleteLap(id: number): boolean {
  const result = db.delete(laps).where(eq(laps.id, id)).returning().all();
  return result.length > 0;
}

/**
 * Get all sessions with lap counts, newest first.
 */
export function getSessions(): SessionMeta[] {
  const rows = db
    .select({
      id: sessions.id,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      createdAt: sessions.createdAt,
    })
    .from(sessions)
    .orderBy(desc(sessions.id))
    .all();

  // Get lap counts per session
  return rows.map((session) => {
    const lapRows = db
      .select({ id: laps.id })
      .from(laps)
      .where(eq(laps.sessionId, session.id))
      .all();
    return {
      ...session,
      lapCount: lapRows.length,
    };
  });
}

/**
 * Get stored corner definitions for a track.
 * Returns empty array if none stored.
 */
export function getCorners(trackOrdinal: number): Corner[] {
  const rows = db
    .select({
      cornerIndex: trackCorners.cornerIndex,
      label: trackCorners.label,
      distanceStart: trackCorners.distanceStart,
      distanceEnd: trackCorners.distanceEnd,
    })
    .from(trackCorners)
    .where(eq(trackCorners.trackOrdinal, trackOrdinal))
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
  isAuto: boolean = false
): void {
  // Delete existing corners for this track
  db.delete(trackCorners)
    .where(eq(trackCorners.trackOrdinal, trackOrdinal))
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
  trackOrdinal: number
): { x: number; z: number; speed: number }[] | null {
  const row = db
    .select({ outline: trackOutlines.outline })
    .from(trackOutlines)
    .where(eq(trackOutlines.trackOrdinal, trackOrdinal))
    .get();

  if (!row) return null;
  const decompressed = Bun.gunzipSync(row.outline as Buffer);
  return JSON.parse(new TextDecoder().decode(decompressed));
}

/**
 * Save a track outline from pre-processed points array.
 * Compresses and stores. Replaces any existing outline.
 * Optionally stores auto-computed sectors.
 */
export function saveTrackOutline(
  trackOrdinal: number,
  points: { x: number; z: number; speed: number }[],
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
    .where(eq(trackOutlines.trackOrdinal, trackOrdinal))
    .get();

  if (existing) {
    db.update(trackOutlines)
      .set({ outline: compressed, sectors: sectorsJson })
      .where(eq(trackOutlines.trackOrdinal, trackOrdinal))
      .run();
  } else {
    db.insert(trackOutlines)
      .values({ trackOrdinal, outline: compressed, sectors: sectorsJson })
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
  packets: TelemetryPacket[]
): void {
  const points: { x: number; z: number; speed: number }[] = [];
  for (let i = 0; i < packets.length; i += 5) {
    const p = packets[i];
    if (p.PositionX === 0 && p.PositionZ === 0) continue;
    points.push({
      x: p.PositionX,
      z: p.PositionZ,
      speed: (p.Speed ?? 0) * 2.23694,
    });
  }
  saveTrackOutline(trackOrdinal, points);
}

/**
 * Get stored sectors for a track ordinal from the track_outlines table.
 * Returns {s1End, s2End} or null if not stored.
 */
export function getTrackOutlineSectors(
  trackOrdinal: number
): { s1End: number; s2End: number } | null {
  const row = db
    .select({ sectors: trackOutlines.sectors })
    .from(trackOutlines)
    .where(eq(trackOutlines.trackOrdinal, trackOrdinal))
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
  sectors: { s1End: number; s2End: number }
): boolean {
  const existing = db
    .select({ id: trackOutlines.id })
    .from(trackOutlines)
    .where(eq(trackOutlines.trackOrdinal, trackOrdinal))
    .get();

  if (!existing) return false;

  db.update(trackOutlines)
    .set({ sectors: JSON.stringify(sectors) })
    .where(eq(trackOutlines.trackOrdinal, trackOrdinal))
    .run();

  return true;
}

/**
 * Check if a recorded (DB) outline exists for a track ordinal.
 */
export function hasRecordedOutline(trackOrdinal: number): boolean {
  const row = db
    .select({ id: trackOutlines.id })
    .from(trackOutlines)
    .where(eq(trackOutlines.trackOrdinal, trackOrdinal))
    .get();
  return !!row;
}

/**
 * Get track outline metadata (createdAt timestamp) for a track ordinal.
 * Returns {createdAt} or null if no outline exists.
 */
export function getTrackOutlineMetadata(
  trackOrdinal: number
): { createdAt: string } | null {
  const row = db
    .select({ createdAt: trackOutlines.createdAt })
    .from(trackOutlines)
    .where(eq(trackOutlines.trackOrdinal, trackOrdinal))
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
