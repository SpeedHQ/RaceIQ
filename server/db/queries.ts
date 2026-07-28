import { eq, desc, and, or, sql, inArray, notInArray, isNull } from "drizzle-orm";
import { db } from "./index";
import { sessions, laps, trackCorners, trackOutlines, lapAnalyses, compareAnalyses, profiles, tunes, lineSpreadCache } from "./schema";
import type { TelemetryPacket, LapMeta, SessionMeta, GameId } from "../../shared/types";
import type { Corner } from "../corner-detection";
import { fillNormSuspension } from "../telemetry-utils";
import { getServerGame } from "../games/registry";
import { getActiveExperiment } from "../experiment-active";
import { resolveActiveTestId } from "./experiment-version-queries";
import { tryGetGame } from "../../shared/games/registry";
import { gunzip } from "zlib";
import { promisify } from "util";
import { existsSync, unlinkSync } from "fs";
import { getTrackLengthMeters } from "../../shared/track-data";
import type { RecapLapInput, RecapSessionInput } from "../recap";

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
  sessionType?: string,
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

export async function updateLapValidity(id: number, isValid: boolean, invalidReason: string | null, sectors?: number[] | null): Promise<void> {
  const values: Record<string, unknown> = { isValid, invalidReason };
  if (sectors !== undefined) {
    values.sectorTimes = sectors;
  }
  await db.update(laps).set(values).where(eq(laps.id, id)).run();
}

/**
 * Flip a lap's `experimentExcluded` flag (Setup Engineer `set_lap_excluded` tool,
 * docs/setup-engineer-flow-design.md §Phase 3, and the `/api/laps/:id/experiment-excluded`
 * REST route, §Phase 7). Returns the PRIOR value plus the lap's `experimentId`
 * so the caller can log an inverse via `recordAction` for undo.
 *
 * Stamps `experimentExcludedSource = 'manual'` in BOTH directions (excluding and
 * un-excluding) — docs/superpowers/specs/2026-07-24-experiment-auto-exclude-design.md.
 * This pins the lap against the auto-exclude reconciliation pass
 * (server/experiment-auto-exclude.ts) so a user's un-exclude click sticks instead of
 * the fastest-5 rule silently re-excluding it on the next lap save.
 */
export async function setLapExperimentExcluded(
  lapId: number,
  excluded: boolean,
): Promise<{ ok: boolean; prev: boolean; experimentId: number | null }> {
  const row = await db
    .select({ experimentExcluded: laps.experimentExcluded, experimentId: laps.experimentId })
    .from(laps)
    .where(eq(laps.id, lapId))
    .get();
  if (!row) return { ok: false, prev: false, experimentId: null };
  const prev = Boolean(row.experimentExcluded);
  await db
    .update(laps)
    .set({ experimentExcluded: excluded ? 1 : null, experimentExcludedSource: "manual" })
    .where(eq(laps.id, lapId))
    .run();
  return { ok: true, prev, experimentId: row.experimentId };
}

/**
 * Read the scope laps `reconcileAutoExclusions` (server/experiment-auto-exclude.ts)
 * ranks over: every lap sharing `(experiment_id, tune_id)`, with just the
 * columns the fastest-5 rule needs.
 */
export async function getLapsForExclusionScope(
  experimentId: number,
  tuneId: number,
): Promise<
  { id: number; lapTime: number; isValid: boolean; invalidReason: string | null; experimentExcluded: boolean; experimentExcludedSource: "auto" | "manual" | null }[]
> {
  const rows = await db
    .select({
      id: laps.id,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      invalidReason: laps.invalidReason,
      experimentExcluded: laps.experimentExcluded,
      experimentExcludedSource: laps.experimentExcludedSource,
    })
    .from(laps)
    .where(and(eq(laps.experimentId, experimentId), eq(laps.tuneId, tuneId)))
    .all();
  return rows.map((r) => ({
    id: r.id,
    lapTime: r.lapTime,
    isValid: Boolean(r.isValid),
    invalidReason: r.invalidReason,
    experimentExcluded: Boolean(r.experimentExcluded),
    experimentExcludedSource: (r.experimentExcludedSource as "auto" | "manual" | null) ?? null,
  }));
}

/**
 * Write an auto-pass exclusion decision for a lap. Always stamps
 * `experimentExcludedSource = 'auto'` — manual decisions never go through this
 * path (see `setLapExperimentExcluded`).
 */
export async function setLapAutoExclusion(lapId: number, excluded: boolean): Promise<void> {
  await db
    .update(laps)
    .set({ experimentExcluded: excluded ? 1 : null, experimentExcludedSource: "auto" })
    .where(eq(laps.id, lapId))
    .run();
}

/**
 * Read back the `(experiment_id, tune_id)` scope key a just-inserted lap
 * was stamped with, so the caller can decide whether to run
 * `reconcileAutoExclusions` (skipped when either is null — see
 * docs/superpowers/specs/2026-07-24-experiment-auto-exclude-design.md §Trigger).
 */
export async function getLapExperimentScope(
  lapId: number,
): Promise<{ experimentId: number | null; tuneId: number | null }> {
  const row = await db
    .select({ experimentId: laps.experimentId, tuneId: laps.tuneId })
    .from(laps)
    .where(eq(laps.id, lapId))
    .get();
  return { experimentId: row?.experimentId ?? null, tuneId: row?.tuneId ?? null };
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
  sectors: number[] | null = null
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
  sectors: number[] | null = null
): Promise<number> {
  // Stamp the lap with the active tuning session (if any). This is the single
  // choke point every live lap-detector funnels through (via the DbAdapter), so
  // reading the in-memory active id here links laps to a tuning session
  // independent of race sessionId — a tuning session can span many race
  // sessions. Cheap, unconditional on game; null when no session is active.
  const activeExperimentId = getActiveExperiment();
  const activeExperimentVersionId =
    activeExperimentId != null ? await resolveActiveTestId(activeExperimentId) : null;
  const result = await db
    .insert(laps)
    .values({
      sessionId,
      lapNumber,
      lapTime,
      isValid,
      rawByteOffset,
      rawFrameCount,
      sectorTimes: sectors,
      profileId,
      tuneId,
      invalidReason,
      experimentId: activeExperimentId,
      experimentVersionId: activeExperimentVersionId,
    })
    .returning({ id: laps.id })
    .get();
  return result.id;
}

/**
 * Backfill car/track ordinals on a session that was created before shared
 * memory static data was populated (e.g. first frames of an imported .bin
 * capture where the recorder attached before the game wrote static state).
 */
/**
 * Persist the derived per-lap metrics (migration v32) onto the lap row so the
 * next read is a plain column fetch instead of decoding every telemetry frame.
 * Null args are stored as-is (a lap with telemetry but no usable fuel/tyre
 * channel stays null and simply isn't recomputed unless its telemetry changes).
 */
export async function setLapMetrics(lapId: number, fuelPerLap: number | null, tyreWear: number | null): Promise<void> {
  await db.update(laps).set({ fuelPerLap, tyreWear }).where(eq(laps.id, lapId)).run();
}

export async function updateSessionCarTrack(sessionId: number, carOrdinal: number, trackOrdinal: number): Promise<void> {
  await db.update(sessions).set({ carOrdinal, trackOrdinal }).where(eq(sessions.id, sessionId)).run();
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
      sectorTimes: laps.sectorTimes,
      experimentId: laps.experimentId,
      experimentVersionId: laps.experimentVersionId,
      experimentExcluded: laps.experimentExcluded,
      experimentExcludedSource: laps.experimentExcludedSource,
      fuelPerLap: laps.fuelPerLap,
      tyreWear: laps.tyreWear,
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
    sectorTimes: r.sectorTimes ?? undefined,
    experimentId: r.experimentId ?? null,
    experimentVersionId: r.experimentVersionId ?? null,
    experimentExcluded: Boolean(r.experimentExcluded),
    // Selector (shared/review-laps.ts) only treats a lap as manually excluded
    // when the source is "manual" — must travel with the flag or the client
    // re-ranks the excluded lap into the fastest-N.
    experimentExcludedSource: (r.experimentExcludedSource as "auto" | "manual" | null) ?? null,
    fuelPerLap: r.fuelPerLap ?? null,
    tyreWear: r.tyreWear ?? null,
  }));
}

/**
 * Laps explicitly linked to a tuning session (migration v25), newest-first.
 * Joined to sessions for car/track/game exactly like getLaps. This is the
 * authoritative membership query — it replaces the old created-at time-window
 * heuristic, so a tuning session correctly gathers its laps across ANY number
 * of race sessions (multiple stints) and never over-includes unrelated laps.
 *
 * Laps recorded before v25 (or while no tuning session was active) have
 * experiment_id = NULL and are therefore excluded — the link is opt-in
 * going forward.
 */
export async function getLapsForExperiment(experimentId: number): Promise<LapMeta[]> {
  const rows = await db
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
      sectorTimes: laps.sectorTimes,
      experimentId: laps.experimentId,
      experimentVersionId: laps.experimentVersionId,
      experimentExcluded: laps.experimentExcluded,
      experimentExcludedSource: laps.experimentExcludedSource,
      fuelPerLap: laps.fuelPerLap,
      tyreWear: laps.tyreWear,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .where(eq(laps.experimentId, experimentId))
    .orderBy(desc(laps.id))
    .all();

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
    sectorTimes: r.sectorTimes ?? undefined,
    experimentId: r.experimentId ?? null,
    experimentVersionId: r.experimentVersionId ?? null,
    experimentExcluded: Boolean(r.experimentExcluded),
    // Selector (shared/review-laps.ts) only treats a lap as manually excluded
    // when the source is "manual" — must travel with the flag or the client
    // re-ranks the excluded lap into the fastest-N.
    experimentExcludedSource: (r.experimentExcludedSource as "auto" | "manual" | null) ?? null,
    fuelPerLap: r.fuelPerLap ?? null,
    tyreWear: r.tyreWear ?? null,
  }));
}

/**
 * Laps explicitly stamped to one tuning TEST (setup version) — the current
 * run's pool (migration v29). Same shape as getLapsForExperiment but scoped
 * to a single branch node so the clean-lap aggregate reflects exactly the laps
 * driven on that setup. Newest-first.
 */
export async function getLapMetaForExperimentVersion(experimentVersionId: number): Promise<LapMeta[]> {
  const rows = await db
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
      sectorTimes: laps.sectorTimes,
      experimentId: laps.experimentId,
      experimentVersionId: laps.experimentVersionId,
      experimentExcluded: laps.experimentExcluded,
      experimentExcludedSource: laps.experimentExcludedSource,
      fuelPerLap: laps.fuelPerLap,
      tyreWear: laps.tyreWear,
      // Frame count only — never the frames. Lets the arm-comparison loader size
      // its decode budget from metadata (server/ai/arm-stream.ts).
      rawFrameCount: laps.rawFrameCount,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .where(eq(laps.experimentVersionId, experimentVersionId))
    .orderBy(desc(laps.id))
    .all();

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
    sectorTimes: r.sectorTimes ?? undefined,
    experimentId: r.experimentId ?? null,
    experimentVersionId: r.experimentVersionId ?? null,
    experimentExcluded: Boolean(r.experimentExcluded),
    // Selector (shared/review-laps.ts) only treats a lap as manually excluded
    // when the source is "manual" — must travel with the flag or the client
    // re-ranks the excluded lap into the fastest-N.
    experimentExcludedSource: (r.experimentExcludedSource as "auto" | "manual" | null) ?? null,
    fuelPerLap: r.fuelPerLap ?? null,
    tyreWear: r.tyreWear ?? null,
    rawFrameCount: r.rawFrameCount ?? null,
  }));
}

/**
 * Candidate laps for "Add laps from history" (Phase 6, docs/setup-engineer-flow-design.md
 * §Phase 6): laps matching this tuning session's game + car + track that aren't
 * already stamped to ANY tuning session. Ordinal-only match — a name-seeded
 * session already resolves `trackOrdinal` from `trackName` at creation
 * (createExperiment), so by the time this query runs that fallback is
 * already baked into the ordinal; `carOrdinal`/`trackOrdinal` left null on the
 * session (never resolved) are treated as "match any" for that dimension
 * rather than excluding everything. Newest-first, same shape as getLapsForExperiment.
 */
export async function getImportableLapsForExperiment(
  gameId: GameId,
  carOrdinal: number | null,
  trackOrdinal: number | null,
): Promise<LapMeta[]> {
  const conds = [eq(sessions.gameId, gameId), isNull(laps.experimentId)];
  if (carOrdinal != null) conds.push(eq(sessions.carOrdinal, carOrdinal));
  if (trackOrdinal != null) conds.push(eq(sessions.trackOrdinal, trackOrdinal));

  const rows = await db
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
      sectorTimes: laps.sectorTimes,
      experimentId: laps.experimentId,
      experimentVersionId: laps.experimentVersionId,
      experimentExcluded: laps.experimentExcluded,
      experimentExcludedSource: laps.experimentExcludedSource,
      fuelPerLap: laps.fuelPerLap,
      tyreWear: laps.tyreWear,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .where(and(...conds))
    .orderBy(desc(laps.id))
    .all();

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
    sectorTimes: r.sectorTimes ?? undefined,
    experimentId: r.experimentId ?? null,
    experimentVersionId: r.experimentVersionId ?? null,
    experimentExcluded: Boolean(r.experimentExcluded),
    // Selector (shared/review-laps.ts) only treats a lap as manually excluded
    // when the source is "manual" — must travel with the flag or the client
    // re-ranks the excluded lap into the fastest-N.
    experimentExcludedSource: (r.experimentExcludedSource as "auto" | "manual" | null) ?? null,
    fuelPerLap: r.fuelPerLap ?? null,
    tyreWear: r.tyreWear ?? null,
  }));
}

/**
 * Stamp a batch of laps onto a tuning session (and optional test/branch) —
 * "Add laps from history" attach step. Only laps that are currently unstamped
 * (`experimentId IS NULL`) are touched, so a lapIds list stale from a
 * concurrent import can't steal laps from another session. Returns the ids
 * actually updated.
 */
export async function importLapsToExperiment(
  experimentId: number,
  lapIds: number[],
  experimentVersionId: number | null,
): Promise<number[]> {
  if (lapIds.length === 0) return [];
  const result = await db
    .update(laps)
    .set({ experimentId, experimentVersionId })
    .where(and(inArray(laps.id, lapIds), isNull(laps.experimentId)))
    .returning({ id: laps.id })
    .all();
  return result.map((r) => r.id);
}

/**
 * Undo inverse for `importLapsToExperiment` (Phase 9): clear
 * `experimentId`/`experimentVersionId` on exactly the lap ids the import stamped,
 * returning them to the unstamped/importable pool. No existence guard needed
 * beyond the id list itself — these are always ids `recordAction` captured
 * from the import's own return value.
 */
export async function unstampLapsFromExperiment(lapIds: number[]): Promise<void> {
  if (lapIds.length === 0) return;
  await db
    .update(laps)
    .set({ experimentId: null, experimentVersionId: null })
    .where(inArray(laps.id, lapIds))
    .run();
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
  sectorTimes: number[] | null;
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
      sectorTimes: laps.sectorTimes,
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
      sectorTimes: r.sectorTimes ?? null,
      isValid: Boolean(r.isValid),
      invalidReason: r.invalidReason ?? null,
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

// Decompressed session-file buffer cache. Every lap fetch used to re-read AND
// re-gunzip the whole session raw file; a stint of N laps then paid N full
// reads + N full decompressions of the SAME file (the slow, one-lap-at-a-time
// load). Caching the decompressed buffer per path — invalidated by size+mtime
// so a live-growing session file stays correct — makes N laps share one
// read+decompress. Buffers are only ever read (subarray views), never mutated.
interface RawFileEntry {
  size: number;
  mtimeMs: number;
  buf: Buffer;
}
const rawFileCache = new Map<string, RawFileEntry>();
const RAW_FILE_CACHE_MAX = 2;

async function loadDecompressedRawFile(rawFile: string): Promise<Buffer> {
  const file = Bun.file(rawFile);
  const size = file.size;
  const mtimeMs = file.lastModified;
  const hit = rawFileCache.get(rawFile);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) {
    rawFileCache.delete(rawFile); // refresh LRU order
    rawFileCache.set(rawFile, hit);
    return hit.buf;
  }
  let buf = Buffer.from(await file.arrayBuffer());
  if (rawFile.endsWith(".gz")) buf = await gunzipAsync(buf);
  rawFileCache.set(rawFile, { size, mtimeMs, buf });
  while (rawFileCache.size > RAW_FILE_CACHE_MAX) {
    const oldest = rawFileCache.keys().next().value;
    if (oldest === undefined) break;
    rawFileCache.delete(oldest);
  }
  return buf;
}

async function parseRawLapFrames(
  rawFile: string,
  rawByteOffset: number,
  rawFrameCount: number,
  gameId: GameId
): Promise<TelemetryPacket[]> {
  const serverGame = getServerGame(gameId);
  const state = serverGame.createParserState?.() ?? null;

  const buf = await loadDecompressedRawFile(rawFile);

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
        // Some native detectors already store the exact outgoing frame range,
        // so their next-lap timing frame must not be appended here.
        if (
          serverGame.appendsDelayedFinishFrame &&
          last &&
          finishTime > (last.CurrentLap ?? 0)
        ) {
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

/** Test-only export so integration tests can drive the batch decoder directly. */
export const parseSessionLapsBatchedForTest = parseSessionLapsBatched;

/**
 * Decode several laps of the SAME session in a single forward pass over the raw
 * file. `parseRawLapFrames` re-warms the parser state from the start of the file
 * on every call, so cold-loading N laps of a stint costs O(N²) frame parses
 * (the last lap replays every earlier lap). This walks the file once: one
 * warm-up, one parser state, each frame parsed exactly once, sliced back into
 * per-lap packet arrays. Output is byte-identical to N separate
 * parseRawLapFrames calls because the parser is deterministic given the frame
 * prefix from file start.
 *
 * Returns a Map keyed by lap id for laps it resolved. Laps whose stored offset
 * can't be located in the frame stream are omitted — the caller falls back to
 * the per-lap path for those.
 */
async function parseSessionLapsBatched(
  rawFile: string,
  lapMetas: { id: number; rawByteOffset: number; rawFrameCount: number }[],
  gameId: GameId
): Promise<Map<number, TelemetryPacket[]>> {
  const out = new Map<number, TelemetryPacket[]>();
  if (lapMetas.length === 0) return out;

  const serverGame = getServerGame(gameId);
  const state = serverGame.createParserState?.() ?? null;
  const buf = await loadDecompressedRawFile(rawFile);

  const metas = [...lapMetas].sort((a, b) => a.rawByteOffset - b.rawByteOffset);
  const firstOffset = metas[0].rawByteOffset;
  if (firstOffset >= buf.length) return out; // all past EOF — fall back per-lap

  // Warm up the parser state by replaying frames from the start of the file up
  // to the first requested lap (start at 12 to skip the meta frame). Same
  // best-effort replay parseRawLapFrames does, done ONCE for the whole batch.
  let offset = 12;
  while (offset < firstOffset && offset + 4 <= buf.length) {
    const wLen = buf.readUInt32LE(offset);
    if (wLen <= 0 || offset + 4 + wLen > buf.length) break;
    const wBuf = buf.subarray(offset + 4, offset + 4 + wLen);
    offset += 4 + wLen;
    try { serverGame.tryParse(wBuf, state); } catch { /* warmup best-effort */ }
  }

  // Boundary walk from the first lap to EOF: record each frame's start offset so
  // stored lap offsets map to frame indices. No parsing here — just length
  // headers, so this is cheap even for a long session file.
  const frameStarts: number[] = [];
  const offsetToIdx = new Map<number, number>();
  let cursor = firstOffset;
  while (cursor + 4 <= buf.length) {
    const len = buf.readUInt32LE(cursor);
    if (len <= 0 || cursor + 4 + len > buf.length) break;
    offsetToIdx.set(cursor, frameStarts.length);
    frameStarts.push(cursor);
    cursor += 4 + len;
  }

  // Resolve each lap to a frame index range; the last lap bounds how far we parse.
  const resolved: { id: number; startIdx: number; frameCount: number }[] = [];
  let maxIdx = -1;
  for (const meta of metas) {
    const startIdx = offsetToIdx.get(meta.rawByteOffset);
    if (startIdx === undefined) continue; // unaligned — caller falls back
    resolved.push({ id: meta.id, startIdx, frameCount: meta.rawFrameCount });
    // +1 for the trailing finish frame (see parseRawLapFrames' readCount).
    maxIdx = Math.max(maxIdx, startIdx + meta.rawFrameCount);
  }
  if (resolved.length === 0) return out;

  // Parse frames [0 .. maxIdx] once each, applying the same normalization as
  // parseRawLapFrames. `parsed[i]` is null when tryParse returns nothing (e.g. a
  // stateful accumulator still assembling a packet).
  const lastFrame = Math.min(maxIdx, frameStarts.length - 1);
  const parsed: (TelemetryPacket | null)[] = new Array(lastFrame + 1).fill(null);
  for (let i = 0; i <= lastFrame; i++) {
    const start = frameStarts[i];
    const len = buf.readUInt32LE(start);
    const frameBuf = buf.subarray(start + 4, start + 4 + len);
    try {
      const packet = serverGame.tryParse(frameBuf, state);
      if (!packet) continue;
      const sharedAdapter = tryGetGame(packet.gameId);
      if (sharedAdapter?.coordSystem === "standard-xyz") {
        packet.PositionX = -packet.PositionX;
        packet.VelocityX = -packet.VelocityX;
        packet.AccelerationX = -packet.AccelerationX;
      }
      fillNormSuspension(packet);
      parsed[i] = packet;
    } catch { /* single bad frame — skip, matches per-lap tolerance */ }
  }

  // Slice per lap: its packets are the non-null parses among its rawFrameCount
  // frames, plus the synthesized finish packet from the trailing frame.
  for (const lap of resolved) {
    const end = lap.startIdx + lap.frameCount; // exclusive; index of trailing frame
    const packets: TelemetryPacket[] = [];
    for (let i = lap.startIdx; i < end && i < parsed.length; i++) {
      const p = parsed[i];
      if (p) packets.push(p);
    }
    // Trailing frame = next-lap trigger; synthesize a finish packet (same logic
    // as parseRawLapFrames' extra-frame branch).
    const trailing = parsed[end];
    const last = packets[packets.length - 1];
    if (serverGame.appendsDelayedFinishFrame && trailing && last) {
      const finishTime = trailing.LastLap ?? 0;
      if (finishTime > (last.CurrentLap ?? 0)) {
        packets.push({
          ...trailing,
          CurrentLap: finishTime,
          LapNumber: last.LapNumber,
          DistanceTraveled: Math.max(trailing.DistanceTraveled, last.DistanceTraveled),
        });
      }
    }
    if (packets.length > 0) out.set(lap.id, packets);
  }

  return out;
}

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
      sectorTimes: laps.sectorTimes,
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
  row: { id: number; sessionId: number; lapNumber: number; lapTime: number; isValid: number | boolean; createdAt: string; carOrdinal: number; trackOrdinal: number; tuneId: number | null; tuneName: string | null; gameId: string; carSetup: string | null; sectorTimes: number[] | null; rawFile?: string | null },
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
    sectorTimes: row.sectorTimes ?? undefined,
    telemetry,
  };
}


/**
 * Load several laps' telemetry at once, decoding each session's laps in a single
 * forward pass (parseSessionLapsBatched) instead of one re-warming parse per lap.
 * Serves telemetryCache hits directly and populates the cache for every lap it
 * decodes — so callers that later re-request a lap individually (e.g. the client
 * /api/laps/:id fetches) hit warm cache. Returns results in the requested id
 * order. Laps the batch pass can't resolve fall back to getLapById.
 */
export async function getLapsByIds(
  ids: number[]
): Promise<(LapMeta & { telemetry: TelemetryPacket[]; parseError?: string })[]> {
  if (ids.length === 0) return [];

  const rows = await db
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
      sectorTimes: laps.sectorTimes,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .where(inArray(laps.id, ids))
    .all();

  const rowById = new Map(rows.map((r) => [r.id, r]));

  // Group cache-miss laps by session raw file so each session decodes once.
  type BatchMeta = { id: number; rawByteOffset: number; rawFrameCount: number };
  const bySession = new Map<string, { gameId: GameId; metas: BatchMeta[] }>();
  const decoded = new Map<number, TelemetryPacket[]>();

  for (const row of rows) {
    const cached = cacheGet(row.id);
    if (cached) {
      decoded.set(row.id, cached);
      continue;
    }
    if (row.rawByteOffset != null && row.rawFrameCount && row.rawFile) {
      let group = bySession.get(row.rawFile);
      if (!group) {
        group = { gameId: row.gameId as GameId, metas: [] };
        bySession.set(row.rawFile, group);
      }
      group.metas.push({ id: row.id, rawByteOffset: row.rawByteOffset, rawFrameCount: row.rawFrameCount });
    }
  }

  for (const [rawFile, group] of bySession) {
    try {
      const batch = await parseSessionLapsBatched(rawFile, group.metas, group.gameId);
      for (const [lapId, telemetry] of batch) {
        cacheSet(lapId, telemetry);
        decoded.set(lapId, telemetry);
      }
    } catch (err) {
      console.error(`[DB] Batch decode failed for ${rawFile}, falling back per-lap:`, err);
    }
  }

  // Assemble in requested order; fall back to getLapById for anything the batch
  // pass didn't resolve (unaligned offset, batch error, or a bad lap).
  const results: (LapMeta & { telemetry: TelemetryPacket[]; parseError?: string })[] = [];
  for (const id of ids) {
    const row = rowById.get(id);
    if (!row) continue;
    const telemetry = decoded.get(id);
    if (telemetry) {
      results.push(buildLapResult(row, telemetry));
    } else {
      const lap = await getLapById(id);
      if (lap) results.push(lap);
    }
  }
  return results;
}

// Bump when computeLineSpreadTrace's output changes so old cached traces are
// treated as a miss (the version is baked into the lap-set key).
const LINE_SPREAD_ALGO_VERSION = 1;

/** Deterministic cache key for a tuning session's clean-lap set. */
export function lineSpreadLapSetHash(lapIds: number[]): string {
  const sorted = [...lapIds].sort((a, b) => a - b);
  return `v${LINE_SPREAD_ALGO_VERSION}:${sorted.join(",")}`;
}

/** Read a cached line-spread trace JSON, or null on miss. */
export async function getLineSpreadCache(experimentId: number, lapSetHash: string): Promise<string | null> {
  const row = await db
    .select({ trace: lineSpreadCache.trace })
    .from(lineSpreadCache)
    .where(and(eq(lineSpreadCache.experimentId, experimentId), eq(lineSpreadCache.lapSetHash, lapSetHash)))
    .get();
  return row?.trace ?? null;
}

/** Store a computed line-spread trace JSON (upsert on the composite key). */
export async function setLineSpreadCache(experimentId: number, lapSetHash: string, trace: string): Promise<void> {
  await db
    .insert(lineSpreadCache)
    .values({ experimentId, lapSetHash, trace })
    .onConflictDoUpdate({
      target: [lineSpreadCache.experimentId, lineSpreadCache.lapSetHash],
      set: { trace, createdAt: sql`(datetime('now'))` },
    })
    .run();
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
  sectorTimes: number[] | null;
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
      sectorTimes: laps.sectorTimes,
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
  invalidReason: string | null,
  sectors: number[] | null
): Promise<void> {
  cacheDelete(lapId);
  await db.update(laps).set({
    rawByteOffset,
    rawFrameCount,
    lapTime,
    isValid,
    invalidReason,
    sectorTimes: sectors,
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
  sectors: number[] | null
): Promise<number> {
  const result = await db.insert(laps).values({
    sessionId, lapNumber, lapTime, isValid,
    rawByteOffset, rawFrameCount,
    tuneId, notes, invalidReason,
    sectorTimes: sectors,
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
 * Fetch-only data needed for a session recap: the session row, its laps, the
 * track's length (metres, null when no outline), and the best valid lap time
 * for the same track + car + game from every OTHER session. No math here —
 * see server/recap.ts::computeRecap for the rules.
 *
 * Returns null when the session doesn't exist or its gameId doesn't match.
 */
export async function getSessionRecapData(
  id: number,
  gameId: GameId,
): Promise<{
  session: RecapSessionInput;
  laps: RecapLapInput[];
  trackLengthM: number | null;
  allTimeBestSec: number | null;
  allTimeBestSectors: Array<number | null> | null;
  sectorStarts: number[] | null;
} | null> {
  const sessionRow = await db
    .select({
      id: sessions.id,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      gameId: sessions.gameId,
      createdAt: sessions.createdAt,
    })
    .from(sessions)
    .where(eq(sessions.id, id))
    .get();

  if (!sessionRow || sessionRow.gameId !== gameId) return null;

  const lapRows = await db
    .select({
      id: laps.id,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      sectorTimes: laps.sectorTimes,
    })
    .from(laps)
    .where(eq(laps.sessionId, id))
    .orderBy(laps.lapNumber)
    .all();

  const trackLengthM = getTrackLengthMeters(sessionRow.trackOrdinal, gameId);
  const sessionSectorCount =
    lapRows.find(
      (lap) =>
        Boolean(lap.isValid) &&
        lap.sectorTimes != null &&
        lap.sectorTimes.length >= 2 &&
        lap.sectorTimes.every((time) => time > 0),
    )?.sectorTimes?.length ?? 0;

  let sectorStarts: number[] | null = null;
  const gameAdapter = tryGetGame(gameId);
  if (gameAdapter?.nativeSectors && gameAdapter.getNativeSectorLayout && sessionSectorCount >= 2) {
    for (const row of lapRows) {
      if (row.sectorTimes?.length !== sessionSectorCount) continue;
      const lap = await getLapById(row.id);
      const layout = lap?.telemetry
        .map((packet) => gameAdapter.getNativeSectorLayout!(packet))
        .find((candidate) => candidate?.starts.length === sessionSectorCount);
      if (layout) {
        sectorStarts = [...layout.starts];
        break;
      }
    }
  }

  const bestOtherRow = await db
    .select({ lapTime: laps.lapTime })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .where(
      and(
        eq(sessions.trackOrdinal, sessionRow.trackOrdinal),
        eq(sessions.carOrdinal, sessionRow.carOrdinal),
        eq(sessions.gameId, gameId),
        sql`${sessions.id} != ${id}`,
        eq(laps.isValid, true),
        sql`${laps.lapTime} > 0`,
      ),
    )
    .orderBy(laps.lapTime)
    .limit(1)
    .get();

  const otherSectorRows = await db
    .select({ sectorTimes: laps.sectorTimes })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .where(
      and(
        eq(sessions.trackOrdinal, sessionRow.trackOrdinal),
        eq(sessions.carOrdinal, sessionRow.carOrdinal),
        eq(sessions.gameId, gameId),
        sql`${sessions.id} != ${id}`,
        eq(laps.isValid, true),
        sql`${laps.lapTime} > 0`,
        sql`${laps.sectorTimes} IS NOT NULL`,
      ),
    )
    .all();
  const allTimeBestSectors = otherSectorRows.reduce<Array<number | null>>(
    (best, row) => {
      if (row.sectorTimes?.length !== sessionSectorCount) return best;
      for (let index = 0; index < (row.sectorTimes?.length ?? 0); index++) {
        const time = row.sectorTimes![index];
        if (time > 0 && (best[index] === undefined || best[index] === null || time < best[index]!)) {
          best[index] = time;
        }
      }
      return best;
    },
    [],
  );

  return {
    session: {
      id: sessionRow.id,
      carOrdinal: sessionRow.carOrdinal,
      trackOrdinal: sessionRow.trackOrdinal,
      gameId: sessionRow.gameId as GameId,
      createdAt: sessionRow.createdAt,
    },
    laps: lapRows.map((l) => ({ ...l, isValid: Boolean(l.isValid) })),
    trackLengthM,
    allTimeBestSec: bestOtherRow?.lapTime ?? null,
    allTimeBestSectors:
      allTimeBestSectors.length > 0 ? allTimeBestSectors : null,
    sectorStarts,
  };
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
