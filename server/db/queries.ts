import { eq, desc, and } from "drizzle-orm";
import { db } from "./index";
import { sessions, laps, trackCorners } from "./schema";
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
  telemetryPackets: TelemetryPacket[]
): number {
  const compressed = compressTelemetry(telemetryPackets);
  const result = db
    .insert(laps)
    .values({
      sessionId,
      lapNumber,
      lapTime,
      isValid,
      telemetry: compressed,
    })
    .returning({ id: laps.id })
    .get();
  return result.id;
}

/**
 * Get all laps with session metadata, newest first.
 */
export function getLaps(): LapMeta[] {
  const rows = db
    .select({
      id: laps.id,
      sessionId: laps.sessionId,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      createdAt: laps.createdAt,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .orderBy(desc(laps.id))
    .all();

  return rows.map((r) => ({
    ...r,
    isValid: Boolean(r.isValid),
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
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
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
